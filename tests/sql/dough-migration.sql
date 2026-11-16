-- DISPOSABLE CI DATABASE ONLY.
\set ON_ERROR_STOP on
begin;
create temporary table dough_before as select id,to_jsonb(t) value from public.inventory_transactions t;
create temporary table dough_po_before as select id,to_jsonb(t) value from public.purchase_order_lines t;
update public.items set unit_cost=.0499 where sku='1001';
\ir ../../supabase/migrations/202611130001_in_house_dough.sql
\ir ../../supabase/migrations/202611130001_in_house_dough.sql
select public.ci_assert((select unit_cost=.0499 from public.items where sku='1001'),'conversion reset modern flour cost');
select public.ci_assert(not exists(select 1 from dough_before b where not exists(select 1 from public.inventory_transactions t where t.id=b.id and to_jsonb(t)=b.value)),'modern conversion rewrote stock');
select public.ci_assert((select count(*) from dough_before)=(select count(*) from public.inventory_transactions),'modern conversion fabricated stock');
select public.ci_assert(not exists(select 1 from dough_po_before b where not exists(select 1 from public.purchase_order_lines t where t.id=b.id and to_jsonb(t)=b.value)),'conversion deleted/rewrote PO history');
select public.ci_assert(not exists(select 1 from public.bom_lines where parent_sku=component_sku),'conversion created recipe self-link');
rollback;
-- Old catalog with no transaction history can be upgraded atomically.
begin;
select public.ci_assert(not exists(select 1 from public.inventory_transactions where item_sku='1001'),'legacy fixture unexpectedly has flour history');
delete from public.bom_lines where parent_sku='1030';
update public.bom_lines set component_sku='1001' where component_sku='1030';
update public.items set name='Frozen dough ball (16 oz)',base_unit='each',conversion_factor=40 where sku='1001';
\ir ../../supabase/migrations/202611130001_in_house_dough.sql
\ir ../../supabase/migrations/202611130001_in_house_dough.sql
select public.ci_assert(exists(select 1 from public.bom_lines where parent_sku='1030' and component_sku='1001' and quantity=9.6),'legacy catalog recipe');
select public.ci_assert(not exists(select 1 from public.bom_lines where parent_sku=component_sku),'legacy self-link');
rollback;
-- Historical purchases must never be silently deleted or reinterpreted as flour.
begin;
delete from public.bom_lines where parent_sku='1030';
update public.bom_lines set component_sku='1001' where component_sku='1030';
update public.items set name='Frozen dough ball (16 oz)',base_unit='each',conversion_factor=40 where sku='1001';
insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type,reference_document) select '1001',id,10,.45,'Receipt','Legacy preservation fixture' from public.locations limit 1;
savepoint guarded_conversion;
\set ON_ERROR_STOP off
\ir ../../supabase/migrations/202611130001_in_house_dough.sql
\if :ERROR
  rollback to savepoint guarded_conversion;
\else
  \quit 3
\endif
\set ON_ERROR_STOP on
select public.ci_assert(exists(select 1 from public.items where sku='1001' and name='Frozen dough ball (16 oz)'),'rejected conversion partially changed catalog');
select public.ci_assert(exists(select 1 from public.inventory_transactions where reference_document='Legacy preservation fixture' and item_sku='1001' and quantity=10),'legacy stock lost');
rollback;
select 'PASS: modern dough migration is repeatable and preserves stock/cost/PO history; empty legacy catalog upgrade; historical legacy conversion refuses unsafe rewrites';
