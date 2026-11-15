-- Shared purchasing, additive only. Existing functions and historical rows are retained.
begin;
alter table public.suppliers add column if not exists erp_active boolean not null default true,
 add column if not exists erp_notes text not null default '', add column if not exists erp_revision integer not null default 0;
alter table public.purchase_orders add column if not exists erp_quoted_lead_days integer,
 add column if not exists erp_payment_terms_days integer, add column if not exists erp_notes text not null default '',
 add column if not exists erp_legacy_received_at timestamptz, add column if not exists erp_revision integer not null default 0;
create table if not exists public.erp_purchase_receipts (
 id uuid primary key default gen_random_uuid(), purchase_order_id uuid not null references public.purchase_orders,
 received_on date not null, location_id uuid not null references public.locations, final_delivery boolean not null,
 tax_amount numeric not null default 0 check(tax_amount>=0), created_by uuid not null references auth.users,
 created_at timestamptz not null default now()
);
create table if not exists public.erp_purchase_receipt_lines (
 id uuid primary key default gen_random_uuid(), receipt_id uuid not null references public.erp_purchase_receipts,
 purchase_order_line_id uuid not null references public.purchase_order_lines,
 quantity_purchase numeric not null check(quantity_purchase>0), unit_price_purchase numeric not null check(unit_price_purchase>=0),
 transaction_id uuid not null unique references public.inventory_transactions,
 unique(receipt_id,purchase_order_line_id)
);
alter table public.supplier_invoices add column if not exists erp_receipt_id uuid unique references public.erp_purchase_receipts,
 add column if not exists erp_invoice_date date, add column if not exists erp_revision integer not null default 0;
create table if not exists public.erp_supplier_payments (
 id uuid primary key default gen_random_uuid(), invoice_id uuid not null references public.supplier_invoices,
 paid_on date not null, amount numeric not null check(amount>0), reference text not null check(length(trim(reference))>0),
 created_by uuid not null references auth.users, created_at timestamptz not null default now(), unique(invoice_id,reference)
);
create table if not exists public.erp_supplier_reviews (
 id uuid primary key default gen_random_uuid(), supplier_id uuid not null references public.suppliers,
 decision text not null check(decision in ('Keep','Watch','Replace')), notes text not null check(length(trim(notes))>0),
 created_by uuid not null references auth.users, created_at timestamptz not null default now()
);
create table if not exists public.erp_inventory_reviews (
 id uuid primary key default gen_random_uuid(), notes text not null, created_by uuid not null references auth.users,
 created_at timestamptz not null default now()
);
create table if not exists public.erp_purchasing_requests (
 id uuid primary key, action text not null, payload jsonb not null, result jsonb not null,
 created_by uuid not null references auth.users, created_at timestamptz not null default now()
);
create table if not exists public.erp_purchasing_audit (
 id uuid primary key default gen_random_uuid(), request_id uuid not null unique references public.erp_purchasing_requests deferrable initially deferred,
 action text not null, resource_id text, before_value jsonb, after_value jsonb,
 created_by uuid not null references auth.users, created_at timestamptz not null default now()
);
create table if not exists public.erp_purchasing_options (
 singleton boolean primary key default true check(singleton), order_cost numeric not null check(order_cost>=0),
 holding_rate numeric not null check(holding_rate>0 and holding_rate<=1), safety_days integer not null check(safety_days between 0 and 365),
 review_days integer not null check(review_days between 1 and 365), revision integer not null default 0
);
insert into public.erp_purchasing_options(singleton,order_cost,holding_rate,safety_days,review_days)
 values(true,coalesce((select (value#>>'{}')::numeric from public.settings where setting_key='ordering_cost'),25),
 coalesce((select (value#>>'{}')::numeric from public.settings where setting_key='annual_holding_rate'),.25),
 coalesce((select (value#>>'{}')::integer from public.settings where setting_key='safety_stock_days'),2),7) on conflict(singleton) do nothing;
create index if not exists erp_purchase_receipts_lookup_idx on public.erp_purchase_receipts(purchase_order_id);
create index if not exists erp_purchase_receipt_lines_lookup_idx on public.erp_purchase_receipt_lines(receipt_id);
create index if not exists erp_supplier_payments_lookup_idx on public.erp_supplier_payments(invoice_id);
create index if not exists erp_supplier_reviews_lookup_idx on public.erp_supplier_reviews(supplier_id,created_at desc);

-- New objects deny direct writes: all changes use the atomic, role-checked RPC below.
do $$ declare t text; begin
 foreach t in array array['erp_purchase_receipts','erp_purchase_receipt_lines','erp_supplier_payments','erp_supplier_reviews','erp_inventory_reviews','erp_purchasing_requests','erp_purchasing_audit','erp_purchasing_options'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from anon, authenticated',t);
 end loop;
end $$;

create or replace function public.erp_purchase_number(p_object jsonb,p_key text,p_min numeric,p_max numeric)
returns numeric language plpgsql immutable set search_path=pg_catalog,public as $$
declare n numeric; begin
 if jsonb_typeof(p_object->p_key) is distinct from 'number' then raise exception 'A numeric % is required',p_key; end if;
 n:=(p_object->>p_key)::numeric;
 if not(n between p_min and p_max) then raise exception '% is outside the allowed range',p_key; end if;
 return n;
end $$;

create or replace function public.erp_purchasing_snapshot() returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare result jsonb; begin
 if auth.uid() is null or public.current_role() is distinct from 'Manager' then raise exception 'Manager role required' using errcode='42501'; end if;
 -- One SQL statement gives each returned section the same MVCC snapshot.
 select jsonb_build_object(
  'version',1,'userId',auth.uid(),'today',(now() at time zone 'America/Denver')::date,
  'suppliers',coalesce((select jsonb_agg(to_jsonb(s) order by s.name) from public.suppliers s),'[]'::jsonb),
  'items',coalesce((select jsonb_agg(to_jsonb(i)||jsonb_build_object('made',exists(select 1 from public.bom_lines b where b.parent_sku=i.sku)) order by i.sku) from public.items i),'[]'::jsonb),
  'locations',coalesce((select jsonb_agg(to_jsonb(l) order by l.name) from public.locations l),'[]'::jsonb),
  'orders',coalesce((select jsonb_agg(to_jsonb(p) order by p.ordered_at desc,p.id) from public.purchase_orders p),'[]'::jsonb),
  'lines',coalesce((select jsonb_agg(to_jsonb(l) order by l.id) from public.purchase_order_lines l),'[]'::jsonb),
  'receipts',coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at,r.id) from public.erp_purchase_receipts r),'[]'::jsonb),
  'receiptLines',coalesce((select jsonb_agg(to_jsonb(l) order by l.id) from public.erp_purchase_receipt_lines l),'[]'::jsonb),
  'invoices',coalesce((select jsonb_agg(to_jsonb(i) order by i.due_at,i.id) from public.supplier_invoices i),'[]'::jsonb),
  'payments',coalesce((select jsonb_agg(to_jsonb(p) order by p.created_at,p.id) from public.erp_supplier_payments p),'[]'::jsonb),
  'reviews',coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at desc,r.id) from public.erp_supplier_reviews r),'[]'::jsonb),
  'inventoryReviews',coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at desc,r.id) from public.erp_inventory_reviews r),'[]'::jsonb),
  'audit',coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at desc,a.id) from public.erp_purchasing_audit a),'[]'::jsonb),
  'options',(select to_jsonb(o) from public.erp_purchasing_options o),
  'stock',coalesce((select jsonb_object_agg(s.item_sku,s.qty) from (select item_sku,sum(quantity) qty from public.inventory_transactions group by item_sku)s),'{}'::jsonb),
  'dailyUsage',coalesce((select jsonb_object_agg(s.item_sku,s.qty/180) from (
   select item_sku,sum(-quantity) qty from public.inventory_transactions where quantity<0 and transaction_type in ('Sale','Production Issue')
   and (occurred_at at time zone 'America/Denver')::date between (now() at time zone 'America/Denver')::date-179 and (now() at time zone 'America/Denver')::date group by item_sku)s),'{}'::jsonb)
 ) into result;
 return result;
end $$;

create or replace function public.erp_purchasing_write(p_request uuid,p_action text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
#variable_conflict use_variable
declare
 d date:=(now() at time zone 'America/Denver')::date; doc date; sent date; qty numeric; price numeric; amount numeric:=0; tax numeric:=0;
 lead_days integer; terms integer; wanted integer; paid numeric; have numeric; cost numeric; factor numeric; new_cost numeric;
 resource uuid; receipt uuid; tx uuid; line_id uuid; dest uuid; supplier_id uuid; request_row public.erp_purchasing_requests%rowtype;
 supplier public.suppliers%rowtype; po public.purchase_orders%rowtype; pol public.purchase_order_lines%rowtype;
 invoice public.supplier_invoices%rowtype; it public.items%rowtype; rec public.erp_purchase_receipts%rowtype;
 result jsonb; before_value jsonb; part jsonb; order_input jsonb; line_input jsonb; created jsonb:='[]'::jsonb;
 reason text; is_final boolean; complete boolean; latest timestamptz;
begin
 if auth.uid() is null or public.current_role() is distinct from 'Manager' then raise exception 'Manager role required' using errcode='42501'; end if;
 if p_request is null or jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'Request ID and object payload required'; end if;
 -- Serialize this API's writes, then lock the actual PO/item/invoice rows as well.
 perform pg_advisory_xact_lock(1179468369,1);
 select * into request_row from public.erp_purchasing_requests where id=p_request;
 if found then
  if request_row.created_by<>auth.uid() or request_row.action<>p_action or request_row.payload<>p_payload then raise exception 'Request ID was already used with different data'; end if;
  return request_row.result;
 end if;
 case p_action
 when 'save_supplier' then
  resource:=nullif(p_payload->>'id','')::uuid;
  if resource is not null then
   select * into supplier from public.suppliers where id=resource for update;
   if not found then raise exception 'Supplier not found'; end if;
   before_value:=to_jsonb(supplier);
   if supplier.erp_revision is distinct from (p_payload->>'revision')::integer then raise exception 'Supplier changed. Refresh and reopen the form.'; end if;
  else resource:=gen_random_uuid(); end if;
  if length(trim(coalesce(p_payload->>'name','')))=0 then raise exception 'Supplier name is required'; end if;
  lead_days:=public.erp_purchase_number(p_payload,'lead',0,365); terms:=public.erp_purchase_number(p_payload,'terms',0,365);
  if lead_days<>(p_payload->>'lead')::numeric or terms<>(p_payload->>'terms')::numeric then raise exception 'Lead time and terms must be whole days'; end if;
  if jsonb_typeof(p_payload->'active') is distinct from 'boolean' then raise exception 'Choose an active or archived status'; end if;
  insert into public.suppliers(id,name,contact_name,email,phone,address,quoted_lead_days,payment_terms_days,erp_active,erp_notes)
   values(resource,trim(p_payload->>'name'),trim(p_payload->>'contact'),trim(p_payload->>'email'),trim(p_payload->>'phone'),trim(p_payload->>'address'),lead_days,terms,(p_payload->>'active')::boolean,coalesce(p_payload->>'notes',''))
   on conflict(id) do update set name=excluded.name,contact_name=excluded.contact_name,email=excluded.email,phone=excluded.phone,address=excluded.address,
    quoted_lead_days=excluded.quoted_lead_days,payment_terms_days=excluded.payment_terms_days,erp_active=excluded.erp_active,erp_notes=excluded.erp_notes,erp_revision=public.suppliers.erp_revision+1;
  result:=jsonb_build_object('id',resource);
 when 'assign_supplier' then
  supplier_id:=(p_payload->>'supplierId')::uuid;
  if not exists(select 1 from public.suppliers where id=supplier_id and erp_active) then raise exception 'Choose an active supplier'; end if;
  select * into it from public.items where sku=p_payload->>'sku' and active for update;
  if not found or exists(select 1 from public.bom_lines where parent_sku=it.sku) then raise exception 'Choose an active purchased item'; end if;
  if it.supplier_id::text is distinct from nullif(p_payload->>'previousSupplierId','') then raise exception 'Item assignment changed. Refresh first.'; end if;
  before_value:=to_jsonb(it); update public.items set supplier_id=supplier_id,lead_days=(select quoted_lead_days from public.suppliers where id=supplier_id) where sku=it.sku;
  result:=jsonb_build_object('sku',it.sku,'supplierId',supplier_id);
 when 'create_orders' then
  if jsonb_typeof(p_payload->'orders') is distinct from 'array' or jsonb_array_length(p_payload->'orders') not between 1 and 100 then raise exception 'Include one or more purchase orders'; end if;
  for order_input in select value from jsonb_array_elements(p_payload->'orders') loop
   supplier_id:=(order_input->>'supplierId')::uuid; dest:=(order_input->>'locationId')::uuid; doc:=(order_input->>'date')::date;
   if doc is null or doc>d or not exists(select 1 from public.locations where id=dest) then raise exception 'Choose a location and an order date no later than today'; end if;
   select * into supplier from public.suppliers where id=supplier_id and erp_active for share;
   if not found then raise exception 'Choose an active supplier'; end if;
   if jsonb_typeof(order_input->'send') is distinct from 'boolean' then raise exception 'Choose draft or issued'; end if;
   if jsonb_typeof(order_input->'lines') is distinct from 'array' or jsonb_array_length(order_input->'lines') not between 1 and 100 then raise exception 'Add at least one order line'; end if;
   if exists(select 1 from jsonb_array_elements(order_input->'lines')l group by l->>'sku' having count(*)>1) then raise exception 'Combine duplicate SKUs'; end if;
   resource:=gen_random_uuid();
   insert into public.purchase_orders(id,po_no,supplier_id,ship_to_location_id,ordered_at,expected_at,status,created_by,erp_quoted_lead_days,erp_payment_terms_days,erp_notes)
    values(resource,'PO-'||upper(replace(resource::text,'-','')),supplier_id,dest,(doc::text||' 12:00 America/Denver')::timestamptz,
     ((doc+supplier.quoted_lead_days)::text||' 12:00 America/Denver')::timestamptz,
     case when (order_input->>'send')::boolean then 'Order Sent' else 'Draft' end,auth.uid(),supplier.quoted_lead_days,supplier.payment_terms_days,coalesce(order_input->>'notes',''));
   for line_input in select value from jsonb_array_elements(order_input->'lines') loop
    select * into it from public.items where sku=line_input->>'sku' and active;
    if not found or it.supplier_id is distinct from supplier_id or exists(select 1 from public.bom_lines where parent_sku=it.sku) then raise exception 'Item is not a purchased item assigned to this supplier'; end if;
    qty:=public.erp_purchase_number(line_input,'qty',.000001,1000000000); price:=public.erp_purchase_number(line_input,'price',0,1000000000);
    insert into public.purchase_order_lines(purchase_order_id,item_sku,quantity_purchase,unit_price_purchase)values(resource,it.sku,qty,price);
   end loop;
   if (select sum(quantity_purchase*unit_price_purchase) from public.purchase_order_lines where purchase_order_id=resource)>1000000000000 then raise exception 'Order value is too large'; end if;
   created:=created||jsonb_build_array(resource);
  end loop;
  result:=jsonb_build_object('ids',created);
 when 'save_review' then
  resource:=(p_payload->>'supplierId')::uuid;
  if length(trim(coalesce(p_payload->>'notes','')))=0 then raise exception 'Enter review notes'; end if;
  insert into public.erp_supplier_reviews(supplier_id,decision,notes,created_by)values(resource,p_payload->>'decision',trim(p_payload->>'notes'),auth.uid());
  result:=jsonb_build_object('id',resource);
 when 'inventory_review' then
  insert into public.erp_inventory_reviews(notes,created_by)values(coalesce(p_payload->>'notes',''),auth.uid()) returning id into resource;
  result:=jsonb_build_object('id',resource);
 when 'save_options' then
  perform 1 from public.erp_purchasing_options where revision=(p_payload->>'revision')::integer for update;
  if not found then raise exception 'Ordering options changed. Refresh first.'; end if;
  qty:=public.erp_purchase_number(p_payload,'safetyDays',0,365); price:=public.erp_purchase_number(p_payload,'reviewDays',1,365);
  if qty<>trunc(qty) or price<>trunc(price) then raise exception 'Safety and review days must be whole numbers'; end if;
  update public.erp_purchasing_options set order_cost=public.erp_purchase_number(p_payload,'orderCost',0,1000000),
   holding_rate=public.erp_purchase_number(p_payload,'holdingRate',.000001,1),safety_days=qty,review_days=price,revision=revision+1;
  result:=jsonb_build_object('saved',true);
 when 'pay_invoice' then
  resource:=(p_payload->>'id')::uuid; doc:=(p_payload->>'date')::date;
  select * into invoice from public.supplier_invoices where id=resource for update;
  if not found then raise exception 'Invoice not found'; end if;
  before_value:=to_jsonb(invoice);
  if invoice.erp_revision is distinct from (p_payload->>'revision')::integer then raise exception 'Invoice changed. Refresh and reopen payment.'; end if;
  select coalesce(sum(p.amount),0) into paid from public.erp_supplier_payments p where p.invoice_id=resource;
  amount:=round(public.erp_purchase_number(p_payload,'amount',.01,1000000000000),2);
  if invoice.paid_at is not null or amount>round(invoice.amount-paid,2) then raise exception 'Payment exceeds the remaining invoice balance'; end if;
  if doc is null or doc<coalesce(invoice.erp_invoice_date,(invoice.created_at at time zone 'America/Denver')::date) or doc>d then raise exception 'Payment date must be between invoice date and today'; end if;
  insert into public.erp_supplier_payments(invoice_id,paid_on,amount,reference,created_by)values(resource,doc,amount,trim(p_payload->>'reference'),auth.uid());
  update public.supplier_invoices set paid_at=case when paid+amount>=invoice.amount-.005 then doc else null end,erp_revision=erp_revision+1 where id=resource;
  result:=jsonb_build_object('id',resource,'paid',amount);
 else
  -- Remaining operations act on exactly one existing PO and reject stale forms.
  resource:=(p_payload->>'id')::uuid;
  select * into po from public.purchase_orders where id=resource for update;
  if not found then raise exception 'Purchase order not found'; end if;
  before_value:=to_jsonb(po);
  if po.erp_revision is distinct from (p_payload->>'revision')::integer then raise exception 'Purchase order changed. Refresh and reopen the form.'; end if;
  case p_action
  when 'send_order' then
   if po.status<>'Draft' then raise exception 'Only a draft can be issued'; end if;
   select * into supplier from public.suppliers where id=po.supplier_id and erp_active for share;
   if not found then raise exception 'Supplier is archived or missing'; end if;
   update public.purchase_orders set status='Order Sent',ordered_at=(d::text||' 12:00 America/Denver')::timestamptz,
    expected_at=((d+supplier.quoted_lead_days)::text||' 12:00 America/Denver')::timestamptz,
    erp_quoted_lead_days=supplier.quoted_lead_days,erp_payment_terms_days=supplier.payment_terms_days,erp_revision=erp_revision+1 where id=resource;
  when 'receive_order' then
   if po.status not in ('Order Sent','Partially Received') then raise exception 'Purchase order is not awaiting delivery'; end if;
   doc:=(p_payload->>'date')::date; dest:=(p_payload->>'locationId')::uuid;
   if doc is null or doc<(po.ordered_at at time zone 'America/Denver')::date or doc>d then raise exception 'Receipt date must be between order date and today'; end if;
   if not exists(select 1 from public.locations where id=dest) then raise exception 'Choose a receiving location'; end if;
   if jsonb_typeof(p_payload->'final') is distinct from 'boolean' then raise exception 'Choose final or partial delivery'; end if;
   if jsonb_typeof(p_payload->'lines') is distinct from 'array' or jsonb_array_length(p_payload->'lines') not between 1 and 100 then raise exception 'Enter delivery lines'; end if;
   if exists(select 1 from jsonb_array_elements(p_payload->'lines')l group by l->>'id' having count(*)>1) then raise exception 'Each PO line may occur once'; end if;
   tax:=round(public.erp_purchase_number(p_payload,'tax',0,1000000000000),2);
   receipt:=gen_random_uuid();
   insert into public.erp_purchase_receipts(id,purchase_order_id,received_on,location_id,final_delivery,tax_amount,created_by)
    values(receipt,resource,doc,dest,false,tax,auth.uid());
   for line_input in select value from jsonb_array_elements(p_payload->'lines') order by value->>'id' loop
    line_id:=(line_input->>'id')::uuid;
    select * into pol from public.purchase_order_lines where id=line_id and purchase_order_id=resource for update;
    if not found then raise exception 'Order line not found'; end if;
    qty:=public.erp_purchase_number(line_input,'qty',0,1000000000); price:=public.erp_purchase_number(line_input,'price',0,1000000000);
    if qty=0 then continue; end if;
    if qty>pol.quantity_purchase-pol.quantity_received_purchase then raise exception 'Received quantity exceeds the remaining order'; end if;
    select * into it from public.items where sku=pol.item_sku for update;
    factor:=it.conversion_factor;
    select greatest(0,coalesce(sum(quantity),0)) into have from public.inventory_transactions where item_sku=it.sku;
    new_cost:=(have*it.unit_cost+qty*price)/(have+qty*factor);
    update public.items set unit_cost=new_cost where sku=it.sku;
    update public.purchase_order_lines set quantity_received_purchase=quantity_received_purchase+qty where id=line_id;
    insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type,reference_document,user_id,occurred_at,metadata)
     values(it.sku,dest,qty*factor,price/factor,'Receipt',po.po_no,auth.uid(),(doc::text||' 12:00 America/Denver')::timestamptz,
      jsonb_build_object('erp_receipt_id',receipt,'purchase_order_line_id',line_id)) returning id into tx;
    insert into public.erp_purchase_receipt_lines(receipt_id,purchase_order_line_id,quantity_purchase,unit_price_purchase,transaction_id) values(receipt,line_id,qty,price,tx);
    amount:=amount+qty*price;
   end loop;
   if not exists(select 1 from public.erp_purchase_receipt_lines where receipt_id=receipt) then raise exception 'Enter a positive quantity on at least one line'; end if;
   if round(amount,2)+tax>1000000000000 then raise exception 'Invoice value is too large'; end if;
   select not exists(select 1 from public.purchase_order_lines where purchase_order_id=resource and quantity_received_purchase<quantity_purchase) into complete;
   complete:=complete or (p_payload->>'final')::boolean;
   update public.erp_purchase_receipts set final_delivery=complete where id=receipt;
   terms:=coalesce(po.erp_payment_terms_days,(select payment_terms_days from public.suppliers where id=po.supplier_id));
   update public.purchase_orders set status=case when complete then 'Received' else 'Partially Received' end,
    erp_legacy_received_at=case when not exists(select 1 from public.erp_purchase_receipts where purchase_order_id=resource and id<>receipt) then po.received_at else po.erp_legacy_received_at end,
    received_at=greatest(po.received_at,(doc::text||' 12:00 America/Denver')::timestamptz),
    erp_payment_terms_days=terms,erp_quoted_lead_days=coalesce(erp_quoted_lead_days,greatest(0,(expected_at at time zone 'America/Denver')::date-(ordered_at at time zone 'America/Denver')::date)),erp_revision=erp_revision+1 where id=resource;
   insert into public.supplier_invoices(purchase_order_id,amount,due_at,erp_invoice_date,erp_receipt_id)values(resource,round(amount,2)+tax,doc+terms,doc,receipt);
  when 'finish_short' then
   reason:=trim(coalesce(p_payload->>'reason',''));
   if po.status<>'Partially Received' or reason='' then raise exception 'A partial receipt and reason are required'; end if;
   update public.purchase_orders set status='Received',erp_notes=erp_notes||E'\nFinal short delivery: '||reason,erp_revision=erp_revision+1 where id=resource;
   update public.erp_purchase_receipts set final_delivery=true where id=(select id from public.erp_purchase_receipts where purchase_order_id=resource order by received_on desc,created_at desc,id limit 1);
  when 'close_order' then
   if po.status<>'Received' then raise exception 'Finish receiving the order first'; end if;
   if exists(select 1 from public.supplier_invoices i where i.purchase_order_id=resource and i.paid_at is null and i.amount>coalesce((select sum(p.amount) from public.erp_supplier_payments p where p.invoice_id=i.id),0)+.005) then raise exception 'Pay remaining invoice balances before closing'; end if;
   update public.purchase_orders set status='Closed',erp_revision=erp_revision+1 where id=resource;
  when 'correct_order' then
   if po.status='Draft' or length(trim(coalesce(p_payload->>'reason','')))=0 then raise exception 'An issued order and correction reason are required'; end if;
   doc:=(p_payload->>'date')::date; lead_days:=public.erp_purchase_number(p_payload,'lead',0,365);
   if doc is null or doc>d or lead_days<>(p_payload->>'lead')::numeric then raise exception 'Enter a valid sent date and whole quoted lead days'; end if;
   if jsonb_typeof(p_payload->'lines') is distinct from 'array' or jsonb_array_length(p_payload->'lines')<>(select count(*) from public.purchase_order_lines where purchase_order_id=resource) then raise exception 'Include every order line'; end if;
   if exists(select 1 from jsonb_array_elements(p_payload->'lines')l group by l->>'id' having count(*)>1) then raise exception 'Include each order line once'; end if;
   before_value:=before_value||jsonb_build_object('lines',(select jsonb_agg(to_jsonb(l)) from public.purchase_order_lines l where purchase_order_id=resource),
    'receipts',(select coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb) from public.erp_purchase_receipts r where purchase_order_id=resource));
   for line_input in select value from jsonb_array_elements(p_payload->'lines') loop
    select * into pol from public.purchase_order_lines where id=(line_input->>'id')::uuid and purchase_order_id=resource for update;
    if not found then raise exception 'Unknown order line'; end if;
    qty:=public.erp_purchase_number(line_input,'qty',.000001,1000000000);
    if qty<pol.quantity_received_purchase then raise exception 'Ordered quantity cannot be less than received quantity'; end if;
    update public.purchase_order_lines set quantity_purchase=qty where id=pol.id;
   end loop;
   if jsonb_typeof(p_payload->'receipts') is distinct from 'array' or jsonb_array_length(p_payload->'receipts')<>(select count(*) from public.erp_purchase_receipts where purchase_order_id=resource) then raise exception 'Include every audited receipt'; end if;
   if exists(select 1 from jsonb_array_elements(p_payload->'receipts')r group by r->>'id' having count(*)>1) then raise exception 'Include each receipt once'; end if;
   if (case when exists(select 1 from public.erp_purchase_receipts where purchase_order_id=resource) then po.erp_legacy_received_at else po.received_at end at time zone 'America/Denver')::date<doc then raise exception 'Sent date cannot be after a historical legacy receipt'; end if;
   for part in select value from jsonb_array_elements(p_payload->'receipts') loop
    select * into rec from public.erp_purchase_receipts where id=(part->>'id')::uuid and purchase_order_id=resource for update;
    if not found then raise exception 'Unknown receipt'; end if;
    sent:=(part->>'date')::date;
    if sent is null or sent<doc or sent>d then raise exception 'Receipt date must be between sent date and today'; end if;
    if exists(select 1 from public.supplier_invoices i where i.erp_receipt_id=rec.id and (i.paid_at<sent or exists(select 1 from public.erp_supplier_payments p where p.invoice_id=i.id and p.paid_on<sent))) then raise exception 'Receipt cannot be dated after an existing payment'; end if;
    update public.erp_purchase_receipts set received_on=sent where id=rec.id;
    update public.supplier_invoices set erp_invoice_date=sent,due_at=sent+coalesce(po.erp_payment_terms_days,(select payment_terms_days from public.suppliers where id=po.supplier_id)),erp_revision=erp_revision+1 where erp_receipt_id=rec.id;
    update public.inventory_transactions set occurred_at=(sent::text||' 12:00 America/Denver')::timestamptz where id in(select transaction_id from public.erp_purchase_receipt_lines where receipt_id=rec.id);
   end loop;
   select greatest(po.erp_legacy_received_at,max((received_on::text||' 12:00 America/Denver')::timestamptz)) into latest from public.erp_purchase_receipts where purchase_order_id=resource;
   update public.purchase_orders set ordered_at=(doc::text||' 12:00 America/Denver')::timestamptz,
    expected_at=((doc+lead_days)::text||' 12:00 America/Denver')::timestamptz,erp_quoted_lead_days=lead_days,
    received_at=coalesce(latest,po.received_at),erp_revision=erp_revision+1,
    status=case when status='Partially Received' and not exists(select 1 from public.purchase_order_lines where purchase_order_id=resource and quantity_received_purchase<quantity_purchase) then 'Received' else status end where id=resource;
  else raise exception 'Unknown purchasing action';
  end case;
  result:=jsonb_build_object('id',resource,'receiptId',receipt);
 end case;
 insert into public.erp_purchasing_requests(id,action,payload,result,created_by)values(p_request,p_action,p_payload,result,auth.uid());
 insert into public.erp_purchasing_audit(request_id,action,resource_id,before_value,after_value,created_by)
 values(p_request,p_action,coalesce(resource::text,p_payload->>'sku'),before_value,jsonb_build_object('input',p_payload,'result',result),auth.uid());
 return result;
end $$;
revoke all on function public.erp_purchase_number(jsonb,text,numeric,numeric) from public,anon,authenticated;
revoke all on function public.erp_purchasing_snapshot() from public,anon;
revoke all on function public.erp_purchasing_write(uuid,text,jsonb) from public,anon;
grant execute on function public.erp_purchasing_snapshot() to authenticated;
grant execute on function public.erp_purchasing_write(uuid,text,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
