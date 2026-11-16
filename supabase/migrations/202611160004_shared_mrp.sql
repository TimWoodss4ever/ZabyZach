-- Shared confirmed demand and dated, location-specific planning. No historical
-- browser data is imported and no historical stock, sales or BOMs are rewritten.
alter table public.sales_orders add column if not exists erp_name text,
 add column if not exists erp_phone text,
 add column if not exists erp_prepared_at timestamptz,
 add column if not exists erp_sale_id uuid references public.sales(id),
 add column if not exists erp_request_hash text,
 add column if not exists erp_simulated_paid boolean not null default false;
alter table public.production_orders add column if not exists erp_due_date date;

create or replace function public.erp_planning_snapshot() returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare result jsonb; begin
 if auth.uid() is null or coalesce(public.current_role(),'') not in ('Manager','Cashier') then raise exception 'Staff role required' using errcode='42501';end if;
 select jsonb_build_object(
  'version',1,'today',(now() at time zone 'America/Denver')::date,'userId',auth.uid(),
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

-- Recursive cost roll-up; stock is consumed only at the immediate BOM level.
-- Dough is issued by production once and later consumed as prepared dough.
create or replace function public.erp_plan_unit_cost(p_sku text,p_path text[] default '{}'::text[]) returns numeric
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare result numeric; begin
 if p_sku=any(p_path) then raise exception 'BOM cycle at %',p_sku; end if;
 if exists(select 1 from public.bom_lines where parent_sku=p_sku) then
  select sum(quantity*public.erp_plan_unit_cost(component_sku,p_path||p_sku)) into result from public.bom_lines where parent_sku=p_sku;
 else select unit_cost into result from public.items where sku=p_sku; end if;
 if result is null then raise exception 'Unknown cost item %',p_sku; end if;
 return result;
end $$;

-- Internal posting engine shared by POS and pickup preparation. All item locks
-- are acquired in SKU order before stock checks, preventing concurrent sales
-- from both consuming the same last component. Retries for orders lock the order.
create or replace function public.erp_plan_post_sale(p_location uuid,p_lines jsonb,p_percent numeric,p_fixed numeric,p_customer uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
#variable_conflict use_variable
declare sale uuid:=gen_random_uuid(); receipt text; line record; part record; it public.items%rowtype;
 qty numeric; price numeric; cost numeric; stocked numeric; remainder numeric; have numeric;
 subtotal numeric:=0; discount numeric; tax numeric; rate numeric; cogs numeric:=0;
begin
 if auth.uid() is null or coalesce(public.current_role(),'') not in ('Manager','Cashier') then raise exception 'Staff role required' using errcode='42501';end if;
 if p_lines is null or jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)=0 then raise exception 'Sale requires lines'; end if;
 if p_percent is null or p_percent::text in ('NaN','Infinity','-Infinity') or p_percent<0 or p_percent>100 or p_fixed is null or p_fixed::text in ('NaN','Infinity','-Infinity') or p_fixed<0 then raise exception 'Invalid discount'; end if;
 if not exists(select 1 from public.locations where id=p_location and can_sell) then raise exception 'Choose a selling location'; end if;
 perform 1 from public.items order by sku for update;
 select coalesce((value#>>'{}')::numeric,.0725) into rate from public.settings where setting_key='sales_tax_rate';rate:=coalesce(rate,.0725);
 receipt:='ZBZ-'||to_char(now(),'YYMMDD')||'-'||sale::text;
 insert into public.sales(id,receipt_no,location_id,customer_id,subtotal,discount,tax,total,cogs,created_by) values(sale,receipt,p_location,p_customer,0,0,0,0,0,auth.uid());
 for line in select * from jsonb_array_elements(p_lines) loop
  qty:=(line.value->>'qty')::numeric;
  if qty is null or qty::text in ('NaN','Infinity','-Infinity') or qty<=0 then raise exception 'Line quantities must be positive'; end if;
  select * into it from public.items where sku=line.value->>'sku' and active;
  if not found then raise exception 'Unknown or inactive item'; end if;
  price:=coalesce((line.value->>'price')::numeric,it.selling_price);
  if price::text in ('NaN','Infinity','-Infinity') or price<0 then raise exception 'Invalid sale price'; end if;
  cost:=public.erp_plan_unit_cost(it.sku);
  select greatest(0,coalesce(sum(quantity),0)) into have from public.inventory_transactions where item_sku=it.sku and location_id=p_location and occurred_at<=now();
  if exists(select 1 from public.bom_lines where parent_sku=it.sku) then
   stocked:=least(qty,have);remainder:=qty-stocked;
   if stocked>0 then insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type,reference_document,user_id) values(it.sku,p_location,-stocked,cost,'Sale',receipt,auth.uid());end if;
   for part in select * from public.bom_lines where parent_sku=it.sku order by component_sku loop
    if remainder=0 then continue; end if;
    select coalesce(sum(quantity),0) into have from public.inventory_transactions where item_sku=part.component_sku and location_id=p_location and occurred_at<=now();
    if have<part.quantity*remainder then raise exception 'Insufficient component % at this location (need %, have %)',part.component_sku,part.quantity*remainder,have; end if;
    insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type,reference_document,user_id)
     values(part.component_sku,p_location,-part.quantity*remainder,public.erp_plan_unit_cost(part.component_sku),'Sale',receipt,auth.uid());
   end loop;
  else
   if have<qty then raise exception 'Insufficient stock % at this location',it.sku; end if;
   insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type,reference_document,user_id) values(it.sku,p_location,-qty,cost,'Sale',receipt,auth.uid());
  end if;
  insert into public.sale_lines(sale_id,item_sku,quantity,unit_price,unit_cost) values(sale,it.sku,qty,price,cost);
  subtotal:=subtotal+qty*price;cogs:=cogs+qty*cost;
 end loop;
 discount:=least(subtotal,subtotal*p_percent/100+p_fixed);tax:=round((subtotal-discount)*rate,2);
 update public.sales set subtotal=subtotal,discount=discount,tax=tax,total=subtotal-discount+tax,cogs=cogs where id=sale;
 return jsonb_build_object('sale_id',sale,'receipt_no',receipt,'subtotal',subtotal,'discount',discount,'tax',tax,'total',subtotal-discount+tax,'cogs',cogs);
end $$;

-- Keep the existing POS/exchange API and enforce server catalog prices.
create or replace function public.record_sale(p_location uuid,p_lines jsonb,p_discount_percent numeric default 0,p_customer uuid default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare lines jsonb; begin
 if auth.uid() is null or coalesce(public.current_role(),'') not in ('Manager','Cashier') then raise exception 'Staff role required' using errcode='42501';end if;
 select jsonb_agg(jsonb_build_object('sku',x->>'sku','qty',x->'qty')) into lines from jsonb_array_elements(p_lines)x;
 return public.erp_plan_post_sale(p_location,lines,p_discount_percent,0,p_customer);
end $$;

create or replace function public.erp_create_pickup_order(p_request uuid,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare role_name text:=public.current_role(); customer uuid; loc uuid; pickup timestamptz; name text; phone text;
 line jsonb; it public.items%rowtype; qty numeric; digest text; existing public.sales_orders%rowtype;
 percent numeric; fixed numeric; subtotal numeric:=0; tax numeric; rate numeric; result jsonb;
begin
 if auth.uid() is null or role_name is null or role_name not in ('Manager','Cashier','Customer') then raise exception 'Sign in required' using errcode='42501'; end if;
 if p_request is null or p_payload is null then raise exception 'Request and order details are required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request::text,0));
 digest:=md5(p_payload::text);
 select * into existing from public.sales_orders where id=p_request;
 if found then
  if existing.created_by is distinct from auth.uid() or existing.erp_request_hash is distinct from digest then raise exception 'Request ID was already used for a different order';end if;
 else
  name:=trim(p_payload->>'name');phone:=trim(p_payload->>'phone');
  if coalesce(length(name),0) not between 1 and 60 or coalesce(length(phone),0)>24 then raise exception 'Enter a pickup name (1–60 characters) and valid phone';end if;
  select l.id into loc from public.locations l where l.name=p_payload->>'location' and l.can_sell;
  if loc is null then raise exception 'Choose a selling location';end if;
  pickup:=(p_payload->>'pickup')::timestamptz;
  if pickup is null or pickup<now() then raise exception 'Choose a future pickup date and time';end if;
  percent:=coalesce((p_payload->>'discountPct')::numeric,0);fixed:=coalesce((p_payload->>'discountAmount')::numeric,0);
  if percent::text in ('NaN','Infinity','-Infinity') or fixed::text in ('NaN','Infinity','-Infinity') or percent<0 or percent>100 or fixed<0 then raise exception 'Invalid discount';end if;
  if role_name='Customer' then
   select customer_id into customer from public.profiles where user_id=auth.uid();
   -- Existing welcome-wheel simulation permits at most 25% or $3.
   if percent>25 or fixed>3 or (percent>0 and fixed>0) then raise exception 'Invalid welcome discount';end if;
  else customer:=(nullif(p_payload->>'customerId',''))::uuid;end if;
  if jsonb_typeof(p_payload->'lines') is distinct from 'array' or jsonb_array_length(p_payload->'lines')=0 then raise exception 'Add at least one menu item';end if;
  insert into public.sales_orders(id,customer_id,location_id,pickup_at,discount_pct,discount_amount,notes,created_by,erp_name,erp_phone,erp_request_hash,erp_simulated_paid)
   values(p_request,customer,loc,pickup,percent,fixed,'Confirmed pickup order',auth.uid(),name,nullif(phone,''),digest,role_name='Customer');
  for line in select * from jsonb_array_elements(p_payload->'lines') loop
   qty:=(line->>'qty')::numeric;
   if qty is null or qty::text in ('NaN','Infinity','-Infinity') or qty<=0 or qty<>trunc(qty) then raise exception 'Use positive whole item quantities';end if;
   select * into it from public.items where sku=line->>'sku' and active and selling_price>0;
   if not found then raise exception 'Menu item is unavailable';end if;
   insert into public.sales_order_lines(order_id,item_sku,quantity,unit_price) values(p_request,it.sku,qty,it.selling_price);
  end loop;
 end if;
 -- A repeated request returns the same stored order and locked catalog prices.
 select sum(quantity*unit_price) into subtotal from public.sales_order_lines where order_id=p_request;
 select * into existing from public.sales_orders where id=p_request;
 select coalesce((value#>>'{}')::numeric,.0725) into rate from public.settings where setting_key='sales_tax_rate';rate:=coalesce(rate,.0725);
 subtotal:=subtotal-least(subtotal,subtotal*existing.discount_pct/100+existing.discount_amount);tax:=round(subtotal*rate,2);
 return jsonb_build_object('id',p_request,'total',subtotal+tax,'simulatedPaid',existing.erp_simulated_paid);
end $$;

create or replace function public.erp_pickup_action(p_order uuid,p_action text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare o public.sales_orders%rowtype; lines jsonb; posted jsonb; begin
 if auth.uid() is null or coalesce(public.current_role(),'') not in ('Manager','Cashier') then raise exception 'Staff role required' using errcode='42501';end if;select * into o from public.sales_orders where id=p_order for update;
 if not found then raise exception 'Pickup order not found';end if;
 if p_action='cancel' then
  if o.erp_prepared_at is not null or o.status not in ('Order Placed','Cancelled') then raise exception 'Prepared orders require the Returns workflow';end if;
  update public.sales_orders set status='Cancelled' where id=p_order;return jsonb_build_object('id',p_order);
 end if;
 if p_action not in ('prepare','fulfill') then raise exception 'Unknown pickup action';end if;
 if o.status not in ('Order Placed','Fulfilled') then raise exception 'Order is not open';end if;
 if o.status='Fulfilled' then return jsonb_build_object('id',p_order,'sale_id',o.erp_sale_id);end if;
 if o.erp_prepared_at is null then
  select jsonb_agg(jsonb_build_object('sku',item_sku,'qty',quantity,'price',unit_price) order by item_sku,id) into lines from public.sales_order_lines where order_id=p_order;
  posted:=public.erp_plan_post_sale(o.location_id,lines,o.discount_pct,o.discount_amount,o.customer_id);
  update public.sales_orders set erp_prepared_at=now(),erp_sale_id=(posted->>'sale_id')::uuid where id=p_order;
 end if;
 if p_action='fulfill' then update public.sales_orders set status='Fulfilled' where id=p_order;end if;
 return jsonb_build_object('id',p_order,'sale_id',(select erp_sale_id from public.sales_orders where id=p_order));
end $$;

create or replace function public.erp_schedule_production(p_order uuid,p_due date) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if auth.uid() is null or coalesce(public.current_role(),'') not in ('Manager','Cashier') then raise exception 'Staff role required' using errcode='42501';end if;
 if p_due is null or p_due<(now() at time zone 'America/Denver')::date then raise exception 'Choose a current or future production date';end if;
 update public.production_orders set erp_due_date=p_due where id=p_order and status in ('Planned','In Progress');
 if not found then raise exception 'Production order is no longer open';end if;
end $$;

-- Production and sales take the same stock locks. Good output plus scrap must
-- account for the whole batch. Receipt then scrap leaves exactly good stock;
-- scrap must not deduct a second quantity from already-consumed ingredients.
create or replace function public.issue_production_order(p_order uuid) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
declare o public.production_orders%rowtype; b record; have numeric; begin
 if auth.uid() is null or coalesce(public.current_role(),'') not in ('Manager','Cashier') then raise exception 'Staff role required' using errcode='42501';end if;
 select * into o from public.production_orders where id=p_order for update;
 if not found or o.status<>'Planned' then raise exception 'Production order is not planned';end if;
 perform 1 from public.items order by sku for update;
 if not exists(select 1 from public.bom_lines where parent_sku=o.parent_sku) then raise exception 'Production needs a BOM';end if;
 for b in select * from public.bom_lines where parent_sku=o.parent_sku order by component_sku loop
  select coalesce(sum(quantity),0) into have from public.inventory_transactions where item_sku=b.component_sku and location_id=o.location_id and occurred_at<=now();
  if have<b.quantity*o.quantity_started then raise exception 'Insufficient component % at this location',b.component_sku;end if;
  insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type,reference_document,user_id)
   values(b.component_sku,o.location_id,-b.quantity*o.quantity_started,public.erp_plan_unit_cost(b.component_sku),'Production Issue',o.order_no,auth.uid());
 end loop;
 update public.production_orders set status='In Progress',started_at=now() where id=p_order;
end $$;

create or replace function public.complete_production_order(p_order uuid,p_good numeric,p_scrapped numeric,p_reason text default null) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
declare o public.production_orders%rowtype; cost numeric; begin
 if auth.uid() is null or coalesce(public.current_role(),'') not in ('Manager','Cashier') then raise exception 'Staff role required' using errcode='42501';end if;
 select * into o from public.production_orders where id=p_order for update;
 if not found or o.status<>'In Progress' then raise exception 'Production must be in progress';end if;
 if p_good is null or p_scrapped is null or p_good::text in ('NaN','Infinity','-Infinity') or p_scrapped::text in ('NaN','Infinity','-Infinity') or p_good<0 or p_scrapped<0 or p_good+p_scrapped<>o.quantity_started then raise exception 'Good plus scrap must equal the batch quantity';end if;
 if p_scrapped>0 and coalesce(trim(p_reason),'')='' then raise exception 'Scrap reason required';end if;
 perform 1 from public.items order by sku for update;
 cost:=public.erp_plan_unit_cost(o.parent_sku);
 insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type,reference_document,user_id)
  values(o.parent_sku,o.location_id,p_good+p_scrapped,cost,'Production Receipt',o.order_no,auth.uid());
 if p_scrapped>0 then insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type,reason_code,reference_document,user_id)
  values(o.parent_sku,o.location_id,-p_scrapped,cost,'Waste',p_reason,o.order_no,auth.uid());end if;
 update public.production_orders set status='Completed',quantity_good=p_good,quantity_scrapped=p_scrapped,finished_at=now(),reason_code=p_reason where id=p_order;
end $$;

-- Serialize MRP drafts with the existing purchasing API and reject another
-- manager's pending draft for the same component/destination.
create or replace function public.erp_mrp_purchase_drafts(p_request uuid,p_action text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare o jsonb; l jsonb; begin
 if auth.uid() is null or public.current_role() is distinct from 'Manager' then raise exception 'Manager role required' using errcode='42501';end if;
 if p_action is distinct from 'create_orders' then raise exception 'Only MRP draft creation is allowed';end if;
 perform pg_advisory_xact_lock(1179468369,1);
 if not exists(select 1 from public.erp_purchasing_requests where id=p_request) then
  for o in select * from jsonb_array_elements(p_payload->'orders') loop
   if (o->>'send')::boolean is distinct from false or coalesce(o->>'notes','') not like 'MRP confirmed requirements%' then raise exception 'MRP orders must be reviewable drafts';end if;
   for l in select * from jsonb_array_elements(o->'lines') loop
    if exists(select 1 from public.purchase_orders p join public.purchase_order_lines b on b.purchase_order_id=p.id where p.status='Draft' and p.erp_notes like 'MRP confirmed requirements%' and p.ship_to_location_id=(o->>'locationId')::uuid and b.item_sku=l->>'sku') then raise exception 'An MRP draft already exists for this item and location. Refresh and review Purchase Orders.';end if;
   end loop;
  end loop;
 end if;
 return public.erp_purchasing_write(p_request,'create_orders',p_payload);
end $$;

revoke all on function public.erp_plan_unit_cost(text,text[]),public.erp_plan_post_sale(uuid,jsonb,numeric,numeric,uuid) from public,anon,authenticated;
revoke all on function public.erp_planning_snapshot(),public.erp_create_pickup_order(uuid,jsonb),public.erp_pickup_action(uuid,text),public.erp_schedule_production(uuid,date) from public,anon,authenticated;
grant execute on function public.erp_planning_snapshot(),public.erp_create_pickup_order(uuid,jsonb),public.erp_pickup_action(uuid,text),public.erp_schedule_production(uuid,date) to authenticated;
revoke all on function public.record_sale(uuid,jsonb,numeric,uuid) from public,anon;
grant execute on function public.record_sale(uuid,jsonb,numeric,uuid) to authenticated;
revoke all on function public.issue_production_order(uuid),public.complete_production_order(uuid,numeric,numeric,text),public.erp_mrp_purchase_drafts(uuid,text,jsonb) from public,anon;
grant execute on function public.issue_production_order(uuid),public.complete_production_order(uuid,numeric,numeric,text),public.erp_mrp_purchase_drafts(uuid,text,jsonb) to authenticated;
