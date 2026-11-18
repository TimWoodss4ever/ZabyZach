-- DISPOSABLE CI DATABASE ONLY. Exercise five real seeded pizza BOM parents.
\set ON_ERROR_STOP on
begin;
do $$
declare
  target uuid := gen_random_uuid();
  parent record;
  component record;
  before_stock jsonb;
  after_quantity numeric;
  checked integer := 0;
begin
  perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
  perform public.ci_assert((select count(distinct parent_sku)>=5 from public.bom_lines),'fewer than five BOM parents');
  perform public.ci_assert(not exists(
    select 1 from public.bom_lines b join public.items i on i.sku=b.component_sku
    where i.lead_days is null or i.lead_days<0 or b.quantity<=0
  ),'component quantity or lead time missing');
  insert into public.locations(id,name,can_sell) values(target,'MRP rubric test location',true);
  insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type,reference_document)
    select distinct b.component_sku,target,10000,public.erp_plan_unit_cost(b.component_sku),'Receipt','MRP rubric fixture'
    from public.bom_lines b join public.items p on p.sku=b.parent_sku
    where p.category='Pizza' and p.selling_price>0 and p.active;
  for parent in
    select p.sku from public.items p where p.category='Pizza' and p.active and p.selling_price>0
    and exists(select 1 from public.bom_lines b where b.parent_sku=p.sku) order by p.sku limit 5
  loop
    select jsonb_object_agg(t.item_sku,t.quantity) into before_stock from (
      select item_sku,sum(quantity) quantity from public.inventory_transactions where location_id=target group by item_sku
    )t;
    perform public.record_sale(target,jsonb_build_array(jsonb_build_object('sku',parent.sku,'qty',2)),0,null);
    for component in select * from public.bom_lines where parent_sku=parent.sku loop
      select coalesce(sum(quantity),0) into after_quantity from public.inventory_transactions
        where item_sku=component.component_sku and location_id=target;
      perform public.ci_assert(after_quantity=(before_stock->>component.component_sku)::numeric-2*component.quantity,
        'selling parent '||parent.sku||' did not consume correct component '||component.component_sku);
    end loop;
    checked:=checked+1;
  end loop;
  perform public.ci_assert(checked=5,'five seeded menu parents were not exercised');
end $$;
rollback;
\echo 'PASS: at least five real catalog BOM parents, positive component quantities, per-component lead times and exact two-unit sale consumption for five pizza recipes.'
