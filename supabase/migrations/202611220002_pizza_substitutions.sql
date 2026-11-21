-- Let online pizza orders replace unavailable non-dough ingredients at no
-- charge. Persist each swap and apply it when staff prepares/posts the order.
begin;
select pg_advisory_xact_lock(1179468369,220002);
do $$begin
 if to_regprocedure('public.erp_plan_post_sale(uuid,jsonb,numeric,numeric,uuid)') is null
  or to_regprocedure('public.erp_create_pickup_order(uuid,jsonb)') is null
  or to_regprocedure('public.erp_pickup_progress(uuid,text)') is null
  or not exists(select 1 from information_schema.columns where table_schema='public' and table_name='sales_order_lines' and column_name='unit_price') then
  raise exception 'Install the shared MRP and numbered sales order migrations before pizza replacements';
 end if;
end $$;

alter table public.sales_order_lines
 add column if not exists erp_substitutions jsonb not null default '{}'::jsonb;
do $$begin
 if not exists(select 1 from pg_constraint where conrelid='public.sales_order_lines'::regclass and conname='sales_order_lines_substitutions_object_check') then
  alter table public.sales_order_lines add constraint sales_order_lines_substitutions_object_check check(jsonb_typeof(erp_substitutions)='object');
 end if;
end $$;

-- Validate the source ingredient belongs to the selected pizza, is not dough,
-- and the replacement is an ingredient used by at least one pizza recipe.
create or replace function public.erp_create_pickup_order(p_request uuid,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare role_name text:=public.current_role();customer uuid;loc uuid;pickup timestamptz;name text;phone text;
 line jsonb;it public.items%rowtype;source_item public.items%rowtype;replacement_item public.items%rowtype;
 swap record;qty numeric;digest text;existing public.sales_orders%rowtype;percent numeric;fixed numeric;
 subtotal numeric:=0;tax numeric;rate numeric;created boolean:=false;stored_sale public.sales%rowtype;subs jsonb;
begin
 if auth.uid() is null or role_name is null or role_name not in('Manager','Cashier','Customer') then raise exception 'Sign in required' using errcode='42501';end if;
 if p_request is null or p_payload is null then raise exception 'Request and order details are required';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request::text,0));digest:=md5(p_payload::text);
 select * into existing from public.sales_orders where id=p_request;
 if found then
  if existing.created_by is distinct from auth.uid() or existing.erp_request_hash is distinct from digest then raise exception 'Request ID was already used for a different order';end if;
 else
  created:=true;name:=trim(p_payload->>'name');phone:=trim(p_payload->>'phone');
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
   if line ? 'substitutions' and jsonb_typeof(line->'substitutions') is distinct from 'object' then raise exception 'Invalid ingredient replacement details';end if;
   subs:=coalesce(line->'substitutions','{}'::jsonb);
   for swap in select key,value from jsonb_each_text(subs) loop
    if it.category<>'Pizza' or swap.key=swap.value then raise exception 'Ingredient replacements are only allowed on pizzas';end if;
    select * into source_item from public.items where sku=swap.key and category='Ingredient' and sku<>'1030';
    if not found or not exists(select 1 from public.bom_lines where parent_sku=it.sku and component_sku=source_item.sku) then raise exception 'Choose an ingredient on this pizza to replace';end if;
    select * into replacement_item from public.items r where r.sku=swap.value and r.active and r.category='Ingredient' and r.sku<>'1030'
     and exists(select 1 from public.bom_lines b join public.items p on p.sku=b.parent_sku where p.category='Pizza' and p.active and p.selling_price>0 and b.component_sku=r.sku);
    if not found then raise exception 'Choose a valid in-menu pizza ingredient as the free replacement';end if;
   end loop;
   insert into public.sales_order_lines(order_id,item_sku,quantity,unit_price,erp_substitutions)
    values(p_request,it.sku,qty,it.selling_price,subs);
  end loop;
 end if;
 select * into existing from public.sales_orders where id=p_request for update;
 if existing.erp_quote_total is not null then
  subtotal:=existing.erp_quote_subtotal;percent:=existing.erp_quote_discount;tax:=existing.erp_quote_tax;rate:=existing.erp_quote_tax_rate;
 elsif existing.erp_sale_id is not null then
  select * into stored_sale from public.sales where id=existing.erp_sale_id;subtotal:=stored_sale.subtotal;percent:=stored_sale.discount;tax:=stored_sale.tax;
 else
  select coalesce((value#>>'{}')::numeric,.0725) into rate from public.settings where setting_key='sales_tax_rate';rate:=coalesce(rate,.0725);
  select round(sum(quantity*unit_price),2) into subtotal from public.sales_order_lines where order_id=p_request;
  percent:=round(least(subtotal,subtotal*existing.discount_pct/100+existing.discount_amount),2);tax:=round((subtotal-percent)*rate,2);
  if created then update public.sales_orders set erp_quote_subtotal=subtotal,erp_quote_discount=percent,erp_quote_tax=tax,erp_quote_total=subtotal-percent+tax,erp_quote_tax_rate=rate where id=p_request;end if;
 end if;
 return jsonb_build_object('id',p_request,'orderNo',existing.erp_order_number,'status',existing.status,'subtotal',subtotal,'discount',percent,'tax',tax,'total',subtotal-percent+tax,
  'quoteFrozen',created or existing.erp_quote_total is not null,'sale_id',existing.erp_sale_id,'simulatedPaid',existing.erp_simulated_paid,
  'lines',(select jsonb_agg(jsonb_build_object('sku',item_sku,'qty',quantity,'price',unit_price,'substitutions',erp_substitutions) order by id) from public.sales_order_lines where order_id=p_request));
end $$;

-- Charge the original pizza price, but consume the selected replacement
-- ingredient and calculate its actual food cost when the order is prepared.
create or replace function public.erp_plan_post_sale(p_location uuid,p_lines jsonb,p_percent numeric,p_fixed numeric,p_customer uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
#variable_conflict use_variable
declare sale uuid:=gen_random_uuid();receipt text;line record;part record;swap record;it public.items%rowtype;source_item public.items%rowtype;replacement_item public.items%rowtype;
 qty numeric;price numeric;cost numeric;stocked numeric;remainder numeric;have numeric;subtotal numeric:=0;discount numeric;tax numeric;rate numeric;cogs numeric:=0;subs jsonb;
begin
 if auth.uid() is null or coalesce(public.current_role(),'') not in('Manager','Cashier')then raise exception 'Staff role required' using errcode='42501';end if;
 if p_lines is null or jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)=0 then raise exception 'Sale requires lines';end if;
 if p_percent is null or p_percent::text in('NaN','Infinity','-Infinity') or p_percent<0 or p_percent>100 or p_fixed is null or p_fixed::text in('NaN','Infinity','-Infinity') or p_fixed<0 then raise exception 'Invalid discount';end if;
 if not exists(select 1 from public.locations where id=p_location and can_sell)then raise exception 'Choose a selling location';end if;
 perform 1 from public.items order by sku for update;
 select coalesce((value#>>'{}')::numeric,.0725) into rate from public.settings where setting_key='sales_tax_rate';rate:=coalesce(rate,.0725);
 receipt:='ZBZ-'||to_char(now(),'YYMMDD')||'-'||sale::text;
 insert into public.sales(id,receipt_no,location_id,customer_id,subtotal,discount,tax,total,cogs,created_by) values(sale,receipt,p_location,p_customer,0,0,0,0,0,auth.uid());
 for line in select * from jsonb_array_elements(p_lines) loop
  qty:=(line.value->>'qty')::numeric;if qty is null or qty::text in('NaN','Infinity','-Infinity') or qty<=0 or qty<>trunc(qty) then raise exception 'Line quantities must be positive whole numbers';end if;
  select * into it from public.items where sku=line.value->>'sku' and active;if not found then raise exception 'Unknown or inactive item';end if;
  price:=coalesce((line.value->>'price')::numeric,it.selling_price);if price::text in('NaN','Infinity','-Infinity') or price<0 then raise exception 'Invalid sale price';end if;
  subs:=coalesce(line.value->'substitutions','{}'::jsonb);if jsonb_typeof(subs)<>'object' then raise exception 'Invalid ingredient replacement details';end if;
  for swap in select key,value from jsonb_each_text(subs) loop
   select * into source_item from public.items where sku=swap.key and category='Ingredient' and sku<>'1030';
   if it.category<>'Pizza' or not found or not exists(select 1 from public.bom_lines where parent_sku=it.sku and component_sku=source_item.sku) then raise exception 'Invalid pizza ingredient replacement';end if;
   select * into replacement_item from public.items r where r.sku=swap.value and r.active and r.category='Ingredient' and r.sku<>'1030'
    and exists(select 1 from public.bom_lines b join public.items p on p.sku=b.parent_sku where p.category='Pizza' and p.active and p.selling_price>0 and b.component_sku=r.sku);
   if not found or replacement_item.sku=source_item.sku then raise exception 'Invalid pizza ingredient replacement';end if;
  end loop;
  if exists(select 1 from jsonb_object_keys(subs)) then
   if not exists(select 1 from public.bom_lines where parent_sku=it.sku) then raise exception 'Only pizzas can have ingredient replacements';end if;
   select sum(recipe.quantity*public.erp_plan_unit_cost(recipe.component_sku)) into cost from (
    select coalesce(swap.value,b.component_sku) component_sku,sum(b.quantity) quantity
    from public.bom_lines b left join lateral (select e.value from jsonb_each_text(subs)e where e.key=b.component_sku)swap on true
    where b.parent_sku=it.sku group by coalesce(swap.value,b.component_sku)
   )recipe;
  else cost:=public.erp_plan_unit_cost(it.sku);end if;
  select greatest(0,coalesce(sum(quantity),0)) into have from public.inventory_transactions where item_sku=it.sku and location_id=p_location and occurred_at<=now();
  if exists(select 1 from public.bom_lines where parent_sku=it.sku)then
   stocked:=case when exists(select 1 from jsonb_object_keys(subs)) then 0 else least(qty,have) end;remainder:=qty-stocked;
   if stocked>0 then insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type,reference_document,user_id)values(it.sku,p_location,-stocked,cost,'Sale',receipt,auth.uid());end if;
   for part in
    select coalesce(swap.value,b.component_sku) component_sku,sum(b.quantity) quantity
    from public.bom_lines b left join lateral (select e.value from jsonb_each_text(subs)e where e.key=b.component_sku)swap on true
    where b.parent_sku=it.sku group by coalesce(swap.value,b.component_sku) order by coalesce(swap.value,b.component_sku)
   loop
    if remainder=0 then continue;end if;
    select coalesce(sum(quantity),0) into have from public.inventory_transactions where item_sku=part.component_sku and location_id=p_location and occurred_at<=now();
    if have<part.quantity*remainder then raise exception 'Insufficient component % at this location (need %, have %)',part.component_sku,part.quantity*remainder,have;end if;
    insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type,reference_document,user_id)
     values(part.component_sku,p_location,-part.quantity*remainder,public.erp_plan_unit_cost(part.component_sku),'Sale',receipt,auth.uid());
   end loop;
  else
   if have<qty then raise exception 'Insufficient stock % at this location',it.sku;end if;
   insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type,reference_document,user_id)values(it.sku,p_location,-qty,cost,'Sale',receipt,auth.uid());
  end if;
  insert into public.sale_lines(sale_id,item_sku,quantity,unit_price,unit_cost)values(sale,it.sku,qty,price,cost);subtotal:=subtotal+qty*price;cogs:=cogs+qty*cost;
 end loop;
 discount:=least(subtotal,subtotal*p_percent/100+p_fixed);tax:=round((subtotal-discount)*rate,2);
 update public.sales set subtotal=subtotal,discount=discount,tax=tax,total=subtotal-discount+tax,cogs=cogs where id=sale;
 return jsonb_build_object('sale_id',sale,'receipt_no',receipt,'subtotal',subtotal,'discount',discount,'tax',tax,'total',subtotal-discount+tax,'cogs',cogs);
end $$;

-- Carry persisted substitutions into the inventory posting performed by staff.
create or replace function public.erp_pickup_progress(p_order uuid,p_action text)returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare o public.sales_orders%rowtype;sale public.sales%rowtype;cancel_ref text;lines jsonb;posted jsonb;
begin
 if auth.uid() is null or coalesce(public.current_role(),'') not in('Manager','Cashier')then raise exception 'Staff role required' using errcode='42501';end if;
 select * into o from public.sales_orders where id=p_order for update;if not found then raise exception 'Order not found';end if;
 if p_action='close' then
  if o.status not in('Fulfilled','Closed')then raise exception 'Only fulfilled orders can be closed';end if;
  update public.sales_orders set status='Closed' where id=p_order and status='Fulfilled';
 elsif p_action='cancel' then
  if o.status<>'Cancelled' then
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
   update public.sales_orders set status='Cancelled' where id=p_order;
  end if;
 elsif p_action in('prepare','fulfill') then
  if o.status not in('Order Placed','Fulfilled')then raise exception 'Order is not open';end if;
  if o.status='Order Placed' then
   if o.erp_sale_id is null then
    if o.erp_prepared_at is not null then raise exception 'Prepared order has no linked sale; review this order before continuing';end if;
    select jsonb_agg(jsonb_build_object('sku',item_sku,'qty',quantity,'price',unit_price,'substitutions',erp_substitutions) order by item_sku,id) into lines from public.sales_order_lines where order_id=p_order;
    posted:=public.erp_plan_post_sale(o.location_id,lines,o.discount_pct,o.discount_amount,o.customer_id);o.erp_sale_id:=(posted->>'sale_id')::uuid;
    if o.erp_quote_total is not null then update public.sales set subtotal=o.erp_quote_subtotal,discount=o.erp_quote_discount,tax=o.erp_quote_tax,total=o.erp_quote_total where id=o.erp_sale_id;end if;
    update public.sales set payment_method=case when o.erp_simulated_paid then 'Card (simulated)' else 'Manual/Simulated' end where id=o.erp_sale_id;
   end if;
   update public.sales_orders set erp_sale_id=o.erp_sale_id,erp_prepared_at=coalesce(erp_prepared_at,now()),status=case when p_action='fulfill' then 'Fulfilled' else status end where id=p_order;
  end if;
 else raise exception 'Unknown order action';end if;
 return jsonb_build_object('id',p_order,'orderNo',o.erp_order_number,'sale_id',o.erp_sale_id);
end $$;

revoke all on function public.erp_plan_post_sale(uuid,jsonb,numeric,numeric,uuid) from public,anon,authenticated;
commit;
