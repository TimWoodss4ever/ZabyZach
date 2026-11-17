-- DISPOSABLE CI DATABASE ONLY. Never run this test file in Supabase.
\set ON_ERROR_STOP on
create temporary table history_before_rows(table_name text,row_value jsonb);
do $$declare t record;begin
 for t in select tablename from pg_tables where schemaname='public' and tablename<>'suppliers' loop
  execute format('insert into history_before_rows select %L,to_jsonb(t) from public.%I t',t.tablename,t.tablename);
 end loop;
end$$;
create temporary table history_before_functions as
 select p.oid,pg_get_functiondef(p.oid) definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.prokind='f';
update public.suppliers set contact_name='Preserve team contact',email='team@existing.example',phone='Keep existing phone',address='Keep existing address'
 where name='Mountain Produce';
\ir ../../supabase/migrations/202611170001_menu_history_contacts.sql
-- Every pre-existing operational row and function must remain byte-for-byte intact.
do $$declare old record;present boolean;begin
 for old in select * from history_before_rows loop
  execute format('select exists(select 1 from public.%I t where to_jsonb(t)=$1)',old.table_name) into present using old.row_value;
  if not present then raise exception 'Original row changed in %',old.table_name;end if;
 end loop;
 for old in select * from history_before_functions loop
  if pg_get_functiondef(old.oid) is distinct from old.definition then raise exception 'Original function changed: %',old.oid::regprocedure;end if;
 end loop;
end$$;
select public.ci_assert((select email='team@existing.example' and contact_name='Preserve team contact' and phone='Keep existing phone' and address='Keep existing address' from public.suppliers where name='Mountain Produce'),'custom supplier contacts overwritten');
select public.ci_assert((select email='orders@beehivepack.example' and phone='(801) 555-0161' from public.suppliers where name='Beehive Packaging'),'missing original contact not restored');
select public.ci_assert((select from_date=(date_trunc('month',(now() at time zone 'America/Denver'))-interval '6 months')::date and to_date=(now() at time zone 'America/Denver')::date-1 from public.erp_sample_history_batches where id='menu-history-v1'),'six complete calendar months missing');
select public.ci_assert((select count(*)>1000 from public.erp_sample_menu_history),'too little generated history');
select public.ci_assert(not exists(select 1 from public.items i where i.active and i.selling_price>0 and not exists(select 1 from public.erp_sample_menu_history h where h.item_sku=i.sku)),'menu item missing history');
select public.ci_assert((select min(quantity)>0 and stddev_pop(quantity)>0 and sum(quantity*unit_cost)>0 from public.erp_sample_menu_history),'flat, invalid or zero-cost sample data');
select public.ci_assert((select avg(quantity) filter(where extract(isodow from sale_date)=5)>avg(quantity) filter(where extract(isodow from sale_date)=1)*1.2 from public.erp_sample_menu_history where item_sku='2002'),'Friday demand pattern missing');
select public.ci_assert((select sum(quantity) filter(where item_sku='2002')>sum(quantity) filter(where item_sku='2001') from public.erp_sample_menu_history),'menu popularity missing');
select public.ci_assert(not exists(select 1 from public.erp_sample_material_history where item_sku in('2001','2002','2003','2004','2005','2006','2007')),'finished menu units duplicated in material usage');
select public.ci_assert((select count(*)>0 and min(quantity)>0 from public.erp_sample_material_history where item_sku='1001'),'nested flour BOM demand missing');
select public.ci_assert(not exists(select 1 from public.erp_sample_menu_history h join public.sales s on s.location_id=h.location_id and s.status='Completed' and (s.created_at at time zone 'America/Denver')::date=h.sale_date),'sample overlaps existing real store-day');
-- Verify repeat installation does not append, retime or regenerate the sample.
create temporary table history_first_copy as select md5(string_agg(to_jsonb(h)::text,'' order by batch_id,sale_date,location_id,item_sku)) digest from public.erp_sample_menu_history h;
create temporary table history_material_copy as select md5(string_agg(to_jsonb(h)::text,'' order by batch_id,usage_date,location_id,item_sku)) digest from public.erp_sample_material_history h;
\ir ../../supabase/migrations/202611170001_menu_history_contacts.sql
select public.ci_assert((select digest=(select md5(string_agg(to_jsonb(h)::text,'' order by batch_id,sale_date,location_id,item_sku)) from public.erp_sample_menu_history h) from history_first_copy),'repeat installation duplicated or changed history');
select public.ci_assert((select digest=(select md5(string_agg(to_jsonb(h)::text,'' order by batch_id,usage_date,location_id,item_sku)) from public.erp_sample_material_history h) from history_material_copy),'repeat installation changed material history');
select public.ci_assert(not has_table_privilege('anon','public.erp_sample_menu_history','SELECT'),'anonymous history disclosure');
select public.ci_assert(not has_function_privilege('authenticated','public.erp_history_menu(date,date,uuid)','EXECUTE'),'private history helper exposed');
select public.ci_assert(not has_table_privilege('authenticated','public.erp_sample_menu_history','INSERT'),'client can write synthetic history');
-- Use an existing manager seeded by the earlier shared reporting test suite.
select set_config('request.jwt.claim.sub',(select user_id::text from public.profiles where role='Manager' limit 1),false);
select public.ci_assert(public.current_role()='Manager','manager fixture missing');
create temporary table history_report as select public.erp_reporting_snapshot_with_history(
 (select from_date from public.erp_sample_history_batches where id='menu-history-v1'),(now() at time zone 'America/Denver')::date) data;
select public.ci_assert((select (data->>'version')::integer=2 and (data#>>'{sampleHistory,includedUnits}')::numeric>0 from history_report),'report contract or source label missing');
select public.ci_assert((select abs((data#>>'{pnl,gross}')::numeric-(data#>>'{pnl,discounts}')::numeric-(data#>>'{pnl,refunds}')::numeric-(select sum((d->>'net')::numeric) from jsonb_array_elements(data->'daily')d))<.005 from history_report),'daily sales do not reconcile to P&L');
select public.ci_assert((public.erp_purchasing_snapshot_with_history()#>>'{dailyUsage,1001}')::numeric>0,'flour EOQ/ROP has no usage');
select public.ci_assert(exists(select 1 from public.erp_inventory_sample_usage() where item_sku='1001' and quantity<0),'inventory reorder history missing');
-- A subsequently backdated real sale suppresses the full sample store-day.
begin;
create temporary table chosen_history_day as select * from public.erp_sample_menu_history limit 1;
insert into public.sales(receipt_no,location_id,subtotal,discount,tax,total,cogs,created_at)
 select 'CI-HISTORY-REAL-OVERRIDE',location_id,20,0,1,21,5,sale_date::timestamp at time zone 'America/Denver' from chosen_history_day;
select public.ci_assert(not exists(select 1 from public.erp_history_menu((select sale_date from chosen_history_day),(select sale_date from chosen_history_day)) h where h.location_id=(select location_id from chosen_history_day)),'real sale did not take precedence');
rollback;
select set_config('request.jwt.claim.sub','',false);
do $$begin
 begin perform public.erp_purchasing_snapshot_with_history();raise exception 'Unauthenticated purchasing access allowed';exception when insufficient_privilege then null;end;
 begin perform public.erp_reporting_snapshot_with_history(current_date-1,current_date);raise exception 'Unauthenticated report access allowed';exception when insufficient_privilege then null;end;
 begin perform public.erp_inventory_sample_usage();raise exception 'Unauthenticated inventory access allowed';exception when insufficient_privilege then null;end;
end$$;
select 'PASS: operational data/functions preserved; blank-only contacts; six calendar months; nonflat item/week patterns; nested BOM usage; repeat-install safety; report reconciliation; live-data precedence; access controls.';
