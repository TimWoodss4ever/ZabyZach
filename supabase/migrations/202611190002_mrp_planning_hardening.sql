-- MRP hardening: frozen order quotes/status recovery, revision-checked dated
-- PO drafts and atomic scheduled production. No demo data or history backfill.
begin;
select pg_advisory_xact_lock(1179468369,190002);
do $$begin
 if to_regprocedure('public.erp_read_revision()') is null or to_regprocedure('public.erp_plan_post_sale(uuid,jsonb,numeric,numeric,uuid)') is null
 or not exists(select 1 from information_schema.columns where table_schema='public' and table_name='sales_orders' and column_name='erp_order_number') then
  raise exception 'Install the existing shared MRP, completion and numbered-order rollout before this update';
 end if;
end $$;
alter table public.sales_orders add column if not exists erp_quote_subtotal numeric(14,2),
 add column if not exists erp_quote_discount numeric(14,2),add column if not exists erp_quote_tax numeric(14,2),
 add column if not exists erp_quote_total numeric(14,2),add column if not exists erp_quote_tax_rate numeric;
alter table public.purchase_orders add column if not exists erp_mrp_required_on date,
 add column if not exists erp_mrp_order_by date;

create or replace function public.erp_create_pickup_order(p_request uuid,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare role_name text:=public.current_role();customer uuid;loc uuid;pickup timestamptz;name text;phone text;
 line jsonb;it public.items%rowtype;qty numeric;digest text;existing public.sales_orders%rowtype;
 percent numeric;fixed numeric;subtotal numeric:=0;tax numeric;rate numeric;created boolean:=false;stored_sale public.sales%rowtype;
begin
 if auth.uid() is null or role_name is null or role_name not in('Manager','Cashier','Customer') then raise exception 'Sign in required' using errcode='42501';end if;
 if p_request is null or p_payload is null then raise exception 'Request and order details are required';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request::text,0));digest:=md5(p_payload::text);
 select * into existing from public.sales_orders where id=p_request;
 if found then
  if existing.created_by is distinct from auth.uid() or existing.erp_request_hash is distinct from digest then raise exception 'Request ID was already used for a different order';end if;
 else
  created:=true;
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
 if existing.erp_quote_total is not null then
  subtotal:=existing.erp_quote_subtotal;percent:=existing.erp_quote_discount;tax:=existing.erp_quote_tax;rate:=existing.erp_quote_tax_rate;
 elsif existing.erp_sale_id is not null then
  select * into stored_sale from public.sales where id=existing.erp_sale_id;
  subtotal:=stored_sale.subtotal;percent:=stored_sale.discount;tax:=stored_sale.tax;
 else
  select coalesce((value#>>'{}')::numeric,.0725) into rate from public.settings where setting_key='sales_tax_rate';rate:=coalesce(rate,.0725);
  select round(sum(quantity*unit_price),2) into subtotal from public.sales_order_lines where order_id=p_request;
  percent:=round(least(subtotal,subtotal*existing.discount_pct/100+existing.discount_amount),2);
  tax:=round((subtotal-percent)*rate,2);
  if created then
   update public.sales_orders set erp_quote_subtotal=subtotal,erp_quote_discount=percent,erp_quote_tax=tax,
    erp_quote_total=subtotal-percent+tax,erp_quote_tax_rate=rate where id=p_request;
  end if;
 end if;
 -- Recovery reports the actual persisted status. It never reopens an order.
 return jsonb_build_object('id',p_request,'orderNo',existing.erp_order_number,'status',existing.status,
  'subtotal',subtotal,'discount',percent,'tax',tax,'total',subtotal-percent+tax,
  'quoteFrozen',created or existing.erp_quote_total is not null,'sale_id',existing.erp_sale_id,'simulatedPaid',existing.erp_simulated_paid,
  'lines',(select jsonb_agg(jsonb_build_object('sku',item_sku,'qty',quantity,'price',unit_price) order by id) from public.sales_order_lines where order_id=p_request));
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
    if o.erp_quote_total is not null then
     update public.sales set subtotal=o.erp_quote_subtotal,discount=o.erp_quote_discount,
      tax=o.erp_quote_tax,total=o.erp_quote_total where id=o.erp_sale_id;
    end if;
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

create or replace function public.erp_planning_snapshot() returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare result jsonb; begin
 if auth.uid() is null or coalesce(public.current_role(),'') not in ('Manager','Cashier') then raise exception 'Staff role required' using errcode='42501';end if;
 select jsonb_build_object(
  'version',1,'revision',public.erp_read_revision(),'orderWorkflow',2,'today',(now() at time zone 'America/Denver')::date,'userId',auth.uid(),
  'items',coalesce((select jsonb_agg(to_jsonb(i) order by sku) from public.items i),'[]'::jsonb),
  'bom',coalesce((select jsonb_agg(to_jsonb(b) order by parent_sku,component_sku) from public.bom_lines b),'[]'::jsonb),
  'locations',coalesce((select jsonb_agg(to_jsonb(l) order by name) from public.locations l),'[]'::jsonb),
  'suppliers',coalesce((select jsonb_agg(to_jsonb(s) order by name) from public.suppliers s),'[]'::jsonb),
  'orders',coalesce((select jsonb_agg(to_jsonb(o) order by pickup_at,id) from public.sales_orders o),'[]'::jsonb),
  'lines',coalesce((select jsonb_agg(to_jsonb(l) order by order_id,id) from public.sales_order_lines l),'[]'::jsonb),
  'stock',coalesce((select jsonb_agg(to_jsonb(t)) from (select item_sku,location_id,sum(quantity) quantity from public.inventory_transactions where occurred_at<=now() group by item_sku,location_id)t),'[]'::jsonb),
  'production',coalesce((select jsonb_agg(to_jsonb(p) order by created_at,id) from public.production_orders p where status in ('Planned','In Progress')),'[]'::jsonb),
  'purchaseDrafts',coalesce((select jsonb_agg(jsonb_build_object('location_id',p.ship_to_location_id,'item_sku',l.item_sku)) from public.purchase_orders p join public.purchase_order_lines l on l.purchase_order_id=p.id where p.status='Draft' and p.erp_notes like 'MRP confirmed requirements%'),'[]'::jsonb),
  'receipts',coalesce((select jsonb_agg(to_jsonb(r)) from (
   select p.id,l.item_sku,p.ship_to_location_id location_id,(p.expected_at at time zone 'America/Denver')::date due,
    greatest(0,l.quantity_purchase-l.quantity_received_purchase)*i.conversion_factor quantity,'Purchase'::text kind
   from public.purchase_orders p join public.purchase_order_lines l on l.purchase_order_id=p.id join public.items i on i.sku=l.item_sku
   where p.status in ('Order Sent','Partially Received') and l.quantity_purchase>l.quantity_received_purchase
   union all
   select p.id,p.parent_sku,p.location_id,p.erp_due_date,p.quantity_started,'Production'
   from public.production_orders p where p.status in ('Planned','In Progress') and p.erp_due_date is not null
  )r),'[]'::jsonb)
 ) into result;
 return result;
end $$;

create or replace function public.erp_mrp_purchase_drafts(p_request uuid,p_action text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare o jsonb;l jsonb;result jsonb;idx integer:=0;required_on date;order_by date;lead integer;
begin
 if auth.uid() is null or public.current_role() is distinct from 'Manager' then raise exception 'Manager role required' using errcode='42501';end if;
 if p_action is distinct from 'create_orders' then raise exception 'Only MRP draft creation is allowed';end if;
 perform pg_advisory_xact_lock(1179468369,1);
 -- A lost-response retry must recover its original result despite later changes.
 if exists(select 1 from public.erp_purchasing_requests where id=p_request) then
  return public.erp_purchasing_write(p_request,'create_orders',p_payload);
 end if;
 -- Hold a consistent save point against relevant concurrent writes. Read-only
 -- planning stays unlocked; only explicit draft saving takes these short locks.
 -- Take order locks before item/stock locks, matching preparation's order.
 -- EXCLUSIVE permits plain planning reads but waits for SELECT FOR UPDATE too.
 lock table public.sales_orders,public.sales_order_lines,public.items,public.bom_lines,
  public.suppliers,public.locations,public.production_orders,public.inventory_transactions,
  public.purchase_orders,public.purchase_order_lines in exclusive mode;
 if p_payload->>'revision' is null or p_payload->>'revision' is distinct from public.erp_read_revision() then
  raise exception 'Planning data changed. Refresh MRP and review the current suggestions before saving drafts';
 end if;
 for o in select * from jsonb_array_elements(p_payload->'orders') loop
  if (o->>'send')::boolean is distinct from false or coalesce(o->>'notes','') not like 'MRP confirmed requirements%' then raise exception 'MRP orders must be reviewable drafts';end if;
  required_on:=(o->>'requiredOn')::date;order_by:=(o->>'orderBy')::date;
  select quoted_lead_days into lead from public.suppliers where id=(o->>'supplierId')::uuid and erp_active;
  if required_on is null or order_by is null or not isfinite(required_on) or not isfinite(order_by) or lead is null or order_by<>required_on-lead then
   raise exception 'Review the requirement date and supplier lead time before saving this draft';
  end if;
  for l in select * from jsonb_array_elements(o->'lines') loop
   if exists(select 1 from public.purchase_orders p join public.purchase_order_lines b on b.purchase_order_id=p.id where p.status='Draft' and p.erp_notes like 'MRP confirmed requirements%' and p.ship_to_location_id=(o->>'locationId')::uuid and b.item_sku=l->>'sku') then raise exception 'An MRP draft already exists for this item and location. Review Purchase Orders';end if;
  end loop;
 end loop;
 result:=public.erp_purchasing_write(p_request,'create_orders',p_payload);
 for o in select * from jsonb_array_elements(p_payload->'orders') loop
  update public.purchase_orders set erp_mrp_required_on=(o->>'requiredOn')::date,erp_mrp_order_by=(o->>'orderBy')::date,
   expected_at=(((o->>'requiredOn')::date)::text||' 12:00 America/Denver')::timestamptz
   where id=(result->'ids'->>idx)::uuid;
  idx:=idx+1;
 end loop;
 return result;
end $$;

create table if not exists public.erp_scheduled_production_requests(
 id uuid primary key,created_by uuid not null references auth.users(id),payload jsonb not null,
 order_id uuid not null references public.production_orders(id),created_at timestamptz not null default now()
);
alter table public.erp_scheduled_production_requests enable row level security;
revoke all on public.erp_scheduled_production_requests from public,anon,authenticated;
create or replace function public.erp_create_scheduled_production(p_request uuid,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare prior public.erp_scheduled_production_requests%rowtype;created uuid;due date;
begin
 perform public.require_staff();
 if p_request is null or p_payload is null then raise exception 'Request and production details are required';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request::text,190002));
 select * into prior from public.erp_scheduled_production_requests where id=p_request;
 if found then
  if prior.created_by is distinct from auth.uid() or prior.payload is distinct from p_payload then raise exception 'Production request was already used for other details';end if;
  return jsonb_build_object('id',prior.order_id);
 end if;
 due:=(p_payload->>'due')::date;
 if due is null or not isfinite(due) or due<(now() at time zone 'America/Denver')::date then raise exception 'Choose a current or future completion date';end if;
 created:=public.create_production_order(p_payload->>'sku',(p_payload->>'locationId')::uuid,(p_payload->>'quantity')::numeric);
 perform public.erp_schedule_production(created,due);
 insert into public.erp_scheduled_production_requests(id,created_by,payload,order_id) values(p_request,auth.uid(),p_payload,created);
 return jsonb_build_object('id',created);
end $$;
revoke all on function public.erp_create_scheduled_production(uuid,jsonb) from public,anon;
grant execute on function public.erp_create_scheduled_production(uuid,jsonb) to authenticated;
-- Preserve current public entry-point permissions and private posting helpers.
revoke all on function public.erp_create_pickup_order(uuid,jsonb),public.erp_checkout_order(uuid,jsonb),public.erp_pickup_progress(uuid,text),public.erp_planning_snapshot(),public.erp_mrp_purchase_drafts(uuid,text,jsonb) from public,anon;
grant execute on function public.erp_create_pickup_order(uuid,jsonb),public.erp_checkout_order(uuid,jsonb),public.erp_pickup_progress(uuid,text),public.erp_planning_snapshot(),public.erp_mrp_purchase_drafts(uuid,text,jsonb) to authenticated;
commit;
