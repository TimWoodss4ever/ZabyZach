-- Shared numbered sales orders, immediate order posting, and recorded POS tender.
begin;
select pg_advisory_xact_lock(1179468369,180001);

create sequence if not exists public.sales_order_number_seq;
alter table public.sales_orders add column if not exists erp_order_number bigint;
with numbered as (
 select id,row_number() over(order by created_at,id) as order_number
 from public.sales_orders where erp_order_number is null
)
update public.sales_orders o set erp_order_number=n.order_number from numbered n where n.id=o.id;
select setval('public.sales_order_number_seq',greatest(coalesce((select max(erp_order_number) from public.sales_orders),0),1),coalesce((select max(erp_order_number) from public.sales_orders),0)>0);
alter table public.sales_orders alter column erp_order_number set default nextval('public.sales_order_number_seq');
alter table public.sales_orders alter column erp_order_number set not null;
create unique index if not exists sales_orders_erp_order_number_key on public.sales_orders(erp_order_number);
alter table public.sales add column if not exists payment_method text not null default 'Cash';
alter table public.sales drop constraint if exists sales_payment_method_check;
alter table public.sales add constraint sales_payment_method_check check(payment_method in('Cash','Card (simulated)','Manual/Simulated'));

create or replace function public.erp_create_pickup_order(p_request uuid,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare role_name text:=public.current_role();customer uuid;loc uuid;pickup timestamptz;name text;phone text;
 line jsonb;it public.items%rowtype;qty numeric;digest text;existing public.sales_orders%rowtype;
 percent numeric;fixed numeric;subtotal numeric:=0;tax numeric;rate numeric;posted jsonb;lines jsonb;
begin
 if auth.uid() is null or role_name is null or role_name not in('Manager','Cashier','Customer') then raise exception 'Sign in required' using errcode='42501';end if;
 if p_request is null or p_payload is null then raise exception 'Request and order details are required';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request::text,0));digest:=md5(p_payload::text);
 select * into existing from public.sales_orders where id=p_request;
 if found then
  if existing.created_by is distinct from auth.uid() or existing.erp_request_hash is distinct from digest then raise exception 'Request ID was already used for a different order';end if;
 else
  name:=trim(p_payload->>'name');phone:=trim(p_payload->>'phone');
  if coalesce(length(name),0) not between 1 and 60 or coalesce(length(phone),0)>24 then raise exception 'Enter a pickup name (1–60 characters) and valid phone';end if;
  select l.id into loc from public.locations l where l.name=p_payload->>'location' and l.can_sell;
  if loc is null then raise exception 'Choose a selling location';end if;
  pickup:=(p_payload->>'pickup')::timestamptz;
  if pickup is null or not isfinite(pickup) or pickup<now() then raise exception 'Choose a future pickup date and time';end if;
  percent:=coalesce((p_payload->>'discountPct')::numeric,0);fixed:=coalesce((p_payload->>'discountAmount')::numeric,0);
  if percent::text in('NaN','Infinity','-Infinity') or fixed::text in('NaN','Infinity','-Infinity') or percent<0 or percent>100 or fixed<0 then raise exception 'Invalid discount';end if;
  if role_name='Customer' then
   select customer_id into customer from public.profiles where user_id=auth.uid();
   if percent>25 or fixed>3 or(percent>0 and fixed>0)then raise exception 'Invalid welcome discount';end if;
  else customer:=(nullif(p_payload->>'customerId',''))::uuid;end if;
  if jsonb_typeof(p_payload->'lines') is distinct from 'array' or jsonb_array_length(p_payload->'lines')=0 then raise exception 'Add at least one menu item';end if;
  insert into public.sales_orders(id,erp_order_number,customer_id,location_id,pickup_at,discount_pct,discount_amount,notes,created_by,erp_name,erp_phone,erp_request_hash,erp_simulated_paid)
   values(p_request,nextval('public.sales_order_number_seq'),customer,loc,pickup,percent,fixed,'Confirmed sales order',auth.uid(),name,nullif(phone,''),digest,role_name='Customer');
  for line in select * from jsonb_array_elements(p_payload->'lines') loop
   qty:=(line->>'qty')::numeric;
   if qty is null or qty::text in('NaN','Infinity','-Infinity') or qty<=0 or qty<>trunc(qty) then raise exception 'Use positive whole item quantities';end if;
   select * into it from public.items where sku=line->>'sku' and active and selling_price>0;
   if not found then raise exception 'Menu item is unavailable';end if;
   insert into public.sales_order_lines(order_id,item_sku,quantity,unit_price)values(p_request,it.sku,qty,it.selling_price);
  end loop;
 end if;
 select * into existing from public.sales_orders where id=p_request for update;
 select coalesce((value#>>'{}')::numeric,.0725) into rate from public.settings where setting_key='sales_tax_rate';rate:=coalesce(rate,.0725);
 select sum(quantity*unit_price) into subtotal from public.sales_order_lines where order_id=p_request;
 subtotal:=subtotal-least(subtotal,subtotal*existing.discount_pct/100+existing.discount_amount);tax:=round(subtotal*rate,2);
 -- Post sale and ingredient consumption in the same transaction as the order.
 if existing.erp_sale_id is null then
  select jsonb_agg(jsonb_build_object('sku',item_sku,'qty',quantity,'price',unit_price) order by item_sku,id) into lines from public.sales_order_lines where order_id=p_request;
  posted:=public.erp_checkout_post_sale(existing.location_id,lines,existing.discount_pct,existing.discount_amount,existing.customer_id);
  update public.sales_orders set erp_sale_id=(posted->>'sale_id')::uuid,erp_simulated_paid=(role_name='Customer') where id=p_request;
  update public.sales set payment_method=case when role_name='Customer' then 'Card (simulated)' else 'Manual/Simulated' end where id=(posted->>'sale_id')::uuid;
 end if;
 return jsonb_build_object('id',p_request,'orderNo',existing.erp_order_number,'total',subtotal+tax,'sale_id',(select erp_sale_id from public.sales_orders where id=p_request),'simulatedPaid',(role_name='Customer'));
end $$;

create or replace function public.erp_checkout_order(p_request uuid,p_payload jsonb)returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare answer jsonb;begin
 if public.current_role() is distinct from 'Customer' then raise exception 'Customer role required' using errcode='42501';end if;
 answer:=public.erp_create_pickup_order(p_request,p_payload);
 return answer||jsonb_build_object('posted',true,'simulatedPaid',true);
end $$;

-- Extend the existing idempotent POS request function with a payment-method choice.
create or replace function public.erp_pos_sale(p_request uuid,p_location uuid,p_lines jsonb,
 p_discount_percent numeric,p_phone text,p_name text,p_redeem boolean,p_payment_method text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_payload jsonb:=jsonb_build_object('location',p_location,'lines',p_lines,'discount',p_discount_percent,'phone',p_phone,'name',p_name,'redeem',p_redeem,'paymentMethod',coalesce(p_payment_method,'Cash'));
 v_prior public.erp_pos_requests%rowtype;v_customer jsonb;v_id uuid;v_result jsonb;v_sale uuid;v_subtotal numeric;v_old_receipt text;v_receipt text;
 v_percent numeric:=p_discount_percent;v_credit numeric:=0;v_earned integer:=0;
begin
 if auth.uid() is null or coalesce(public.current_role(),'') not in('Manager','Cashier')then raise exception 'Manager or Cashier role required' using errcode='42501';end if;
 if coalesce(p_payment_method,'Cash') not in('Cash','Card (simulated)')then raise exception 'Choose Cash or Card';end if;
 if p_request is null then raise exception 'A checkout request ID is required';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request::text,714));
 select * into v_prior from public.erp_pos_requests where request_id=p_request;
 if found then if v_prior.user_id<>auth.uid() or(v_prior.payload<>v_payload and not(coalesce(p_payment_method,'Cash')='Cash' and v_prior.payload=v_payload-'paymentMethod'))then raise exception 'Checkout request does not match the saved sale';end if;return v_prior.result||jsonb_build_object('payment_method',coalesce(p_payment_method,'Cash'));end if;
 if p_discount_percent is null or p_discount_percent::text in('NaN','Infinity','-Infinity') or p_discount_percent not between 0 and 100 then raise exception 'Discount must be between 0 and 100';end if;
 if p_lines is null or jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)=0 then raise exception 'Add at least one item';end if;
 if exists(select 1 from jsonb_to_recordset(p_lines)x(sku text,qty numeric)where qty is null or qty::text in('NaN','Infinity','-Infinity')or qty<=0 or qty<>trunc(qty)or sku is null)then raise exception 'Enter positive whole item quantities';end if;
 if not exists(select 1 from public.locations where id=p_location and can_sell)then raise exception 'Select a selling location';end if;
 if nullif(btrim(p_phone),'')is not null then
  v_customer:=public.erp_pos_customer(p_phone,coalesce(nullif(btrim(p_name),''),(public.erp_pos_customer(p_phone)->>'name')));
  if v_customer is null or not(v_customer->>'enrolled')::boolean then raise exception 'Enter a name to enroll this rewards customer';end if;v_id:=(v_customer->>'id')::uuid;
 elsif p_redeem then raise exception 'Select a rewards customer before redeeming';end if;
 perform 1 from public.items where sku in(select x.sku from jsonb_to_recordset(p_lines)x(sku text))order by sku for update;
 select sum(i.selling_price*x.qty) into v_subtotal from jsonb_to_recordset(p_lines)x(sku text,qty numeric)join public.items i on i.sku=x.sku;
 if p_redeem then if public.erp_rewards_balance(v_id)<100 then raise exception 'This customer needs 100 points to redeem';end if;
  if coalesce(v_subtotal*(1-p_discount_percent/100),0)<5 then raise exception 'At least $5 after other discounts is required';end if;v_credit:=5;v_percent:=p_discount_percent+500/v_subtotal;end if;
 v_result:=public.record_sale(p_location,p_lines,v_percent,v_id);v_sale:=(v_result->>'sale_id')::uuid;
 select receipt_no into v_old_receipt from public.sales where id=v_sale;v_receipt:='Order '||nextval('public.sales_order_number_seq');
 update public.sales set receipt_no=v_receipt where id=v_sale;
 update public.inventory_transactions set reference_document=v_receipt where reference_document=v_old_receipt and transaction_type='Sale';
 if v_id is not null then v_earned:=floor(greatest(0,(v_result->>'subtotal')::numeric-(v_result->>'discount')::numeric)+.00000001)::integer;end if;
 update public.sales set rewards_earned=v_earned,rewards_redeemed=case when p_redeem then 100 else 0 end,
  rewards_discount=v_credit,pickup_name=nullif(btrim(p_name),''),payment_method=coalesce(p_payment_method,'Cash') where id=v_sale;
 v_result:=v_result||jsonb_build_object('rewards_earned',v_earned,'rewards_redeemed',case when p_redeem then 100 else 0 end,
  'rewards_balance',case when v_id is not null then public.erp_rewards_balance(v_id)else null end,'payment_method',coalesce(p_payment_method,'Cash'),'receipt_no',v_receipt);
 insert into public.erp_pos_requests values(p_request,auth.uid(),v_payload,v_result);return v_result;
end $$;

create or replace function public.erp_pickup_progress(p_order uuid,p_action text)returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare o public.sales_orders%rowtype;sale public.sales%rowtype;cancel_ref text;begin
 perform public.require_staff();select * into o from public.sales_orders where id=p_order for update;
 if not found then raise exception 'Order not found';end if;
 if p_action='close' then
  if o.status<>'Fulfilled' then raise exception 'Only fulfilled orders can be closed';end if;
  update public.sales_orders set status='Closed' where id=p_order;return jsonb_build_object('id',p_order,'orderNo',o.erp_order_number);
 end if;
 if p_action='cancel' then
  if o.status<>'Order Placed' or o.erp_prepared_at is not null then raise exception 'Only an unprepared order can be cancelled';end if;
  if o.erp_sale_id is not null then
   select * into sale from public.sales where id=o.erp_sale_id for update;
   if not found or sale.status<>'Completed' then raise exception 'The linked sale cannot be reversed';end if;
   cancel_ref:='CANCEL-ORDER-'||o.erp_order_number;
   insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type,reason_code,reference_document,user_id,metadata)
    select item_sku,location_id,-quantity,unit_cost,'Sale Reversal','Order cancelled',cancel_ref,auth.uid(),jsonb_build_object('sales_order_id',p_order,'sale_id',sale.id)
    from public.inventory_transactions where reference_document=sale.receipt_no and transaction_type='Sale';
   update public.sales set status='Cancelled' where id=sale.id;
  end if;
  update public.sales_orders set status='Cancelled' where id=p_order;return jsonb_build_object('id',p_order,'orderNo',o.erp_order_number);
 end if;
 if p_action is null or p_action not in('prepare','fulfill')then raise exception 'Unknown order action';end if;
 -- Pre-migration staff orders have no linked sale; preserve their prepare-time posting.
 if o.erp_sale_id is null then return public.erp_pickup_unposted_action(p_order,p_action);end if;
 if o.status<>'Order Placed' then raise exception 'Order is not open';end if;
 update public.sales_orders set erp_prepared_at=coalesce(erp_prepared_at,now()),status=case when p_action='fulfill' then 'Fulfilled' else status end where id=p_order;
 return jsonb_build_object('id',p_order,'orderNo',o.erp_order_number,'sale_id',o.erp_sale_id);
end $$;

-- Realtime updates let staff see customer checkouts without waiting for a refresh.
do $$begin
 if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='sales_order_lines') then
  alter publication supabase_realtime add table public.sales_order_lines;
 end if;
end $$;

revoke all on function public.erp_create_pickup_order(uuid,jsonb),public.erp_checkout_order(uuid,jsonb),public.erp_pos_sale(uuid,uuid,jsonb,numeric,text,text,boolean,text),public.erp_pickup_progress(uuid,text) from public,anon;
grant execute on function public.erp_create_pickup_order(uuid,jsonb),public.erp_checkout_order(uuid,jsonb),public.erp_pos_sale(uuid,uuid,jsonb,numeric,text,text,boolean,text),public.erp_pickup_progress(uuid,text) to authenticated;
commit;
