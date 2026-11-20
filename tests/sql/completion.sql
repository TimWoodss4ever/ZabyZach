-- DISPOSABLE DATABASE ONLY. Never run this test script in the live project.
\set ON_ERROR_STOP on
\timing on
-- Bound each statement so a regression reports an error instead of running for hours.
set statement_timeout='5min';
set lock_timeout='30s';
\echo 'Completion: capture original records and balances'
create temporary table completion_original_rows(table_name text,row_value jsonb);
do $$declare t record;begin
 for t in select tablename from pg_tables where schemaname='public' loop
  execute format('insert into completion_original_rows select %L,to_jsonb(t) from public.%I t',t.tablename,t.tablename);
 end loop;
end $$;
create index completion_original_rows_table_idx on completion_original_rows(table_name);
analyze completion_original_rows;
create temporary table completion_stock as select item_sku,location_id,sum(quantity) AS qty from public.inventory_transactions group by item_sku,location_id;
select set_config('request.jwt.claim.sub',(select user_id::text from public.profiles where role='Manager' limit 1),false);
create temporary table completion_before_report as select public.erp_reporting_snapshot_with_history(
 (select from_date from public.erp_sample_history_batches where id='menu-history-v1'),(now() at time zone 'America/Denver')::date) AS data;
create temporary table completion_before_usage as
 select 'recorded'::text AS kind,coalesce(jsonb_agg(to_jsonb(u)order by item_sku,location_id),'[]'::jsonb) AS rows
 from public.erp_inventory_recorded_usage((((now() at time zone 'America/Denver')::date-180)::timestamp at time zone 'UTC'))u
 union all select 'history',coalesce(jsonb_agg(to_jsonb(u)order by item_sku,location_id),'[]'::jsonb) from public.erp_inventory_sample_usage()u;
\echo 'Completion: install linked purchasing and checkout migration'
\ir ../../supabase/migrations/202611170004_erp_completion.sql
-- Old data must stay intact; additions must not change current stock balances.
\echo 'Completion: compare all original rows by table (no repeated per-row scans)'
do $$declare t record;changed boolean;begin
 for t in select distinct table_name from completion_original_rows order by table_name loop
  raise notice 'Checking preserved records in %',t.table_name;
  execute format('select exists(select 1 from (
   select row_value from completion_original_rows where table_name=$1
   except all
   select to_jsonb(current_row) from public.%I current_row
  ) missing_original_rows)',t.table_name) into changed using t.table_name;
  if changed then raise exception 'Existing team record changed or removed in %',t.table_name;end if;
 end loop;
end $$;
select public.ci_assert(not exists(with after_stock as(select item_sku,location_id,sum(quantity) AS qty from public.inventory_transactions group by item_sku,location_id)
 select 1 from completion_stock b full join after_stock a using(item_sku,location_id) where coalesce(a.qty,0)<>coalesce(b.qty,0)),'historical import restocked current inventory');
select public.ci_assert(not exists(select 1 from public.suppliers s where s.name in('Wasatch Dairy Co.','Valley Meats','Mountain Produce','Summit Dry Goods','Beehive Packaging','Cascade Beverage & Sides','Provo Water Utility') and not exists(select 1 from public.purchase_orders p where p.supplier_id=s.id and p.po_no like 'PO-H-%')),'one of seven suppliers has no PO history');
select public.ci_assert((select count(*)>100 from public.purchase_orders where po_no like 'PO-H-%'),'PO history is incomplete');
select public.ci_assert((select count(*)>7 from public.supplier_invoices where paid_at is null),'payables still contain only one bill');
select public.ci_assert(exists(select 1 from public.supplier_invoices where paid_at is not null) and exists(select 1 from public.supplier_invoices i where paid_at is null and exists(select 1 from public.erp_supplier_payments p where p.invoice_id=i.id)),'paid or partial-payment history missing');
select public.ci_assert(not exists(select 1 from public.supplier_invoices i join public.purchase_orders p on p.id=i.purchase_order_id where p.po_no like 'PO-H-%' and i.due_at<>i.erp_invoice_date+p.erp_payment_terms_days),'invoice due dates do not match saved terms');
select public.ci_assert(not exists(select 1 from public.supplier_invoices i join public.purchase_orders p on p.id=i.purchase_order_id where p.po_no like 'PO-H-%' and i.amount<>(select sum(l.quantity_purchase*l.unit_price_purchase)from public.erp_purchase_receipt_lines l where l.receipt_id=i.erp_receipt_id)),'invoice amount differs from delivered goods');
select public.ci_assert(not exists(select 1 from public.erp_purchase_receipt_lines r join public.inventory_transactions t on t.id=r.transaction_id join public.items i on i.sku=t.item_sku where t.metadata->>'erp_import_batch'='purchasing-ledger-v1' and t.quantity<>r.quantity_purchase*i.conversion_factor),'receipt lines do not match stock postings');
select public.ci_assert(not exists(select 1 from public.purchase_orders p where p.po_no like 'PO-H-%' and (p.expected_at<>(((p.ordered_at at time zone 'America/Denver')::date+p.erp_quoted_lead_days)::timestamp at time zone 'America/Denver') or p.received_at<p.ordered_at)),'invalid expected or actual dates');
select public.ci_assert(not exists(select 1 from public.erp_supplier_payments p join public.supplier_invoices i on i.id=p.invoice_id where p.paid_on<i.erp_invoice_date or p.paid_on>(now() at time zone 'America/Denver')::date),'invalid payment chronology');
select public.ci_assert(not exists(select 1 from public.supplier_invoices i where coalesce((select sum(amount)from public.erp_supplier_payments where invoice_id=i.id),0)>i.amount),'overpaid invoice');
begin;
create temporary table corrected_historical_receipt on commit drop as select id from public.inventory_transactions where transaction_type='Receipt' and metadata->>'erp_import_batch'='purchasing-ledger-v1' limit 1;
update public.inventory_transactions set occurred_at=occurred_at+interval '1 hour' where id=(select id from corrected_historical_receipt);
select public.ci_assert(exists(select 1 from public.inventory_transactions t join public.inventory_transactions b on b.metadata->>'paired_transaction'=t.id::text where t.id=(select id from corrected_historical_receipt) and b.occurred_at=t.occurred_at+interval '1 second'),'receipt correction detached opening-stock reconciliation');
rollback;
create temporary table completion_after_usage as
 select 'recorded'::text AS kind,coalesce(jsonb_agg(to_jsonb(u)order by item_sku,location_id),'[]'::jsonb) AS rows
 from public.erp_inventory_recorded_usage((((now() at time zone 'America/Denver')::date-180)::timestamp at time zone 'UTC'))u
 union all select 'history',coalesce(jsonb_agg(to_jsonb(u)order by item_sku,location_id),'[]'::jsonb) from public.erp_inventory_sample_usage()u;
select public.ci_assert(not exists(select 1 from completion_before_usage b full join completion_after_usage a using(kind) where a.rows is distinct from b.rows),'purchasing history changed the team usage/reorder inputs');
\echo 'Completion: verify recorded profit, inventory valuation, reports and access'
-- Report P&L and recorded valuation remain unchanged by a historical purchasing import.
create temporary table completion_after_report as select public.erp_reporting_current(
 (select from_date from public.erp_sample_history_batches where id='menu-history-v1'),(now() at time zone 'America/Denver')::date) AS data;
select public.ci_assert((select a.data->'pnl'=b.data->'pnl' from completion_after_report a cross join completion_before_report b),'history import changed existing P&L');
select public.ci_assert((select a.data->'inventory'=b.data->'inventory' from completion_after_report a cross join completion_before_report b),'history import changed recorded valuation');
select public.ci_assert(not exists(select 1 from completion_after_report,jsonb_array_elements(data->'suppliers')s where s->>'name' in('Wasatch Dairy Co.','Valley Meats','Mountain Produce','Summit Dry Goods','Beehive Packaging','Cascade Beverage & Sides','Provo Water Utility') and ((s->>'deliveries')::integer=0 or (s->>'actual') is null or(s->>'quoted')is null)),'supplier performance still lacks source history');
select public.ci_assert((select count(*)>0 from public.erp_read_cache),'report did not populate cache');
create temporary table completion_first_tokens as select public.erp_read_revision() AS revision;
select public.ci_assert((public.erp_purchasing_snapshot_current((select revision from completion_first_tokens))->>'unchanged')::boolean,'unchanged purchasing request still downloads the full dataset');
select public.ci_assert(jsonb_array_length(public.erp_barcode_catalog()->'items')=(select count(*)from public.items where active),'barcode catalog truncated or missing active menu items');
select public.ci_assert(not has_function_privilege('authenticated','public.erp_checkout_post_sale(uuid,jsonb,numeric,numeric,uuid)','EXECUTE'),'private posting engine exposed');
\echo 'Completion: verify safe repeated installation'
-- Reinstall preserves imported/user records and does not regenerate past balances.
create temporary table completion_purchase_digest as select md5(string_agg(to_jsonb(p)::text,'' order by id)) AS digest from public.purchase_orders p;
create temporary table completion_payment_digest as select md5(string_agg(to_jsonb(p)::text,'' order by id)) AS digest from public.erp_supplier_payments p;
\ir ../../supabase/migrations/202611170004_erp_completion.sql
select public.ci_assert((select digest=(select md5(string_agg(to_jsonb(p)::text,'' order by id))from public.purchase_orders p)from completion_purchase_digest),'reinstall changed or duplicated purchase orders');
select public.ci_assert((select digest=(select md5(string_agg(to_jsonb(p)::text,'' order by id))from public.erp_supplier_payments p)from completion_payment_digest),'reinstall reset payment history');
-- Apply final order migrations in production order after completion installation.
\ir ../../supabase/migrations/202611180001_sales_orders_pos.sql
\ir ../../supabase/migrations/202611190001_mrp_confirmed_demand.sql
\ir ../../supabase/migrations/202611190002_mrp_planning_hardening.sql
\ir ../../supabase/migrations/202611200001_stock_visibility_guard.sql
\ir ../../supabase/migrations/202611210001_customer_availability.sql
\echo 'Completion: verify phone demand, prepare-time posting, collection and shared financial totals'
-- Phone confirmation creates demand; preparation posts revenue/cost/stock once.
insert into auth.users(id) values('f3000000-0000-0000-0000-000000000001')on conflict do nothing;
insert into public.profiles(user_id,role)values('f3000000-0000-0000-0000-000000000001','Customer')on conflict(user_id)do nothing;
insert into public.items(sku,name,category,barcode,base_unit,purchase_unit,conversion_factor,unit_cost,selling_price,lead_days)
 values('FINAL-DRINK','Checkout test drink','Beverage','FINAL-DRINK','each','case',24,1,3,1);
create temporary table completion_location as select id,name from public.locations where can_sell order by id limit 1;
insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type,reference_document)
 select 'FINAL-DRINK',id,10,1,'Receipt','CI checkout stock'from completion_location;
select set_config('request.jwt.claim.sub',(select user_id::text from public.profiles where role='Manager' limit 1),false);
create temporary table completion_dashboard_before as select public.erp_dashboard_summary((select name from completion_location)) AS data;
create temporary table completion_checkout_payload as select jsonb_build_object('name','Phone customer','phone','8015550100','location',name,'pickup',((now() at time zone 'America/Denver')+interval '1 day')::text||' America/Denver',
 'lines',jsonb_build_array(jsonb_build_object('sku','FINAL-DRINK','qty',2,'price',0))) AS payload from completion_location;
select set_config('request.jwt.claim.sub','f3000000-0000-0000-0000-000000000001',false);
create temporary table completion_checkout as select public.erp_checkout_order('f3000000-0000-0000-0000-000000000002',(select payload from completion_checkout_payload)) AS data;
select public.ci_assert((select not (data->>'posted')::boolean and (data->>'sale_id')is null from completion_checkout),'phone confirmation posted before preparation');
select public.ci_assert((select sum(quantity)=10 from public.inventory_transactions where item_sku='FINAL-DRINK'),'phone confirmation changed stock');
select public.ci_assert(not exists(select 1 from public.sales_orders where id='f3000000-0000-0000-0000-000000000002' and erp_sale_id is not null),'phone confirmation posted a sale');
select public.erp_checkout_order('f3000000-0000-0000-0000-000000000002',(select payload from completion_checkout_payload));
select public.ci_assert((select count(*)=1 from public.sales_orders where id='f3000000-0000-0000-0000-000000000002') and (select sum(quantity)=10 from public.inventory_transactions where item_sku='FINAL-DRINK'),'confirmation retry duplicated demand or posted stock');
select set_config('request.jwt.claim.sub',(select user_id::text from public.profiles where role='Manager' limit 1),false);
-- A cached old staff page can advance physical progress but cannot cancel a fulfilled sale.
select public.erp_pickup_action('f3000000-0000-0000-0000-000000000002','prepare');
select public.ci_assert((select subtotal=6 and cogs=2 and payment_method='Card (simulated)' from public.sales where id=(select erp_sale_id from public.sales_orders where id='f3000000-0000-0000-0000-000000000002')),'preparation omitted server price, COGS or simulated tender');
select public.erp_pickup_progress('f3000000-0000-0000-0000-000000000002','prepare');
select public.erp_pickup_progress('f3000000-0000-0000-0000-000000000002','fulfill');
select public.erp_pickup_progress('f3000000-0000-0000-0000-000000000002','fulfill');
do $$begin begin perform public.erp_pickup_action('f3000000-0000-0000-0000-000000000002','cancel');raise exception 'Fulfilled order was cancelled';exception when raise_exception then if sqlerrm='Fulfilled order was cancelled' then raise;end if;end;end $$;
select public.erp_pickup_progress('f3000000-0000-0000-0000-000000000002','close');
select public.ci_assert((select status='Closed' from public.sales_orders where id='f3000000-0000-0000-0000-000000000002'),'fulfilled order did not close');
select public.ci_assert((select sum(quantity)=8 from public.inventory_transactions where item_sku='FINAL-DRINK'),'physical collection deducted inventory again');
select public.ci_assert((select (public.erp_dashboard_summary((select name from completion_location))->>'todaySales')::numeric-(data->>'todaySales')::numeric=6 from completion_dashboard_before),'shared dashboard did not update after phone checkout');
select public.ci_assert((select (public.erp_dashboard_summary((select name from completion_location))->>'weekProfit')::numeric-(data->>'weekProfit')::numeric=4 from completion_dashboard_before),'dashboard profit does not reflect server costs');
-- The newer main POS/rewards wrapper must continue to post once after the
-- completion engine is installed, independently of the phone checkout route.
\echo 'Completion: verify compatibility with the latest shared POS rewards wrapper'
create temporary table completion_staff_checkout as select public.erp_pos_sale(
 'f3000000-0000-0000-0000-000000000003',(select id from completion_location),
 '[{"sku":"FINAL-DRINK","qty":1}]'::jsonb,0,'8015550188','Combined checkout customer',false,'Card (simulated)') AS data;
select public.ci_assert((select (data->>'subtotal')::numeric=3 and (data->>'cogs')::numeric=1 and (data->>'rewards_earned')::integer=3 and data->>'payment_method'='Card (simulated)' and data->>'receipt_no' like 'Order %' from completion_staff_checkout),'combined POS checkout lost revenue, costs or rewards');
select public.erp_pos_sale('f3000000-0000-0000-0000-000000000003',(select id from completion_location),'[{"sku":"FINAL-DRINK","qty":1}]'::jsonb,0,'8015550188','Combined checkout customer',false,'Card (simulated)');
select public.ci_assert((select sum(quantity)=7 from public.inventory_transactions where item_sku='FINAL-DRINK'),'combined POS retry posted stock twice');
-- Null identity and customer callers cannot obtain management reports or post progress.
select set_config('request.jwt.claim.sub','f3000000-0000-0000-0000-000000000001',false);
do $$begin begin perform public.erp_reporting_current(current_date-1,current_date);raise exception 'Customer management report access allowed';exception when insufficient_privilege then null;end;
 begin perform public.erp_pickup_progress('f3000000-0000-0000-0000-000000000002','fulfill');raise exception 'Customer staff action allowed';exception when insufficient_privilege then null;end;end $$;
select set_config('request.jwt.claim.sub','',false);
do $$begin begin perform public.erp_barcode_catalog();raise exception 'Anonymous barcode access allowed';exception when insufficient_privilege then null;end;
 begin perform public.erp_dashboard_summary('Provo Campus Store');raise exception 'Anonymous dashboard access allowed';exception when insufficient_privilege then null;end;end $$;
select 'PASS: linked supplier history, invoices and payments; preserved team records and reconciled stock/valuation/P&L; import idempotency; report cache and compact refresh; immediate phone sale with exactly-once costs/stock; collection safety; shared dashboard; permissions.';

reset lock_timeout;
reset statement_timeout;
\timing off
