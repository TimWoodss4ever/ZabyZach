-- Customer delivery estimates and delivery order details.
-- Apply after the shared MRP/planning hardening and customer availability migrations.
begin;
select pg_advisory_xact_lock(1179468369,220001);
do $$begin
 if to_regprocedure('public.erp_checkout_order(uuid,jsonb)') is null
   or to_regprocedure('public.erp_create_pickup_order(uuid,jsonb)') is null
   or not exists(select 1 from information_schema.columns where table_schema='public' and table_name='sales_orders' and column_name='erp_quote_total') then
  raise exception 'Install the existing numbered-order and MRP planning migrations before this delivery update';
 end if;
end $$;

alter table public.sales_orders
 add column if not exists erp_fulfillment_type text not null default 'pickup',
 add column if not exists erp_delivery_address text,
 add column if not exists erp_delivery_fee numeric(14,2) not null default 0,
 add column if not exists erp_delivery_one_way_minutes integer,
 add column if not exists erp_delivery_distance_miles numeric(10,1),
 add column if not exists erp_delivery_eta_min integer,
 add column if not exists erp_delivery_eta_max integer;

do $$begin
 if not exists(select 1 from pg_constraint where conrelid='public.sales_orders'::regclass and conname='sales_orders_delivery_details_check') then
  alter table public.sales_orders add constraint sales_orders_delivery_details_check check (
   (erp_fulfillment_type='pickup' and erp_delivery_address is null and erp_delivery_fee=0)
   or
   (erp_fulfillment_type='delivery' and length(trim(coalesce(erp_delivery_address,''))) between 8 and 240
    and erp_delivery_fee>=0 and erp_delivery_one_way_minutes between 1 and 20
    and erp_delivery_distance_miles>0 and erp_delivery_eta_min>=erp_delivery_one_way_minutes
    and erp_delivery_eta_max>=erp_delivery_eta_min)
  );
 end if;
end $$;

create or replace function public.erp_customer_delivery_load(p_location_name text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare loc uuid;pending integer;
begin
 if auth.uid() is null or public.current_role() is distinct from 'Customer' then
  raise exception 'Customer sign-in required' using errcode='42501';
 end if;
 select id into loc from public.locations where name=p_location_name and can_sell;
 if loc is null then raise exception 'Choose an available store';end if;
 select count(*)::integer into pending from public.sales_orders
  where location_id=loc and status='Order Placed' and erp_prepared_at is null;
 return jsonb_build_object('pendingOrders',coalesce(pending,0));
end $$;

create or replace function public.erp_checkout_delivery_order(p_request uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare answer jsonb;address text;one_way integer;eta_min integer;eta_max integer;fee numeric;distance_miles numeric;
 existing_fee numeric;existing_type text;new_total numeric;
begin
 if auth.uid() is null or public.current_role() is distinct from 'Customer' then
  raise exception 'Customer role required' using errcode='42501';
 end if;
 if p_request is null or p_payload is null then raise exception 'Request and delivery details are required';end if;
 address:=trim(coalesce(p_payload->>'deliveryAddress',''));
 one_way:=(p_payload->>'oneWayMinutes')::integer;
 eta_min:=(p_payload->>'etaMin')::integer;
 eta_max:=(p_payload->>'etaMax')::integer;
 distance_miles:=(p_payload->>'distanceMiles')::numeric;
 fee:=(p_payload->>'deliveryFee')::numeric;
 if length(address) not between 8 and 240 then raise exception 'Enter a complete delivery address';end if;
 if one_way not between 1 and 20 then raise exception 'That address is outside the 20-minute delivery area';end if;
 if eta_min<one_way or eta_max<eta_min or eta_max>360 then raise exception 'Refresh the delivery estimate before placing this order';end if;
 if distance_miles<=0 or distance_miles>100 then raise exception 'Refresh the delivery estimate before placing this order';end if;
 if fee is distinct from round((one_way*2)*0.50,2) then raise exception 'Refresh the delivery fee before placing this order';end if;

 -- The existing order procedure validates and freezes the menu quote and lines.
 -- The full payload hash also binds the delivery address and estimate to retries.
 perform pg_advisory_xact_lock(hashtextextended(p_request::text,0));
 answer:=public.erp_checkout_order(p_request,p_payload);
 select erp_delivery_fee,erp_fulfillment_type into existing_fee,existing_type from public.sales_orders where id=p_request and created_by=auth.uid() for update;
 if not found then raise exception 'The saved order could not be found';end if;
 if existing_type='pickup' then
  update public.sales_orders set erp_fulfillment_type='delivery',erp_delivery_address=address,
   erp_delivery_fee=fee,erp_delivery_one_way_minutes=one_way,erp_delivery_distance_miles=distance_miles,
   erp_delivery_eta_min=eta_min,erp_delivery_eta_max=eta_max,
   erp_quote_total=coalesce(erp_quote_total,0)+fee
   where id=p_request and created_by=auth.uid();
  new_total:=coalesce((answer->>'total')::numeric,0)+fee;
 else
  if existing_fee<>fee then raise exception 'The saved delivery quote does not match this request';end if;
  new_total:=coalesce((answer->>'total')::numeric,0);
 end if;
 return answer||jsonb_build_object('total',new_total,'fulfillmentType','delivery','deliveryAddress',address,
  'deliveryFee',fee,'oneWayMinutes',one_way,'distanceMiles',distance_miles,'etaMin',eta_min,'etaMax',eta_max);
end $$;

revoke all on function public.erp_customer_delivery_load(text),public.erp_checkout_delivery_order(uuid,jsonb) from public,anon;
grant execute on function public.erp_customer_delivery_load(text),public.erp_checkout_delivery_order(uuid,jsonb) to authenticated;
commit;
