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
 ledger_count integer; sales_count integer; role_id uuid; prod uuid; sold uuid; customer_stock numeric; post_count integer; lead integer; review_day date; required_day date; order_day date;
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
 perform public.ci_assert((select count(*)=ledger_count from public.inventory_transactions),'confirmation changed inventory');
 perform public.ci_assert((select count(*)=sales_count from public.sales),'confirmation posted its sale too early');
 perform public.ci_assert((answer->>'orderNo')::integer>0 and (answer->>'sale_id') is null,'short order number missing or sale posted too early');
 select count(*) into ledger_count from public.inventory_transactions;
 perform public.ci_assert((select count(*)=1 from public.sales_order_lines where order_id=request),'duplicate request duplicated lines');
 rejected:=false;begin perform public.erp_create_pickup_order(request,payload||'{"name":"different"}');exception when others then rejected:=true;end;
 perform public.ci_assert(rejected,'request reuse accepted different payload');
 snapshot:=public.erp_planning_snapshot();perform public.ci_assert((snapshot->>'version')::integer=1,'snapshot version');
 perform public.ci_assert(exists(select 1 from jsonb_array_elements(snapshot->'orders')x where x->>'id'=request::text),'shared order missing from snapshot');
 rejected:=false;begin perform public.erp_pickup_action(request,null);exception when others then rejected:=true;end;
 perform public.ci_assert(rejected,'missing action prepared an order');
 perform public.ci_assert((select count(*)=ledger_count from public.inventory_transactions),'invalid action changed inventory');
 answer:=public.erp_pickup_action(request,'prepare');sold:=(answer->>'sale_id')::uuid;
 perform public.ci_assert((select sum(quantity)=3 from public.inventory_transactions where item_sku='MRP-D' and location_id=loc),'wrong dough consumption');
 perform public.ci_assert((select sum(quantity)=24 from public.inventory_transactions where item_sku='MRP-C' and location_id=loc),'wrong cheese consumption');
 perform public.ci_assert((select sum(quantity)=40 from public.inventory_transactions where item_sku='MRP-F' and location_id=loc),'sale consumed dough flour twice');
 perform public.ci_assert((select subtotal=20 and cogs=16 from public.sales where id=sold),'price/cost rollup incorrect');
 select count(*) into ledger_count from public.inventory_transactions;
 perform public.erp_pickup_action(request,'prepare');perform public.erp_pickup_action(request,'fulfill');perform public.erp_pickup_action(request,'fulfill');
 perform public.ci_assert((select count(*)=ledger_count from public.inventory_transactions),'prepare/fulfill retry deducted twice');
 perform public.ci_assert((select status='Fulfilled' and erp_prepared_at is not null from public.sales_orders where id=request),'fulfillment status');
 perform public.erp_pickup_action(request,'close');perform public.ci_assert((select status='Closed' from public.sales_orders where id=request),'fulfilled order did not close');
 rejected:=false;begin perform public.erp_pickup_action(request,'cancel');exception when others then rejected:=true;end;perform public.ci_assert(rejected,'closed order cancelled');
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
 -- New customer orders remain unposted; cancelling them never changes stock.
 perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000003',true);
 select coalesce(sum(quantity),0) into customer_stock from public.inventory_transactions where item_sku='MRP-C' and location_id=loc;
 request:=gen_random_uuid();answer:=public.erp_create_pickup_order(request,payload);perform public.ci_assert((answer->>'simulatedPaid')::boolean,'online simulation marker');
 perform public.ci_assert((answer->>'orderNo')::integer>0 and (answer->>'sale_id') is null,'customer confirmation posted a sale or omitted its number');
 perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',true);
 perform public.erp_pickup_action(request,'cancel');
 perform public.ci_assert((select status='Cancelled' from public.sales_orders where id=request),'unprepared cancellation status');
 perform public.ci_assert((select sum(quantity)=customer_stock from public.inventory_transactions where item_sku='MRP-C' and location_id=loc),'cancel failed to restore ingredient stock');
 perform public.ci_assert((select erp_sale_id is null from public.sales_orders where id=request),'unprepared cancellation created a sale');
 prod:=public.create_production_order('MRP-D',loc,4);
 perform public.erp_schedule_production(prod,(now() at time zone 'America/Denver')::date+1);
 perform public.ci_assert((select erp_due_date is not null from public.production_orders where id=prod),'production schedule not saved');
 perform public.issue_production_order(prod);
 perform public.complete_production_order(prod,3,1,'Damaged');
 perform public.ci_assert((select sum(quantity)=6 from public.inventory_transactions where item_sku='MRP-D' and location_id=loc),'scrap deducted twice from good output');
 -- A second open order supplies the dated planning receipt.
 prod:=public.create_production_order('MRP-D',loc,2);
 perform public.erp_schedule_production(prod,(now() at time zone 'America/Denver')::date+1);
 perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
 update public.items set supplier_id='00000000-0000-0000-0000-000000000010' where sku='MRP-F';
 select quoted_lead_days into lead from public.suppliers where id='00000000-0000-0000-0000-000000000010' and erp_active;
 if lead is null then raise exception 'MRP test supplier is missing an active quoted lead time'; end if;
 review_day:=(now() at time zone 'America/Denver')::date+1;required_day:=review_day+lead;order_day:=required_day-lead;
 snapshot:=public.erp_planning_snapshot();
 payload:=jsonb_build_object('revision',snapshot->>'revision','orders',jsonb_build_array(jsonb_build_object('supplierId','00000000-0000-0000-0000-000000000010','locationId',loc,'date',review_day,'requiredOn',required_day,'orderBy',order_day,'send',false,'notes','MRP confirmed requirements test','lines','[{"sku":"MRP-F","qty":1,"price":10}]'::jsonb)));
 request:=gen_random_uuid();answer:=public.erp_mrp_purchase_drafts(request,'create_orders',payload);again:=public.erp_mrp_purchase_drafts(request,'create_orders',payload);
 perform public.ci_assert(answer=again,'MRP draft retry duplicated an order');
 snapshot:=public.erp_planning_snapshot();payload:=jsonb_set(payload,'{revision}',to_jsonb(snapshot->>'revision'));
 rejected:=false;begin perform public.erp_mrp_purchase_drafts(gen_random_uuid(),'create_orders',payload);exception when others then rejected:=true;end;
 perform public.ci_assert(rejected,'duplicate item/location MRP draft accepted');
 snapshot:=public.erp_planning_snapshot();
 perform public.ci_assert(exists(select 1 from jsonb_array_elements(snapshot->'receipts')x where x->>'id'=prod::text and x->>'kind'='Production'),'dated production not in plan');
end $$;
rollback;
\echo 'PASS: shared pickup lifecycle, role checks, immutable confirmation stock, dated production, retries, fulfillment once, direct-stock COGS, prepared parents, server prices and shortage rollback.'
