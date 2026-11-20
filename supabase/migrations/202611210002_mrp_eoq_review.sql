-- Connect MRP review to shared EOQ policy and prevent cross-workflow duplicate drafts.
-- Function-only migration: no demo rows, historical rewrites or stock postings.
begin;
select pg_advisory_xact_lock(1179468369,210002);
do $$begin
 if to_regprocedure('public.erp_history_usage(date,date,uuid)') is null
 or to_regprocedure('public.erp_read_revision()') is null
 or not exists(select 1 from information_schema.columns where table_schema='public' and table_name='purchase_orders' and column_name='erp_mrp_required_on') then
  raise exception 'Install shared MRP, history and planning hardening before this update';
 end if;
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
  'purchasePolicy',jsonb_build_object('version',1,'options',(select to_jsonb(o) from public.erp_purchasing_options o),'usage',coalesce((select jsonb_agg(to_jsonb(u)) from public.erp_history_usage((now() at time zone 'America/Denver')::date-179,(now() at time zone 'America/Denver')::date) u),'[]'::jsonb)),
  'purchaseDrafts',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'po_no',p.po_no,'location_id',p.ship_to_location_id,'item_sku',l.item_sku,'source',case when p.erp_notes like 'MRP confirmed requirements%' then 'MRP' when p.erp_notes like 'Created during shared inventory review%' then 'Inventory Review' else 'Manual purchasing' end)) from public.purchase_orders p join public.purchase_order_lines l on l.purchase_order_id=p.id where p.status='Draft'),'[]'::jsonb),
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
  public.purchase_orders,public.purchase_order_lines,public.erp_purchasing_options,
  public.erp_sample_menu_history,public.erp_sample_material_history,public.erp_sample_history_batches in exclusive mode;
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
   if exists(select 1 from public.purchase_orders p join public.purchase_order_lines b on b.purchase_order_id=p.id where p.status='Draft' and p.ship_to_location_id=(o->>'locationId')::uuid and b.item_sku=l->>'sku') then raise exception 'A purchase draft already exists for this item and location. Review Purchase Orders';end if;
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

-- Add the guard to the current writer, preserving receiving, costs, tax and audit logic.
-- Preflight every dated group before inserting any of them; intentional MRP
-- date splits in the same request are allowed. The existing shared advisory lock
-- serializes both workflows, and lost-response retries return before this guard.
do $patch$
declare definition text;guard text:=$guard$
 /* EOQ cross-workflow draft guard */
 if p_action='create_orders' then
  if exists(select 1 from jsonb_array_elements(p_payload->'orders') o
   cross join lateral jsonb_array_elements(o->'lines') l
   join public.purchase_order_lines existing_line on existing_line.item_sku=l->>'sku'
   join public.purchase_orders existing_po on existing_po.id=existing_line.purchase_order_id
   where existing_po.status='Draft' and existing_po.ship_to_location_id=(o->>'locationId')::uuid) then
   raise exception 'A purchase draft already exists for this item and location. Review Purchase Orders before creating another';
  end if;
 end if;
$guard$;
begin
 select pg_get_functiondef('public.erp_purchasing_write(uuid,text,jsonb)'::regprocedure) into definition;
 if position('/* EOQ cross-workflow draft guard */' in definition)=0 then
  if position(' case p_action' in definition)=0 then raise exception 'Purchasing writer changed; review the draft guard before installing';end if;
  definition:=regexp_replace(definition,' case p_action',guard||' case p_action');
  execute definition;
 end if;
end $patch$;
-- Existing drafts must be reviewable without issuing an unwanted purchase.
-- Reuse the writer's manager check, row revision, idempotency and audit trail.
do $patch$
declare definition text;edit text:=$edit$
  /* EOQ edit existing draft */
  when 'edit_draft' then
   if po.status<>'Draft' then raise exception 'Only an unissued draft can be edited';end if;
   if jsonb_typeof(p_payload->'lines') is distinct from 'array'
    or jsonb_array_length(p_payload->'lines')<>(select count(*) from public.purchase_order_lines where purchase_order_id=resource)
    or exists(select 1 from jsonb_array_elements(p_payload->'lines')l group by l->>'id' having count(*)>1) then raise exception 'Include every draft line once';end if;
   before_value:=before_value||jsonb_build_object('lines',(select jsonb_agg(to_jsonb(l)) from public.purchase_order_lines l where purchase_order_id=resource));
   for line_input in select value from jsonb_array_elements(p_payload->'lines') loop
    select * into pol from public.purchase_order_lines where id=(line_input->>'id')::uuid and purchase_order_id=resource for update;
    if not found then raise exception 'Unknown draft line';end if;
    qty:=public.erp_purchase_number(line_input,'qty',1,1000000000);
    price:=public.erp_purchase_number(line_input,'price',0,1000000000);
    if qty<>trunc(qty) then raise exception 'Use whole purchase packs';end if;
    update public.purchase_order_lines set quantity_purchase=qty,unit_price_purchase=round(price,2) where id=pol.id;
   end loop;
   if (select sum(quantity_purchase*unit_price_purchase) from public.purchase_order_lines where purchase_order_id=resource)>1000000000000 then raise exception 'Order value is too large';end if;
   update public.purchase_orders set erp_revision=erp_revision+1 where id=resource;
$edit$;
begin
 select pg_get_functiondef('public.erp_purchasing_write(uuid,text,jsonb)'::regprocedure) into definition;
 if position('/* EOQ edit existing draft */' in definition)=0 then
  if position('  when ''send_order'' then' in definition)=0 then raise exception 'Purchasing draft workflow changed; review before installing';end if;
  execute replace(definition,'  when ''send_order'' then',edit||'  when ''send_order'' then');
 end if;
end $patch$;
revoke all on function public.erp_planning_snapshot(),public.erp_mrp_purchase_drafts(uuid,text,jsonb),public.erp_purchasing_write(uuid,text,jsonb) from public,anon;
grant execute on function public.erp_planning_snapshot(),public.erp_mrp_purchase_drafts(uuid,text,jsonb),public.erp_purchasing_write(uuid,text,jsonb) to authenticated;
commit;
