-- Consolidated completion; apply this file only after the installed menu history.
begin;
select pg_advisory_xact_lock(1179468369,170003);
create table if not exists public.erp_completion_imports(id text primary key,installed_at timestamptz not null default now(),details jsonb not null);
alter table public.erp_completion_imports enable row level security;
revoke all on public.erp_completion_imports from public,anon,authenticated;

do $$
declare owner_id uuid;today date:=(now() at time zone 'America/Denver')::date;first_day date;last_day date;
 p record;li record;order_id uuid;line_id uuid;receipt_id uuid;invoice_id uuid;movement_id uuid;
 amount numeric;paid numeric;paid_date date;due_date date;price numeric;got integer;receive_date date;quoted integer;
begin
 if to_regprocedure('public.erp_reporting_snapshot_with_history(date,date,uuid)') is null then raise exception 'The menu-history migration must be installed first';end if;
 if exists(select 1 from public.erp_completion_imports where id='purchasing-ledger-v1') then return;end if;
 select user_id into owner_id from public.profiles where role='Manager' order by user_id limit 1;
 if owner_id is null then raise exception 'A Manager profile is required to own imported purchasing records';end if;
 select from_date,to_date into first_day,last_day from public.erp_sample_history_batches where id='menu-history-v1';
 if first_day is null then raise exception 'Six-month menu history is missing';end if;
 -- Freeze one set of PO line quantities from the existing historical material usage.
 create temporary table completion_purchase_lines on commit drop as
 with schedule as(
  select s.id supplier_id,s.name,s.quoted_lead_days,s.payment_terms_days,l.id location_id,
   case when s.name ilike '%Produce%' then 3 when s.name ilike '%Dairy%' then 4 when s.name ilike '%Packaging%' then 14
    when s.name ilike '%Water%' then 28 when s.name ilike '%Dry%' then 10 else 7 end cadence,
   case when s.name ilike '%Packaging%' then 75 when s.name ilike '%Meats%' then 40 when s.name ilike '%Produce%' then 19 when s.name ilike '%Water%' then 2 else 11 end late_percent
  from public.suppliers s cross join public.locations l where s.erp_active and l.can_sell
 ), dates as(
  select s.*,d::date AS received_on,('x'||substr(md5(s.supplier_id::text||s.location_id::text||d::date::text),1,8))::bit(32)::bigint AS variation
  from schedule s cross join generate_series(first_day::timestamp,last_day::timestamp,interval '1 day')d
  where mod(d::date-first_day,s.cadence)=0
 ), demand as(
  select d.*,h.item_sku,sum(h.quantity) AS units
  from dates d join public.erp_sample_material_history h on h.batch_id='menu-history-v1' and h.location_id=d.location_id
   and h.usage_date between greatest(first_day,d.received_on-d.cadence+1) and d.received_on
  join public.items i on i.sku=h.item_sku and i.supplier_id=d.supplier_id and i.active
  where not exists(select 1 from public.bom_lines b where b.parent_sku=i.sku)
  group by d.supplier_id,d.name,d.quoted_lead_days,d.payment_terms_days,d.location_id,d.cadence,d.late_percent,d.received_on,d.variation,h.item_sku
 ) select d.*,greatest(1,ceil(d.units/i.conversion_factor))::integer AS packs,
  greatest(.01,round(i.unit_cost*i.conversion_factor*(.97+.01*extract(month from received_on)),2)) AS pack_price,
  greatest(0,quoted_lead_days+case when mod(variation,100)<late_percent then 1+mod(variation/100,3)::integer+case when d.name ilike '%Packaging%' then 6 when d.name ilike '%Meats%' then 2 else 0 end
   when mod(variation,100)>88 then -1 else 0 end) AS actual_lead
 from demand d join public.items i on i.sku=d.item_sku;
 for p in select distinct supplier_id,location_id,received_on,quoted_lead_days,payment_terms_days,variation,actual_lead from completion_purchase_lines order by received_on,supplier_id,location_id loop
  order_id:=md5('purchasing-ledger-v1|'||p.supplier_id::text||p.location_id::text||p.received_on::text)::uuid;
  receipt_id:=md5(order_id::text||'receipt')::uuid;invoice_id:=md5(order_id::text||'invoice')::uuid;
  insert into public.purchase_orders(id,po_no,supplier_id,ship_to_location_id,ordered_at,expected_at,received_at,status,created_by,created_at,erp_quoted_lead_days,erp_payment_terms_days,erp_notes)
  values(order_id,'PO-H-'||to_char(p.received_on,'YYMMDD')||'-'||upper(substr(order_id::text,1,8)),p.supplier_id,p.location_id,
   (p.received_on-p.actual_lead)::timestamp at time zone 'America/Denver',(p.received_on-p.actual_lead+p.quoted_lead_days)::timestamp at time zone 'America/Denver',
   p.received_on::timestamp at time zone 'America/Denver','Received',owner_id,(p.received_on-p.actual_lead)::timestamp at time zone 'America/Denver',p.quoted_lead_days,p.payment_terms_days,'Imported purchasing history; receipts reconciled to opening stock.');
  insert into public.erp_purchase_receipts(id,purchase_order_id,received_on,location_id,final_delivery,tax_amount,created_by,created_at)
  values(receipt_id,order_id,p.received_on,p.location_id,true,0,owner_id,p.received_on::timestamp at time zone 'America/Denver');
  amount:=0;
  for li in select q.*,i.conversion_factor,i.unit_cost from completion_purchase_lines q join public.items i on i.sku=q.item_sku
   where q.supplier_id=p.supplier_id and q.location_id=p.location_id and q.received_on=p.received_on loop
   line_id:=md5(order_id::text||li.item_sku)::uuid;movement_id:=md5(line_id::text||'stock')::uuid;
   got:=case when mod(p.variation/1000,100)<(case when li.name ilike '%Packaging%' then 65 when li.name ilike '%Meats%' then 28 else 14 end) and li.packs>1 then greatest(1,floor(li.packs*(case when li.name ilike '%Packaging%' then .80 when li.name ilike '%Meats%' then .88 else .94 end))::integer) else li.packs end;
   insert into public.purchase_order_lines(id,purchase_order_id,item_sku,quantity_purchase,quantity_received_purchase,unit_price_purchase)
   values(line_id,order_id,li.item_sku,li.packs,got,li.pack_price);
   -- Receipts already represented in the team's opening stock must not restock it
   -- again. The zero-valued opening-basis entry reconciles quantity, not P&L cost.
   insert into public.inventory_transactions(id,item_sku,location_id,quantity,unit_cost,transaction_type,reference_document,user_id,occurred_at,metadata)
   values(movement_id,li.item_sku,p.location_id,got*li.conversion_factor,li.pack_price/li.conversion_factor,'Receipt','PO-H-'||to_char(p.received_on,'YYMMDD')||'-'||upper(substr(order_id::text,1,8)),owner_id,
    p.received_on::timestamp at time zone 'America/Denver',jsonb_build_object('erp_import_batch','purchasing-ledger-v1','receipt_id',receipt_id)),
   (md5(line_id::text||'opening-basis')::uuid,li.item_sku,p.location_id,-got*li.conversion_factor,0,'Adjustment','Opening balance reconciliation',owner_id,
    (p.received_on::timestamp at time zone 'America/Denver')+interval '1 second',jsonb_build_object('erp_import_batch','purchasing-ledger-v1','receipt_id',receipt_id,'paired_transaction',movement_id));
   insert into public.erp_purchase_receipt_lines(id,receipt_id,purchase_order_line_id,quantity_purchase,unit_price_purchase,transaction_id)
   values(md5(line_id::text||'receipt-line')::uuid,receipt_id,line_id,got,li.pack_price,movement_id);
   amount:=amount+got*li.pack_price;
  end loop;
  due_date:=p.received_on+p.payment_terms_days;
  paid:=case when due_date<today-14 then amount when due_date<today and mod(p.variation/100,100)<65 then amount
   when mod(p.variation/100,100)<35 then round(amount*.5,2) else 0 end;
  paid_date:=least(today,greatest(p.received_on, due_date-1));
  insert into public.supplier_invoices(id,purchase_order_id,amount,due_at,paid_at,created_at,erp_invoice_date,erp_receipt_id)
  values(invoice_id,order_id,amount,due_date,case when paid=amount then paid_date else null end,p.received_on::timestamp at time zone 'America/Denver',p.received_on,receipt_id);
  if paid>0 then insert into public.erp_supplier_payments(id,invoice_id,paid_on,amount,reference,created_by,created_at)
   values(md5(invoice_id::text||'payment')::uuid,invoice_id,paid_date,paid,'PAY-H-'||upper(substr(invoice_id::text,1,8)),owner_id,paid_date::timestamp at time zone 'America/Denver');end if;
  if paid=amount then update public.purchase_orders set status='Closed' where id=order_id;end if;
 end loop;
 -- Issued orders provide realistic pending supply without prematurely posting stock.
 for p in select distinct on(supplier_id,location_id) * from completion_purchase_lines order by supplier_id,location_id,received_on desc,item_sku loop
  order_id:=md5('purchasing-open-v1|'||p.supplier_id::text||p.location_id::text)::uuid;
  insert into public.purchase_orders(id,po_no,supplier_id,ship_to_location_id,ordered_at,expected_at,status,created_by,erp_quoted_lead_days,erp_payment_terms_days,erp_notes)
  values(order_id,'PO-'||to_char(today,'YYMMDD')||'-'||upper(substr(order_id::text,1,8)),p.supplier_id,p.location_id,
   (today-1)::timestamp at time zone 'America/Denver',(today-1+p.quoted_lead_days)::timestamp at time zone 'America/Denver','Order Sent',owner_id,p.quoted_lead_days,p.payment_terms_days,'Scheduled replenishment');
  insert into public.purchase_order_lines(id,purchase_order_id,item_sku,quantity_purchase,unit_price_purchase)
   select md5(order_id::text||q.item_sku)::uuid,order_id,q.item_sku,q.packs,q.pack_price from completion_purchase_lines q
   where q.supplier_id=p.supplier_id and q.location_id=p.location_id and q.received_on=p.received_on;
 end loop;
 if exists(select 1 from public.suppliers s where s.erp_active and s.name in('Wasatch Dairy Co.','Valley Meats','Mountain Produce','Summit Dry Goods','Beehive Packaging','Cascade Beverage & Sides','Provo Water Utility')
  and not exists(select 1 from public.purchase_orders o where o.supplier_id=s.id and o.po_no like 'PO-H-%')) then
  raise exception 'A supplier lacks assigned historical material demand; no changes were installed';
 end if;
 insert into public.erp_completion_imports(id,details)values('purchasing-ledger-v1',jsonb_build_object('from',first_day,'to',last_day,'owner',owner_id,'provenance','Coursework historical reconstruction from material demand; stock opening-basis reconciled; current balances preserved.'));
end $$;

-- An audited correction to a historical receipt also moves its paired opening
-- reconciliation, preserving both the current balance and historical timing.
create or replace function public.erp_retime_import_basis()returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$begin
 update public.inventory_transactions set occurred_at=new.occurred_at+interval '1 second'
 where metadata->>'erp_import_batch'='purchasing-ledger-v1' and metadata->>'paired_transaction'=new.id::text;
 return null;
end $$;
do $$begin
 if not exists(select 1 from pg_trigger where tgrelid='public.inventory_transactions'::regclass and tgname='erp_retime_import_basis') then
  create trigger erp_retime_import_basis after update of occurred_at on public.inventory_transactions for each row
   when(new.transaction_type='Receipt' and new.metadata->>'erp_import_batch'='purchasing-ledger-v1' and old.occurred_at is distinct from new.occurred_at) execute function public.erp_retime_import_basis();
 end if;
end $$;
-- Inexpensive change tokens let cached reports remain current after any posting.
create table if not exists public.erp_data_changes(id bigint generated always as identity primary key,created_at timestamptz not null default now());
create table if not exists public.erp_read_cache(cache_key text primary key,revision text not null,payload jsonb not null,created_at timestamptz not null default now());
alter table public.erp_data_changes enable row level security;alter table public.erp_read_cache enable row level security;
revoke all on public.erp_data_changes,public.erp_read_cache from public,anon,authenticated;
create or replace function public.erp_mark_data_change() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$begin insert into public.erp_data_changes default values;return null;end $$;
do $$declare t text;begin
 foreach t in array array['sales','sale_lines','inventory_transactions','sales_returns','sales_return_lines','items','bom_lines','suppliers','purchase_orders','purchase_order_lines','erp_purchase_receipts','erp_purchase_receipt_lines','supplier_invoices','erp_supplier_payments','erp_purchasing_options','erp_reporting_expenses','erp_supplier_reviews','erp_inventory_reviews','settings','sales_orders','sales_order_lines','production_orders','locations','erp_sample_menu_history','erp_sample_material_history','erp_sample_history_batches'] loop
  if not exists(select 1 from pg_trigger where tgrelid=('public.'||t)::regclass and tgname='erp_report_invalidation') then
   execute format('create trigger erp_report_invalidation after insert or update or delete or truncate on public.%I for each statement execute function public.erp_mark_data_change()',t);
  end if;
 end loop;
end $$;
create or replace function public.erp_read_revision() returns text language sql stable security definer set search_path=pg_catalog,public as $$select count(*)::text||':'||coalesce(max(id),0)::text||':'||(now() at time zone 'America/Denver')::date::text from public.erp_data_changes$$;
-- Preserve exact recorded valuation rules, excluding receipts already in opening
-- balances. Cache the expensive replay per date range and committed data version.
do $$declare body text;begin
 body:=pg_get_functiondef('public.erp_reporting_inventory(timestamptz,timestamptz)'::regprocedure);
 if position('where it.item_sku=i.sku and it.occurred_at<p_end' in body)=0 then raise exception 'Inventory valuation source changed; review before installing';end if;
 body:=replace(body,'FUNCTION public.erp_reporting_inventory(','FUNCTION public.erp_reporting_inventory_core(');
 body:=replace(body,'where it.item_sku=i.sku and it.occurred_at<p_end', 'where it.item_sku=i.sku and it.occurred_at<p_end and (it.metadata->>''erp_import_batch'') is distinct from ''purchasing-ledger-v1''');
 execute body;
end $$;
create or replace function public.erp_reporting_inventory_fast(p_start timestamptz,p_end timestamptz)
returns table(item_sku text,location_id uuid,opening_quantity numeric,quantity numeric,opening_cost numeric,average_cost numeric,negative_history boolean)
language plpgsql security definer set search_path=pg_catalog,public as $$
declare key text:='stock:'||(p_start at time zone 'America/Denver')::date::text||':'||(p_end at time zone 'America/Denver')::date::text||case when (p_end at time zone 'America/Denver')::time=time '00:00' then ':closed' else ':live' end;rev text:=public.erp_read_revision();data jsonb;begin
 perform pg_advisory_xact_lock(hashtextextended(key,0));
 select c.payload into data from public.erp_read_cache c where c.cache_key=key and c.revision=rev and c.created_at>now()-interval '15 seconds';
 if data is null then select coalesce(jsonb_agg(to_jsonb(i)),'[]'::jsonb) into data from public.erp_reporting_inventory_core(p_start,p_end)i;
  insert into public.erp_read_cache(cache_key,revision,payload)values(key,rev,data)on conflict(cache_key)do update set revision=excluded.revision,payload=excluded.payload,created_at=now();end if;
 return query select * from jsonb_to_recordset(data) as r(item_sku text,location_id uuid,opening_quantity numeric,quantity numeric,opening_cost numeric,average_cost numeric,negative_history boolean);
end $$;
do $$declare body text;begin
 body:=pg_get_functiondef('public.erp_reporting_snapshot(date,date,uuid)'::regprocedure);
 body:=replace(body,'FUNCTION public.erp_reporting_snapshot(','FUNCTION public.erp_reporting_base_fast(');
 body:=replace(body,'public.erp_reporting_inventory(','public.erp_reporting_inventory_fast(');execute body;
 body:=pg_get_functiondef('public.erp_reporting_snapshot_v2(date,date,uuid)'::regprocedure);
 body:=replace(body,'FUNCTION public.erp_reporting_snapshot_v2(','FUNCTION public.erp_reporting_quality_fast(');
 body:=replace(body,'public.erp_reporting_snapshot(','public.erp_reporting_base_fast(');execute body;
 body:=pg_get_functiondef('public.erp_reporting_snapshot_with_history(date,date,uuid)'::regprocedure);
 body:=replace(body,'FUNCTION public.erp_reporting_snapshot_with_history(','FUNCTION public.erp_reporting_history_fast(');
 body:=replace(body,'public.erp_reporting_snapshot_v2(','public.erp_reporting_quality_fast(');execute body;
end $$;
create or replace function public.erp_reporting_current(p_from date,p_to date,p_location uuid default null)returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare key text;rev text;data jsonb;begin
 if auth.uid() is null or public.current_role() is distinct from 'Manager' then raise exception 'Manager role required' using errcode='42501';end if;
 if p_from is null or p_to is null or p_from>p_to or p_to>(now() at time zone 'America/Denver')::date or p_to-p_from>3660 then raise exception 'Choose a valid report date range';end if;
 key:='report:'||auth.uid()::text||':'||p_from::text||':'||p_to::text||':'||coalesce(p_location::text,'all');rev:=public.erp_read_revision();
 perform pg_advisory_xact_lock(hashtextextended(key,0));
 select c.payload into data from public.erp_read_cache c where c.cache_key=key and c.revision=rev and c.created_at>now()-interval '15 seconds';
 if data is null then data:=public.erp_reporting_history_fast(p_from,p_to,p_location);
  insert into public.erp_read_cache(cache_key,revision,payload)values(key,rev,data)on conflict(cache_key)do update set revision=excluded.revision,payload=excluded.payload,created_at=now();end if;
 return data;
end $$;

-- Checkout posts once at confirmed online checkout; later preparation is physical
-- progress only. Staff-created unpaid pickup orders keep their original behavior.
do $$declare body text;begin
 body:=pg_get_functiondef('public.erp_plan_post_sale(uuid,jsonb,numeric,numeric,uuid)'::regprocedure);
 body:=replace(body,'FUNCTION public.erp_plan_post_sale(','FUNCTION public.erp_checkout_post_sale(');
 body:=replace(body,'coalesce(public.current_role(),'''') not in (''Manager'',''Cashier'')','coalesce(public.current_role(),'''') not in (''Manager'',''Cashier'',''Customer'')');
 execute body;
end $$;
create or replace function public.erp_checkout_order(p_request uuid,p_payload jsonb)returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare answer jsonb;o public.sales_orders%rowtype;lines jsonb;posted jsonb;begin
 answer:=public.erp_create_pickup_order(p_request,p_payload);
 select * into o from public.sales_orders where id=p_request for update;
 if o.created_by is distinct from auth.uid() then raise exception 'Order belongs to another account' using errcode='42501';end if;
 if o.status<>'Order Placed' and o.erp_sale_id is null then raise exception 'Order cannot be checked out';end if;
 if o.erp_sale_id is null then
  select jsonb_agg(jsonb_build_object('sku',item_sku,'qty',quantity,'price',unit_price) order by item_sku,id) into lines from public.sales_order_lines where order_id=p_request;
  posted:=public.erp_checkout_post_sale(o.location_id,lines,o.discount_pct,o.discount_amount,o.customer_id);
  update public.sales_orders set erp_sale_id=(posted->>'sale_id')::uuid,erp_simulated_paid=true where id=p_request;
 end if;
 return answer||jsonb_build_object('sale_id',(select erp_sale_id from public.sales_orders where id=p_request),'posted',true,'simulatedPaid',true);
end $$;
-- Keep previously opened staff pages safe too: both progress endpoints share
-- the once-only guard. Retain the original unpaid-order engine privately.
do $$declare body text;begin
 if to_regprocedure('public.erp_pickup_unposted_action(uuid,text)') is null then
  body:=pg_get_functiondef('public.erp_pickup_action(uuid,text)'::regprocedure);
  body:=replace(body,'FUNCTION public.erp_pickup_action(','FUNCTION public.erp_pickup_unposted_action(');execute body;
 end if;
end $$;
create or replace function public.erp_pickup_progress(p_order uuid,p_action text)returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare o public.sales_orders%rowtype;begin
 perform public.require_staff();select * into o from public.sales_orders where id=p_order for update;
 if not found then raise exception 'Order not found';end if;
 if o.erp_sale_id is null then return public.erp_pickup_unposted_action(p_order,p_action);end if;
 if p_action is null or p_action not in('prepare','fulfill') then raise exception 'Posted orders must use Returns to refund or cancel';end if;
 if o.status not in('Order Placed','Fulfilled') then raise exception 'Order is not open';end if;
 update public.sales_orders set erp_prepared_at=coalesce(erp_prepared_at,now()),status=case when p_action='fulfill' then 'Fulfilled' else status end where id=p_order;
 return jsonb_build_object('id',p_order,'sale_id',o.erp_sale_id);
end $$;
create or replace function public.erp_pickup_action(p_order uuid,p_action text)returns jsonb language sql security definer set search_path=pg_catalog,public as $$select public.erp_pickup_progress(p_order,p_action)$$;
create or replace function public.erp_purchasing_snapshot_current(p_revision text default null) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare rev text;begin
 if auth.uid() is null or public.current_role() is distinct from 'Manager' then raise exception 'Manager role required' using errcode='42501';end if;
 rev:=public.erp_read_revision();if p_revision=rev then return jsonb_build_object('unchanged',true,'serverRevision',rev);end if;
 return public.erp_purchasing_snapshot_with_history()||jsonb_build_object('serverRevision',rev);
end $$;
create or replace function public.erp_barcode_catalog()returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$begin
 perform public.require_staff();
 return jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(i) order by sku)from public.items i where active),'[]'::jsonb),
 'bom',coalesce((select jsonb_agg(to_jsonb(b))from public.bom_lines b),'[]'::jsonb),
 'locations',coalesce((select jsonb_agg(to_jsonb(l)order by name)from public.locations l),'[]'::jsonb),
 'suppliers',coalesce((select jsonb_agg(to_jsonb(s)order by name)from public.suppliers s),'[]'::jsonb),
 'orders',coalesce((select jsonb_agg(to_jsonb(o)order by ordered_at desc)from public.purchase_orders o where status in('Draft','Order Sent','Partially Received')),'[]'::jsonb),
 'lines',coalesce((select jsonb_agg(to_jsonb(l))from public.purchase_order_lines l join public.purchase_orders o on o.id=l.purchase_order_id where o.status in('Draft','Order Sent','Partially Received')),'[]'::jsonb));
end $$;
revoke all on function public.erp_purchasing_snapshot_current(text),public.erp_barcode_catalog() from public,anon,authenticated;
grant execute on function public.erp_purchasing_snapshot_current(text),public.erp_barcode_catalog() to authenticated;
create or replace function public.erp_dashboard_summary(p_location text)returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare result jsonb;loc uuid;today date:=(now() at time zone 'America/Denver')::date;manager boolean:=public.current_role()='Manager';begin
 perform public.require_staff();select id into loc from public.locations where name=p_location;if loc is null then raise exception 'Unknown location';end if;
 with events as(
  select (s.created_at at time zone 'America/Denver')::date AS day,s.subtotal-s.discount AS net,s.cogs
  from public.sales s where s.status='Completed' and s.location_id=loc and s.created_at>=(today-6)::timestamp at time zone 'America/Denver' and s.created_at<=now()
  union all select h.sale_date,h.quantity*h.unit_price-h.discount,h.quantity*h.unit_cost from public.erp_history_menu(today-6,today,loc)h
  union all select (r.created_at at time zone 'America/Denver')::date,-r.refund_subtotal,
   -coalesce((select sum(l.cost_amount)from public.sales_return_lines l where l.return_id=r.id and l.disposition='Restock'),0)
  from public.sales_returns r join public.sales s on s.id=r.original_sale_id where s.location_id=loc and r.created_at>=(today-6)::timestamp at time zone 'America/Denver' and r.created_at<=now()
 ), days as(select d::date AS day from generate_series((today-6)::timestamp,today::timestamp,interval '1 day')d),
 totals as(select d.day,coalesce(sum(e.net),0) AS net,coalesce(sum(e.cogs),0) AS cogs from days d left join events e on e.day=d.day group by d.day)
 select jsonb_build_object('today',today,'daily',(select jsonb_agg(jsonb_build_object('day',day,'net',net)order by day)from totals),
 'todaySales',(select net from totals where day=today),'weekSales',(select sum(net)from totals),'weekProfit',case when manager then(select sum(net-cogs)from totals)else null end,
 'awaiting',(select count(*)from public.sales_orders where location_id=loc and status='Order Placed' and erp_prepared_at is null),
 'ready',(select count(*)from public.sales_orders where location_id=loc and status='Order Placed' and erp_prepared_at is not null),
 'owed',case when manager then(select coalesce(sum(case when i.paid_at is not null then 0 else greatest(0,i.amount-coalesce((select sum(amount)from public.erp_supplier_payments where invoice_id=i.id),0))end),0)from public.supplier_invoices i join public.purchase_orders p on p.id=i.purchase_order_id where p.ship_to_location_id=loc)else null end,
 'costWarnings',case when manager then(select count(*)from public.sales where location_id=loc and status='Completed' and subtotal>0 and cogs=0 and created_at>=(today-6)::timestamp at time zone 'America/Denver')else 0 end) into result;
 return result;
end $$;
revoke all on function public.erp_dashboard_summary(text) from public,anon,authenticated;
grant execute on function public.erp_dashboard_summary(text) to authenticated;
-- Sales notifications provide cross-device refresh; polling remains the fallback.
do $$begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime' and not puballtables) and
  not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='sales') then
  alter publication supabase_realtime add table public.sales;
 end if;
end $$;
-- All internal cache and posting helpers remain inaccessible to browser callers.
revoke all on function public.erp_retime_import_basis(),public.erp_mark_data_change(),public.erp_read_revision(),public.erp_pickup_unposted_action(uuid,text),public.erp_reporting_inventory_core(timestamptz,timestamptz),public.erp_reporting_inventory_fast(timestamptz,timestamptz),public.erp_reporting_base_fast(date,date,uuid),public.erp_reporting_quality_fast(date,date,uuid),public.erp_reporting_history_fast(date,date,uuid),public.erp_checkout_post_sale(uuid,jsonb,numeric,numeric,uuid) from public,anon,authenticated;
revoke all on function public.erp_reporting_current(date,date,uuid),public.erp_checkout_order(uuid,jsonb),public.erp_pickup_progress(uuid,text) from public,anon,authenticated;
grant execute on function public.erp_reporting_current(date,date,uuid),public.erp_checkout_order(uuid,jsonb),public.erp_pickup_progress(uuid,text) to authenticated;
insert into public.erp_data_changes default values;
notify pgrst,'reload schema';
commit;
select s.name,count(distinct p.id) AS purchase_orders,count(distinct i.id) AS invoices,
 coalesce(sum(case when i.paid_at is not null then 0 else greatest(0,i.amount-coalesce(pay.paid,0)) end),0) AS amount_owed
from public.suppliers s left join public.purchase_orders p on p.supplier_id=s.id
left join public.supplier_invoices i on i.purchase_order_id=p.id
left join lateral(select sum(amount) AS paid from public.erp_supplier_payments x where x.invoice_id=i.id)pay on true
group by s.id order by s.name;
