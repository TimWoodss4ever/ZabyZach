-- Disposable CI database only. Never run this fixture against Supabase.
\set ON_ERROR_STOP on
\timing on
create temporary table usage_before_counts as
 select (select count(*) from public.sales) sales,
        (select count(*) from public.inventory_transactions) transactions,
        (select count(*) from public.erp_sample_material_history) sample_history;
\ir ../../supabase/migrations/202611170002_inventory_usage_performance.sql
select public.ci_assert(
 (select sales=(select count(*) from public.sales)
    and transactions=(select count(*) from public.inventory_transactions)
    and sample_history=(select count(*) from public.erp_sample_material_history)
  from usage_before_counts),
 'usage performance migration changed business rows');
select public.ci_assert(not has_function_privilege('anon','public.erp_inventory_recorded_usage(timestamptz)','EXECUTE'),'anonymous recorded usage access');
select public.ci_assert(has_function_privilege('authenticated','public.erp_inventory_recorded_usage(timestamptz)','EXECUTE'),'authenticated recorded usage grant missing');
select public.ci_assert(not has_function_privilege('anon','public.erp_inventory_sample_usage()','EXECUTE'),'anonymous sample usage access');
\ir ../../supabase/migrations/202611170002_inventory_usage_performance.sql
select public.ci_assert(
 (select sales=(select count(*) from public.sales)
    and transactions=(select count(*) from public.inventory_transactions)
    and sample_history=(select count(*) from public.erp_sample_material_history)
  from usage_before_counts),
 'repeat usage performance migration changed business rows');

begin;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
with days as (
 select d::date as trading_day from generate_series(
  (now() at time zone 'America/Denver')::date-179,
  (now() at time zone 'America/Denver')::date,interval '1 day') d
), stores as (select id as location_id from public.locations where can_sell)
insert into public.sales(receipt_no,location_id,subtotal,discount,tax,total,cogs,created_at)
select 'INVPERF-S-'||trading_day||'-'||location_id||'-'||n,location_id,20,0,1.45,21.45,8,
 trading_day::timestamp at time zone 'America/Denver'+interval '12 hours'
from days cross join stores cross join generate_series(1,30) n
where (trading_day-(now() at time zone 'America/Denver')::date+180)%3=0;
with days as (
 select d::date as trading_day from generate_series(
  (now() at time zone 'America/Denver')::date-179,
  (now() at time zone 'America/Denver')::date,interval '1 day') d
), stores as (select id as location_id from public.locations where can_sell)
insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type,occurred_at)
select '1001',location_id,-1,1,'Production Issue',
 trading_day::timestamp at time zone 'America/Denver'+interval '13 hours'
from days cross join stores cross join generate_series(1,60) n
where (trading_day-(now() at time zone 'America/Denver')::date+180)%3=1;
analyze public.sales;
analyze public.inventory_transactions;
analyze public.erp_sample_material_history;
select public.ci_assert((select count(*)>=5000 from public.sales where receipt_no like 'INVPERF-S-%'),'realistic sales history fixture missing');
select public.ci_assert((select count(*)>=10000 from public.inventory_transactions where transaction_type='Production Issue'),'realistic inventory history fixture missing');
select public.ci_assert((select count(*)>=20000 from public.erp_sample_material_history),'realistic synthetic usage fixture missing');

-- Stage timings execute under the same authenticated staff role used by PostgREST.
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
select jsonb_array_length(public.erp_inventory_snapshot()->'stock') as snapshot_stock_rows;
select count(*) as recorded_usage_rows from public.erp_inventory_recorded_usage(((now() at time zone 'America/Denver')::date::timestamp at time zone 'UTC')-interval '180 days');
select count(*) as sample_usage_rows from public.erp_inventory_sample_usage();
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',true);
select count(*) as cashier_recorded_usage_rows from public.erp_inventory_recorded_usage(((now() at time zone 'America/Denver')::date::timestamp at time zone 'UTC')-interval '180 days');
select count(*) as cashier_sample_usage_rows from public.erp_inventory_sample_usage();
reset role;

explain (analyze,buffers,timing)
select t.item_sku,t.location_id,sum(t.quantity)::numeric,'Sale'::text
from public.inventory_transactions t
where t.occurred_at>=(((now() at time zone 'America/Denver')::date::timestamp at time zone 'UTC')-interval '180 days')
 and t.quantity<0
 and lower(t.transaction_type) in ('sale','production','production issue','backorder fulfillment')
group by t.item_sku,t.location_id;
explain (analyze,buffers,timing)
with actual_days as materialized (
 select s.location_id,(s.created_at at time zone 'America/Denver')::date as trading_date
 from public.sales s
 where s.status='Completed'
  and s.created_at>=((now() at time zone 'America/Denver')::date-179)::timestamp at time zone 'America/Denver'
  and s.created_at<((now() at time zone 'America/Denver')::date+1)::timestamp at time zone 'America/Denver'
 union
 select t.location_id,(t.occurred_at at time zone 'America/Denver')::date
 from public.inventory_transactions t
 where t.quantity<0 and lower(t.transaction_type) in ('sale','production','production issue','backorder fulfillment')
  and t.occurred_at>=((now() at time zone 'America/Denver')::date-179)::timestamp at time zone 'America/Denver'
  and t.occurred_at<((now() at time zone 'America/Denver')::date+1)::timestamp at time zone 'America/Denver'
)
select h.item_sku,h.location_id,-sum(h.quantity),'Sale'::text
from public.erp_sample_material_history h
where h.usage_date between (now() at time zone 'America/Denver')::date-179 and (now() at time zone 'America/Denver')::date
 and not exists(select 1 from actual_days d where d.location_id=h.location_id and d.trading_date=h.usage_date)
group by h.item_sku,h.location_id;

do $$begin
 if exists(select 1 from public.erp_inventory_recorded_usage(((now() at time zone 'America/Denver')::date::timestamp at time zone 'UTC')-interval '180 days') where quantity>=0) then
  raise exception 'recorded usage aggregate must contain negative ledger quantities';
 end if;
 if not exists(select 1 from public.erp_inventory_sample_usage() where item_sku='1001' and quantity<0) then
  raise exception 'sample usage was lost while suppressing real store-days';
 end if;
end$$;

do $$declare expected boolean;begin
 perform set_config('request.jwt.claim.sub','',true);
 expected:=false;
 begin perform public.erp_inventory_recorded_usage(((now() at time zone 'America/Denver')::date::timestamp at time zone 'UTC')-interval '180 days');exception when insufficient_privilege then expected:=true;end;
 perform public.ci_assert(expected,'unauthenticated user accessed staff-only usage');
 expected:=false;
 begin perform public.erp_inventory_sample_usage();exception when insufficient_privilege then expected:=true;end;
 perform public.ci_assert(expected,'unauthenticated user accessed staff-only sample usage');
 perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000004',true);
 expected:=false;
 begin perform public.erp_inventory_recorded_usage(((now() at time zone 'America/Denver')::date::timestamp at time zone 'UTC')-interval '180 days');exception when insufficient_privilege then expected:=true;end;
 perform public.ci_assert(expected,'customer accessed staff-only usage');
 expected:=false;
 begin perform public.erp_inventory_sample_usage();exception when insufficient_privilege then expected:=true;end;
 perform public.ci_assert(expected,'customer accessed staff-only sample usage');
end$$;
rollback;
\timing off
select 'PASS: usage aggregation and sample anti-join plans/timings under authenticated staff; realistic history volume, unchanged records, and Manager/Cashier-only RPC access.';
