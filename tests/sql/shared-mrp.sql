-- DISPOSABLE DATABASE ONLY. Run after the existing purchasing/reporting tests.
\set ON_ERROR_STOP on
begin;
insert into public.items(sku,name,category,barcode,base_unit,purchase_unit,conversion_factor,unit_cost,selling_price,lead_days) values
 ('MRP-F','MRP flour','Ingredient','MRP-F','oz','bag',10,1,0,3),
 ('MRP-C','MRP cheese','Ingredient','MRP-C','oz','bag',10,2,0,2),
 ('MRP-D','MRP dough','Ingredient','MRP-D','each','each',1,0,0,0),
 ('MRP-P','MRP pizza','Pizza','MRP-P','each','each',1,0,10,0),
 ('MRP-S','MRP soda','Beverage','MRP-S','each','case',24,.35,2,4);
insert into public.bom_lines(parent_sku,component_sku,quantity) values ('MRP-D','MRP-F',2),('MRP-P','MRP-D',1),('MRP-P','MRP-C',3);
select public.ci_assert(not has_function_privilege('anon','public.erp_planning_snapshot()','execute'),'anonymous planning access');
select public.ci_assert(not has_function_privilege('authenticated','public.erp_plan_post_sale(uuid,jsonb,numeric,numeric,uuid)','execute'),'internal posting helper exposed');
do $$declare
 loc uuid; other_loc uuid; request uuid:=gen_random_uuid(); rejected boolean; payload jsonb; answer jsonb; again jsonb; snapshot jsonb;
 ledger_count integer; sales_count integer; role_id uuid; prod uuid; sold uuid;
begin
 select id into loc from public.locations where can_sell order by name limit 1;
 select id into other_loc from public.locations where id<>loc order by name limit 1;
 -- Explicit denial even if the original require_staff() sees a missing profile.
 foreach role_id in array array[null::uuid,'00000000-0000-0000-0000-000000000004'::uuid,'00000000-0000-0000-0000-000000000003'::uuid] loop
  perform set_config('request.jwt.claim.sub',coalesce(role_id::text,''),true);rejected:=false;
  begin perform public.erp_planning_snapshot();exception when insufficient_privilege then rejected:=true;end;
  perform public.ci_assert(rejected,'nonstaff can read planning');
 end loop;
 perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
 insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type,reference_document)
 values('MRP-F',loc,40,1,'Receipt','MRP fixture'),('MRP-C',loc,30,2,'Receipt','MRP fixture'),('MRP-D',loc,5,2,'Receipt','MRP fixture'),('MRP-S',loc,3,.35,'Receipt','MRP fixture'),('MRP-F',other_loc,100,1,'Receipt','MRP fixture');
 select count(*) into ledger_count from public.inventory_transactions;select count(*) into sales_count from public.sales;
 payload:=jsonb_build_object('name','MRP pickup','phone','8015550100','location',(select name from public.locations where id=loc),'pickup',now()+interval '2 days','lines','[{"sku":"MRP-P","qty":2}]'::jsonb);
 answer:=public.erp_create_pickup_order(request,payload);again:=public.erp_create_pickup_order(request,payload);
 perform public.ci_assert(answer=again,'create retry differs');
 perform public.ci_assert((select count(*)=ledger_count from public.inventory_transactions),'confirmation deducted inventory');
 perform public.ci_assert((select count(*)=sales_count from public.sales),'confirmation posted sale before preparation');
 perform public.ci_assert((select count(*)=1 from public.sales_order_lines where order_id=request),'duplicate request duplicated lines');
 rejected:=false;begin perform public.erp_create_pickup_order(request,payload||'{"name":"different"}');exception when others then rejected:=true;end;
 perform public.ci_assert(rejected,'request reuse accepted different payload');
 snapshot:=public.erp_planning_snapshot();perform public.ci_assert((snapshot->>'version')::integer=1,'snapshot version');
 perform public.ci_assert(exists(select 1 from jsonb_array_elements(snapshot->'orders')x where x->>'id'=request::text),'shared order missing from snapshot');
 answer:=public.erp_pickup_action(request,'prepare');sold:=(answer->>'sale_id')::uuid;
 perform public.ci_assert((select sum(quantity)=3 from public.inventory_transactions where item_sku='MRP-D' and location_id=loc),'wrong dough consumption');
 perform public.ci_assert((select sum(quantity)=24 from public.inventory_transactions where item_sku='MRP-C' and location_id=loc),'wrong cheese consumption');
 perform public.ci_assert((select sum(quantity)=40 from public.inventory_transactions where item_sku='MRP-F' and location_id=loc),'sale consumed dough flour twice');
 perform public.ci_assert((select subtotal=20 and cogs=16 from public.sales where id=sold),'price/cost rollup incorrect');
 select count(*) into ledger_count from public.inventory_transactions;
 perform public.erp_pickup_action(request,'prepare');perform public.erp_pickup_action(request,'fulfill');perform public.erp_pickup_action(request,'fulfill');
 perform public.ci_assert((select count(*)=ledger_count from public.inventory_transactions),'prepare/fulfill retry deducted twice');
 perform public.ci_assert((select status='Fulfilled' and erp_prepared_at is not null from public.sales_orders where id=request),'fulfillment status');
 rejected:=false;begin perform public.erp_pickup_action(request,'cancel');exception when others then rejected:=true;end;perform public.ci_assert(rejected,'prepared order cancelled');
 -- Immediate POS API keeps its signature; direct stock COGS and server prices.
 answer:=public.record_sale(loc,'[{"sku":"MRP-S","qty":1,"price":0}]',0,null);
 perform public.ci_assert((answer->>'subtotal')::numeric=2 and (answer->>'cogs')::numeric=.35,'POS did not use server prices/direct COGS');
 -- Finished parents use existing stock before issuing another set of components.
 insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type) values('MRP-P',loc,1,8,'Production Receipt');
 select count(*) into ledger_count from public.inventory_transactions;
 answer:=public.record_sale(loc,'[{"sku":"MRP-P","qty":1}]',0,null);
 perform public.ci_assert((select count(*)=ledger_count+1 from public.inventory_transactions),'prepared parent components consumed twice');
 select count(*) into ledger_count from public.inventory_transactions;select count(*) into sales_count from public.sales;
 rejected:=false;begin perform public.record_sale(loc,'[{"sku":"MRP-P","qty":1000}]',0,null);exception when others then rejected:=true;end;
 perform public.ci_assert(rejected,'shortage accepted');
 perform public.ci_assert((select count(*)=ledger_count from public.inventory_transactions),'shortage failed to roll back inventory');
 perform public.ci_assert((select count(*)=sales_count from public.sales),'shortage failed to roll back sale');
 -- Confirm/cancel never changes stock. Customer orders enter the same plan.
 perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000003',true);
 request:=gen_random_uuid();answer:=public.erp_create_pickup_order(request,payload);perform public.ci_assert((answer->>'simulatedPaid')::boolean,'online simulation marker');
 perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',true);
 perform public.erp_pickup_action(request,'cancel');
 perform public.ci_assert((select count(*)=ledger_count from public.inventory_transactions),'cancel changed inventory');
 prod:=public.create_production_order('MRP-D',loc,4);
 perform public.erp_schedule_production(prod,(now() at time zone 'America/Denver')::date+1);
 perform public.ci_assert((select erp_due_date is not null from public.production_orders where id=prod),'production schedule not saved');
 snapshot:=public.erp_planning_snapshot();
 perform public.ci_assert(exists(select 1 from jsonb_array_elements(snapshot->'receipts')x where x->>'id'=prod::text and x->>'kind'='Production'),'dated production not in plan');
end $$;
rollback;
\echo 'PASS: shared pickup lifecycle, role checks, immutable confirmation stock, dated production, retries, fulfillment once, direct-stock COGS, prepared parents, server prices and shortage rollback.'
