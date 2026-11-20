-- DISPOSABLE CI DATABASE ONLY. Never run test fixtures in production.
\set ON_ERROR_STOP on
create temporary table mrp_fix_preserved as
 select 'orders' as kind,md5(coalesce(string_agg(to_jsonb(t)::text,'' order by id),'')) as digest from public.sales_orders t
 union all select 'sales',md5(coalesce(string_agg(to_jsonb(t)::text,'' order by id),'')) from public.sales t
 union all select 'stock',md5(coalesce(string_agg(to_jsonb(t)::text,'' order by id),'')) from public.inventory_transactions t;
\ir ../../supabase/migrations/202611190001_mrp_confirmed_demand.sql
\ir ../../supabase/migrations/202611190001_mrp_confirmed_demand.sql
-- Availability must include deductions committed while an older request waited.
\ir ../../supabase/migrations/202611200001_stock_visibility_guard.sql
\ir ../../supabase/migrations/202611200001_stock_visibility_guard.sql
select public.ci_assert(not exists(
 select * from mrp_fix_preserved except
 (select 'orders',md5(coalesce(string_agg(to_jsonb(t)::text,'' order by id),'')) from public.sales_orders t
 union all select 'sales',md5(coalesce(string_agg(to_jsonb(t)::text,'' order by id),'')) from public.sales t
 union all select 'stock',md5(coalesce(string_agg(to_jsonb(t)::text,'' order by id),'')) from public.inventory_transactions t)
),'repeat fix installation rewrote business records');

begin;
do $$declare
 manager uuid:='00000000-0000-0000-0000-000000000001';
 cashier uuid:='00000000-0000-0000-0000-000000000002';
 customer uuid:='00000000-0000-0000-0000-000000000003';
 supplier uuid:=gen_random_uuid(); store uuid:=gen_random_uuid(); other_store uuid:=gen_random_uuid();
 request uuid:=gen_random_uuid(); customer_request uuid:=gen_random_uuid();
 legacy_request uuid; legacy_sale uuid; prepared_sale uuid;
 po uuid; po_line uuid; receipt_request uuid:=gen_random_uuid();
 payload jsonb; customer_payload jsonb; receipt_payload jsonb; result jsonb; repeated jsonb; snapshot jsonb;
 before_stock integer; before_sales integer; before_reversals integer; rejected boolean; balance numeric;
 day date:=(now() at time zone 'America/Denver')::date;
begin
 perform set_config('request.jwt.claim.sub',manager::text,true);
 insert into public.locations(id,name,can_sell) values(store,'MRP deferred fixture',true),(other_store,'MRP deferred other location',true);
 insert into public.suppliers(id,name,quoted_lead_days,payment_terms_days) values(supplier,'MRP deferred supplier',3,15);
 insert into public.items(sku,name,category,barcode,base_unit,purchase_unit,conversion_factor,unit_cost,selling_price,supplier_id,lead_days) values
 ('DEFER-C','Deferred component','Ingredient','DEFER-C','oz','bag',10,1,0,supplier,3),
 ('DEFER-P','Deferred pizza','Pizza','DEFER-P','each','each',1,0,10,null,0);
 insert into public.bom_lines(parent_sku,component_sku,quantity) values('DEFER-P','DEFER-C',2);
 payload:=jsonb_build_object('name','Deferred fixture','location','MRP deferred fixture','pickup',now()+interval '14 days',
 'lines',jsonb_build_array(jsonb_build_object('sku','DEFER-P','qty',5)));
 select count(*) into before_stock from public.inventory_transactions;
 select count(*) into before_sales from public.sales;
 result:=public.erp_create_pickup_order(request,payload);
 repeated:=public.erp_create_pickup_order(request,payload);
 perform public.ci_assert(result=repeated and result->>'sale_id' is null,'confirmation retry posted a sale or changed its response');
 perform public.ci_assert((select count(*)=before_stock from public.inventory_transactions) and (select count(*)=before_sales from public.sales),'stockless confirmation changed stock or revenue');
 perform public.ci_assert((select count(*)=1 from public.sales_order_lines where order_id=request),'confirmation duplicated demand');
 snapshot:=public.erp_planning_snapshot();
 perform public.ci_assert(exists(select 1 from jsonb_array_elements(snapshot->'orders')o where o->>'id'=request::text and o->>'erp_sale_id' is null and o->>'erp_prepared_at' is null and o->>'status'='Order Placed'),'confirmed order is ineligible for MRP');
 perform public.ci_assert(exists(select 1 from jsonb_array_elements(snapshot->'lines')l where l->>'order_id'=request::text and (l->>'quantity')::numeric=5),'snapshot omitted confirmed parent quantity');
 rejected:=false;begin perform public.erp_pickup_progress(request,'prepare');exception when others then rejected:=true;end;
 perform public.ci_assert(rejected and (select count(*)=before_stock from public.inventory_transactions) and (select count(*)=before_sales from public.sales),'failed preparation changed stock or sale');
 perform public.ci_assert((select erp_prepared_at is null and erp_sale_id is null from public.sales_orders where id=request),'failed preparation removed demand');

 -- A partial PO receipt is stock now; only the remaining pack is future supply.
 result:=public.erp_purchasing_write(gen_random_uuid(),'create_orders',jsonb_build_object('orders',jsonb_build_array(jsonb_build_object(
 'supplierId',supplier,'locationId',store,'date',day,'send',true,
 'lines',jsonb_build_array(jsonb_build_object('sku','DEFER-C','qty',2,'price',10))))));
 po:=(result->'ids'->>0)::uuid;select id into po_line from public.purchase_order_lines where purchase_order_id=po;
 receipt_payload:=jsonb_build_object('id',po,'revision',0,'date',day,'locationId',store,'final',false,'tax',0,
 'lines',jsonb_build_array(jsonb_build_object('id',po_line,'qty',1,'price',10)));
 result:=public.erp_purchasing_write(receipt_request,'receive_order',receipt_payload);
 repeated:=public.erp_purchasing_write(receipt_request,'receive_order',receipt_payload);
 perform public.ci_assert(result=repeated,'partial receipt retry changed its response');
 snapshot:=public.erp_planning_snapshot();
 perform public.ci_assert(exists(select 1 from jsonb_array_elements(snapshot->'stock')s where s->>'item_sku'='DEFER-C' and s->>'location_id'=store::text and (s->>'quantity')::numeric=10),'partial receipt stock conversion wrong');
 perform public.ci_assert(exists(select 1 from jsonb_array_elements(snapshot->'receipts')r where r->>'id'=po::text and r->>'location_id'=store::text and (r->>'quantity')::numeric=10 and r->>'due'=(day+3)::text),'remaining PO supply/date/location wrong');
 perform set_config('request.jwt.claim.sub',cashier::text,true);
 result:=public.erp_pickup_action(request,'prepare');prepared_sale:=(result->>'sale_id')::uuid;
 perform public.ci_assert(prepared_sale is not null,'preparation omitted sale');
 perform public.ci_assert((select sum(quantity)=0 from public.inventory_transactions where location_id=store and item_sku='DEFER-C'),'preparation did not consume exactly 5 times 2 components');
 perform public.ci_assert((select subtotal=50 and cogs=10 and payment_method='Manual/Simulated' from public.sales where id=prepared_sale),'prepare-time price, cost or tender wrong');
 select count(*) into before_stock from public.inventory_transactions;
 select count(*) into before_sales from public.sales;
 perform public.erp_pickup_action(request,'prepare');
 perform public.erp_pickup_progress(request,'fulfill');perform public.erp_pickup_action(request,'fulfill');
 perform public.erp_pickup_progress(request,'close');perform public.erp_pickup_action(request,'close');
 perform public.ci_assert((select count(*)=before_stock from public.inventory_transactions) and (select count(*)=before_sales from public.sales),'prepare/fulfill/close retry posted twice');
 rejected:=false;begin perform public.erp_pickup_action(request,'cancel');exception when others then rejected:=true;end;
 perform public.ci_assert(rejected,'closed order was cancelled');

 -- Simulated customer payment also stays as future demand despite zero stock.
 perform set_config('request.jwt.claim.sub',customer::text,true);
 customer_payload:=payload||jsonb_build_object('lines',jsonb_build_array(jsonb_build_object('sku','DEFER-P','qty',6)));
 result:=public.erp_checkout_order(customer_request,customer_payload);
 repeated:=public.erp_checkout_order(customer_request,customer_payload);
 perform public.ci_assert(result=repeated and (result->>'simulatedPaid')::boolean and not (result->>'posted')::boolean and result->>'sale_id' is null,'customer checkout consumed stock or lost simulated payment');
 rejected:=false;begin perform public.erp_pickup_action(customer_request,'prepare');exception when insufficient_privilege then rejected:=true;end;
 perform public.ci_assert(rejected,'customer prepared an order');
 perform set_config('request.jwt.claim.sub',manager::text,true);
 perform public.erp_pickup_progress(customer_request,'cancel');perform public.erp_pickup_action(customer_request,'cancel');
 perform public.ci_assert((select count(*)=before_stock from public.inventory_transactions) and (select count(*)=before_sales from public.sales),'new cancellation invented stock or revenue');

 -- Complete a second customer order and preserve its simulated tender at prepare.
 insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type)values('DEFER-C',store,100,1,'Receipt');
 perform set_config('request.jwt.claim.sub',customer::text,true);
 customer_request:=gen_random_uuid();result:=public.erp_checkout_order(customer_request,payload);
 perform set_config('request.jwt.claim.sub',manager::text,true);
 result:=public.erp_pickup_progress(customer_request,'fulfill');
 perform public.ci_assert((select payment_method='Card (simulated)' from public.sales where id=(result->>'sale_id')::uuid),'customer prepare lost simulated tender');

 -- Emulate the existing production records: linked sale, already issued stock,
 -- but physical preparation not marked. Upgrade must never replay their usage.
 legacy_request:=gen_random_uuid();perform public.erp_create_pickup_order(legacy_request,payload);
 result:=public.erp_plan_post_sale(store,'[{"sku":"DEFER-P","qty":5}]',0,0,null);
 legacy_sale:=(result->>'sale_id')::uuid;
 update public.sales_orders set erp_sale_id=legacy_sale where id=legacy_request;
 select count(*) into before_stock from public.inventory_transactions;
 perform public.erp_pickup_action(legacy_request,'prepare');perform public.erp_pickup_progress(legacy_request,'fulfill');
 perform public.ci_assert((select count(*)=before_stock from public.inventory_transactions),'legacy preparation deducted stock twice');
 perform public.ci_assert((select erp_sale_id=legacy_sale from public.sales_orders where id=legacy_request),'legacy preparation replaced its sale');
 legacy_request:=gen_random_uuid();perform public.erp_create_pickup_order(legacy_request,payload);
 result:=public.erp_plan_post_sale(store,'[{"sku":"DEFER-P","qty":5}]',0,0,null);
 legacy_sale:=(result->>'sale_id')::uuid;
 update public.sales_orders set erp_sale_id=legacy_sale where id=legacy_request;
 select sum(quantity) into balance from public.inventory_transactions where item_sku='DEFER-C' and location_id=store;
 select count(*) into before_reversals from public.inventory_transactions where transaction_type='Sale Reversal';
 perform public.erp_pickup_progress(legacy_request,'cancel');perform public.erp_pickup_action(legacy_request,'cancel');
 perform public.ci_assert((select sum(quantity)=balance+10 from public.inventory_transactions where item_sku='DEFER-C' and location_id=store),'legacy cancellation did not restore exactly its stock');
 perform public.ci_assert((select count(*)=before_reversals+1 from public.inventory_transactions where transaction_type='Sale Reversal'),'legacy cancel retry restored twice');
 perform public.ci_assert((select status='Cancelled' from public.sales where id=legacy_sale),'legacy cancellation left revenue active');
 -- POS remains immediate and cannot spend stock at another location.
 select sum(quantity) into balance from public.inventory_transactions where item_sku='DEFER-C' and location_id=store;
 perform public.record_sale(store,'[{"sku":"DEFER-P","qty":1}]',0,null);
 perform public.ci_assert((select sum(quantity)=balance-2 from public.inventory_transactions where item_sku='DEFER-C' and location_id=store),'POS no longer consumes immediately');
 rejected:=false;begin perform public.record_sale(other_store,'[{"sku":"DEFER-P","qty":1}]',0,null);exception when others then rejected:=true;end;
 perform public.ci_assert(rejected,'POS pooled another location stock');
 perform set_config('request.jwt.claim.sub','',true);
 rejected:=false;begin perform public.erp_create_pickup_order(gen_random_uuid(),payload);exception when insufficient_privilege then rejected:=true;end;
 perform public.ci_assert(rejected,'anonymous order creation');
end $$;
rollback;
\echo 'PASS: stockless staff/customer confirmation, MRP eligibility, partial PO conversion/date/location, failed preparation rollback, prepare-time revenue/tender, once-only retries, new/legacy cancellation, legacy stock preservation, immediate POS and access checks.'
