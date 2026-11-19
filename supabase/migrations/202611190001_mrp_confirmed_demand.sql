-- Confirmed future orders drive MRP; preparation posts stock and sale once.
-- Apply AFTER 202611180001_sales_orders_pos.sql. No business rows are rewritten.
begin;
select pg_advisory_xact_lock(1179468369,190001);
-- Fail atomically if the current order/payment rollout is not installed.
do $$begin
 if to_regprocedure('public.erp_checkout_post_sale(uuid,jsonb,numeric,numeric,uuid)') is null
    or not exists(select 1 from information_schema.columns where table_schema='public' and table_name='sales_orders' and column_name='erp_order_number')
    or not exists(select 1 from information_schema.columns where table_schema='public' and table_name='sales' and column_name='payment_method') then
  raise exception 'Install the current shared MRP, completion and numbered sales-order migrations first';
 end if;
end $$;

create or replace function public.erp_create_pickup_order(p_request uuid,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare role_name text:=public.current_role();customer uuid;loc uuid;pickup timestamptz;name text;phone text;
 line jsonb;it public.items%rowtype;qty numeric;digest text;existing public.sales_orders%rowtype;
 percent numeric;fixed numeric;subtotal numeric:=0;tax numeric;rate numeric;
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
 -- Confirmation creates dated demand even when ingredients are not yet available.
 -- Existing linked sales are returned unchanged: never replay or undo old stock.
 return jsonb_build_object('id',p_request,'orderNo',existing.erp_order_number,'total',subtotal+tax,'sale_id',(select erp_sale_id from public.sales_orders where id=p_request),'simulatedPaid',existing.erp_simulated_paid);
end $$;

create or replace function public.erp_checkout_order(p_request uuid,p_payload jsonb)returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare answer jsonb;begin
 if public.current_role() is distinct from 'Customer' then raise exception 'Customer role required' using errcode='42501';end if;
 answer:=public.erp_create_pickup_order(p_request,p_payload);
 -- Payment simulation is separate from inventory consumption and revenue posting.
 return answer||jsonb_build_object('posted',answer->>'sale_id' is not null,'simulatedPaid',true);
end $$;

create or replace function public.erp_pickup_progress(p_order uuid,p_action text)returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare o public.sales_orders%rowtype;sale public.sales%rowtype;cancel_ref text;lines jsonb;posted jsonb;
begin
 if auth.uid() is null or coalesce(public.current_role(),'') not in ('Manager','Cashier') then
  raise exception 'Staff role required' using errcode='42501';
 end if;
 select * into o from public.sales_orders where id=p_order for update;
 if not found then raise exception 'Order not found';end if;
 if p_action='close' then
  if o.status not in ('Fulfilled','Closed') then raise exception 'Only fulfilled orders can be closed';end if;
  update public.sales_orders set status='Closed' where id=p_order and status='Fulfilled';
 elsif p_action='cancel' then
  -- A retried cancellation must not restore stock twice.
  if o.status<>'Cancelled' then
   if o.status<>'Order Placed' or o.erp_prepared_at is not null then raise exception 'Only an unprepared order can be cancelled';end if;
   -- Legacy orders consumed ingredients at confirmation. Reverse only those
   -- actual postings. New unposted orders have no stock or sale to reverse.
   if o.erp_sale_id is not null then
    select * into sale from public.sales where id=o.erp_sale_id for update;
    if not found or sale.status<>'Completed' then raise exception 'The linked sale cannot be reversed';end if;
    cancel_ref:='CANCEL-ORDER-'||o.erp_order_number;
    insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type,reason_code,reference_document,user_id,metadata)
     select item_sku,location_id,-quantity,unit_cost,'Sale Reversal','Order cancelled',cancel_ref,auth.uid(),jsonb_build_object('sales_order_id',p_order,'sale_id',sale.id)
     from public.inventory_transactions where reference_document=sale.receipt_no and transaction_type='Sale';
    update public.sales set status='Cancelled' where id=sale.id;
   end if;
   update public.sales_orders set status='Cancelled' where id=p_order;
  end if;
 elsif p_action in ('prepare','fulfill') then
  -- Both routes and repeated requests serialize on the same order row.
  if o.status not in ('Order Placed','Fulfilled') then raise exception 'Order is not open';end if;
  if o.status='Order Placed' then
   if o.erp_sale_id is null then
    if o.erp_prepared_at is not null then raise exception 'Prepared order has no linked sale; review this order before continuing';end if;
    select jsonb_agg(jsonb_build_object('sku',item_sku,'qty',quantity,'price',unit_price) order by item_sku,id)
     into lines from public.sales_order_lines where order_id=p_order;
    posted:=public.erp_plan_post_sale(o.location_id,lines,o.discount_pct,o.discount_amount,o.customer_id);
    o.erp_sale_id:=(posted->>'sale_id')::uuid;
    update public.sales set payment_method=case when o.erp_simulated_paid then 'Card (simulated)' else 'Manual/Simulated' end where id=o.erp_sale_id;
   end if;
   update public.sales_orders set erp_sale_id=o.erp_sale_id,erp_prepared_at=coalesce(erp_prepared_at,now()),
    status=case when p_action='fulfill' then 'Fulfilled' else status end where id=p_order;
  end if;
 else
  raise exception 'Unknown order action';
 end if;
 return jsonb_build_object('id',p_order,'orderNo',o.erp_order_number,'sale_id',o.erp_sale_id);
end $$;

-- Keep cached staff pages on the same idempotent lifecycle.
create or replace function public.erp_pickup_action(p_order uuid,p_action text)returns jsonb
language sql security definer set search_path=pg_catalog,public as $$select public.erp_pickup_progress(p_order,p_action)$$;
revoke all on function public.erp_create_pickup_order(uuid,jsonb),public.erp_checkout_order(uuid,jsonb),public.erp_pickup_progress(uuid,text),public.erp_pickup_action(uuid,text) from public,anon;
grant execute on function public.erp_create_pickup_order(uuid,jsonb),public.erp_checkout_order(uuid,jsonb),public.erp_pickup_progress(uuid,text),public.erp_pickup_action(uuid,text) to authenticated;
commit;
