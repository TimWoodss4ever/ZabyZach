-- DISPOSABLE CI DATABASE ONLY. Never run fixtures in the live project.
\set ON_ERROR_STOP on
create temporary table hardening_preserved as
 select 'orders' as kind,md5(coalesce(string_agg((to_jsonb(t)-array['erp_quote_subtotal','erp_quote_discount','erp_quote_tax','erp_quote_total','erp_quote_tax_rate'])::text,'' order by id),'')) as digest from public.sales_orders t
 union all select 'stock',md5(coalesce(string_agg(to_jsonb(t)::text,'' order by id),'')) from public.inventory_transactions t
 union all select 'sales',md5(coalesce(string_agg(to_jsonb(t)::text,'' order by id),'')) from public.sales t;
\ir ../../supabase/migrations/202611190002_mrp_planning_hardening.sql
\ir ../../supabase/migrations/202611190002_mrp_planning_hardening.sql
select public.ci_assert(not exists(select * from hardening_preserved except
 (select 'orders',md5(coalesce(string_agg((to_jsonb(t)-array['erp_quote_subtotal','erp_quote_discount','erp_quote_tax','erp_quote_total','erp_quote_tax_rate'])::text,'' order by id),'')) from public.sales_orders t
 union all select 'stock',md5(coalesce(string_agg(to_jsonb(t)::text,'' order by id),'')) from public.inventory_transactions t
 union all select 'sales',md5(coalesce(string_agg(to_jsonb(t)::text,'' order by id),'')) from public.sales t)),
 'hardening migration changed existing order values, stock or sales');

begin;
do $$declare
 manager uuid:='00000000-0000-0000-0000-000000000001';customer uuid:='00000000-0000-0000-0000-000000000003';
 loc uuid:=gen_random_uuid();supplier uuid:=gen_random_uuid();request uuid:=gen_random_uuid();draft_request uuid:=gen_random_uuid();production_request uuid:=gen_random_uuid();
 payload jsonb;quoted jsonb;retry jsonb;result jsonb;snapshot jsonb;drafts jsonb;old_revision text;order_id uuid;
 day date:=(now() at time zone 'America/Denver')::date;before_count integer;before_stock integer;rejected boolean;
begin
 perform set_config('request.jwt.claim.sub',manager::text,true);
 insert into public.locations(id,name,can_sell)values(loc,'Hardening fixture',true);
 insert into public.suppliers(id,name,quoted_lead_days,payment_terms_days)values(supplier,'Hardening supplier',3,30);
 insert into public.items(sku,name,category,barcode,base_unit,purchase_unit,conversion_factor,unit_cost,selling_price,supplier_id,lead_days)values
 ('HARD-DRINK','Hardening drink','Beverage','HARD-DRINK','each','case',10,1,10,supplier,3),
 ('HARD-RAW','Hardening raw component','Ingredient','HARD-RAW','oz','bag',10,1,0,supplier,3),
 ('HARD-P','Hardening parent','Pizza','HARD-P','each','each',1,0,11.99,null,0);
 insert into public.bom_lines(parent_sku,component_sku,quantity)values('HARD-P','HARD-RAW',2);
 insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type)values('HARD-DRINK',loc,100,1,'Receipt');
 update public.settings set value='0.0725'::jsonb where setting_key='sales_tax_rate';
 payload:=jsonb_build_object('name','Hardening customer','location','Hardening fixture','pickup',now()+interval '14 days','lines',jsonb_build_array(jsonb_build_object('sku','HARD-DRINK','qty',1)));
 perform set_config('request.jwt.claim.sub',customer::text,true);
 quoted:=public.erp_checkout_order(request,payload);
 perform public.ci_assert((quoted->>'total')::numeric=10.73 and (quoted->>'tax')::numeric=.73 and quoted->>'status'='Order Placed' and (quoted->>'quoteFrozen')::boolean,'initial quote or state incorrect');
 perform set_config('request.jwt.claim.sub',manager::text,true);
 update public.settings set value='0.0825'::jsonb where setting_key='sales_tax_rate';
 update public.items set selling_price=12 where sku='HARD-DRINK';
 perform set_config('request.jwt.claim.sub',customer::text,true);
 retry:=public.erp_checkout_order(request,payload);
 perform public.ci_assert(quoted=retry,'same checkout retry changed after tax/catalog update');
 perform public.ci_assert((retry->'lines'->0->>'price')::numeric=10,'confirmed line price changed');
 perform set_config('request.jwt.claim.sub',manager::text,true);
 result:=public.erp_pickup_progress(request,'prepare');
 perform public.ci_assert((select subtotal=10 and discount=0 and tax=.73 and total=10.73 and cogs=1 from public.sales where id=(result->>'sale_id')::uuid),'prepared sale did not honor frozen quote');
 perform public.erp_pickup_progress(request,'fulfill');
 perform set_config('request.jwt.claim.sub',customer::text,true);
 retry:=public.erp_checkout_order(request,payload);perform public.ci_assert(retry->>'status'='Fulfilled' and (retry->>'total')::numeric=10.73,'recovery lost fulfilled status/quote');
 request:=gen_random_uuid();quoted:=public.erp_checkout_order(request,payload);
 perform set_config('request.jwt.claim.sub',manager::text,true);
 perform public.erp_pickup_progress(request,'cancel');
 select count(*) into before_stock from public.inventory_transactions;
 perform set_config('request.jwt.claim.sub',customer::text,true);
 retry:=public.erp_checkout_order(request,payload);
 perform public.ci_assert(retry->>'status'='Cancelled' and (retry->>'total')::numeric=(quoted->>'total')::numeric,'cancelled retry returned a false confirmation or changed quote');
 perform public.ci_assert((select count(*)=before_stock from public.inventory_transactions),'cancelled retry changed stock');

 -- Percentage discounts freeze in cents, not fractional-cent quote amounts.
 perform set_config('request.jwt.claim.sub',manager::text,true);
 update public.settings set value='0.0725'::jsonb where setting_key='sales_tax_rate';
 perform set_config('request.jwt.claim.sub',customer::text,true);
 request:=gen_random_uuid();quoted:=public.erp_checkout_order(request,jsonb_build_object('name','Rounded quote','location','Hardening fixture','pickup',now()+interval '10 days','discountPct',25,'lines',jsonb_build_array(jsonb_build_object('sku','HARD-P','qty',1))));
 perform public.ci_assert((quoted->>'subtotal')::numeric=11.99 and (quoted->>'discount')::numeric=3 and (quoted->>'tax')::numeric=.65 and (quoted->>'total')::numeric=9.64,'quote cents do not reconcile');
 perform set_config('request.jwt.claim.sub',manager::text,true);perform public.erp_pickup_progress(request,'cancel');
 -- Demand exists without stock. A committed cancellation invalidates its epoch.
 perform set_config('request.jwt.claim.sub',manager::text,true);
 request:=gen_random_uuid();payload:=jsonb_build_object('name','Hardening demand','location','Hardening fixture','pickup',now()+interval '7 days','lines',jsonb_build_array(jsonb_build_object('sku','HARD-P','qty',10)));
 perform public.erp_create_pickup_order(request,payload);snapshot:=public.erp_planning_snapshot();old_revision:=snapshot->>'revision';
 perform public.ci_assert(old_revision is not null and (snapshot->>'orderWorkflow')::integer=2,'atomic planning snapshot missing revision/capability');
 drafts:=jsonb_build_object('revision',old_revision,'orders',jsonb_build_array(jsonb_build_object('supplierId',supplier,'locationId',loc,'date',day,'requiredOn',day+7,'orderBy',day+4,'send',false,'notes','MRP confirmed requirements hardening','lines',jsonb_build_array(jsonb_build_object('sku','HARD-RAW','qty',2,'price',10)))));
 perform public.erp_pickup_progress(request,'cancel');
 select count(*) into before_count from public.purchase_orders;
 rejected:=false;begin perform public.erp_mrp_purchase_drafts(draft_request,'create_orders',drafts);exception when raise_exception then rejected:=sqlerrm like 'Planning data changed%';end;
 perform public.ci_assert(rejected and (select count(*)=before_count from public.purchase_orders),'stale snapshot created a PO');
 -- Dated suggestions remain two separate drafts for the same component.
 request:=gen_random_uuid();perform public.erp_create_pickup_order(request,payload);
 snapshot:=public.erp_planning_snapshot();
 drafts:=jsonb_build_object('revision',snapshot->>'revision','orders',jsonb_build_array(
 jsonb_build_object('supplierId',supplier,'locationId',loc,'date',day,'requiredOn',day+7,'orderBy',day+4,'send',false,'notes','MRP confirmed requirements first date','lines',jsonb_build_array(jsonb_build_object('sku','HARD-RAW','qty',2,'price',10))),
 jsonb_build_object('supplierId',supplier,'locationId',loc,'date',day,'requiredOn',day+21,'orderBy',day+18,'send',false,'notes','MRP confirmed requirements later date','lines',jsonb_build_array(jsonb_build_object('sku','HARD-RAW','qty',1,'price',10)))));
 result:=public.erp_mrp_purchase_drafts(draft_request,'create_orders',drafts);
 retry:=public.erp_mrp_purchase_drafts(draft_request,'create_orders',drafts);
 perform public.ci_assert(result=retry and jsonb_array_length(result->'ids')=2,'dated draft save/retry incorrect');
 perform public.ci_assert((select count(*)=2 from public.purchase_orders where id in(select value::text::uuid from jsonb_array_elements_text(result->'ids')) and status='Draft' and erp_mrp_required_on is not null),'draft dates missing');
 order_id:=(result->'ids'->>1)::uuid;
 perform public.ci_assert((select erp_mrp_required_on=day+21 and erp_mrp_order_by=day+18 and (expected_at at time zone 'America/Denver')::date=day+21 from public.purchase_orders where id=order_id),'later date flattened to today');
 perform public.erp_purchasing_write(gen_random_uuid(),'send_order',jsonb_build_object('id',order_id,'revision',(select erp_revision from public.purchase_orders where id=order_id)));
 perform public.ci_assert((select erp_mrp_required_on=day+21 and erp_mrp_order_by=day+18 and (expected_at at time zone 'America/Denver')::date=day+3 from public.purchase_orders where id=order_id),'issuing lost need-by dates or falsified the supplier lead-time arrival');

 -- Creation and scheduling are one transaction and one durable request.
 payload:=jsonb_build_object('sku','HARD-P','locationId',loc,'quantity',5,'due',day+5);
 result:=public.erp_create_scheduled_production(production_request,payload);
 retry:=public.erp_create_scheduled_production(production_request,payload);
 perform public.ci_assert(result=retry and (select erp_due_date=day+5 from public.production_orders where id=(result->>'id')::uuid),'production was duplicated or left unscheduled');
 snapshot:=public.erp_planning_snapshot();perform public.ci_assert(exists(select 1 from jsonb_array_elements(snapshot->'receipts')r where r->>'id'=result->>'id' and r->>'due'=(day+5)::text),'scheduled output missing from plan');
 select count(*) into before_count from public.production_orders;
 rejected:=false;begin perform public.erp_create_scheduled_production(gen_random_uuid(),payload||jsonb_build_object('due',day-1));exception when raise_exception then rejected:=true;end;
 perform public.ci_assert(rejected and (select count(*)=before_count from public.production_orders),'invalid completion date left an orphan batch');
 rejected:=false;begin perform public.erp_create_scheduled_production(production_request,payload||'{"quantity":6}');exception when raise_exception then rejected:=true;end;
 perform public.ci_assert(rejected,'production retry accepted changed details');
 perform set_config('request.jwt.claim.sub',customer::text,true);
 rejected:=false;begin perform public.erp_create_scheduled_production(gen_random_uuid(),payload);exception when insufficient_privilege then rejected:=true;end;
 perform public.ci_assert(rejected,'customer created production');
 perform public.ci_assert(not has_table_privilege('authenticated','public.erp_scheduled_production_requests','SELECT'),'raw durable request table exposed');
end $$;
rollback;
\echo 'PASS: unchanged history, repeat installation, frozen quote/tax/catalog prices, actual recovery statuses, stale-draft refusal, dated drafts and safe issue dates, atomic scheduled production, retries and permissions.'
