-- DISPOSABLE CI DATABASE ONLY. Never execute test fixtures in live Supabase.
\set ON_ERROR_STOP on
create temporary table inventory_original_rows(table_name text,row_value jsonb);
do $$declare t record;begin
 for t in select tablename from pg_tables where schemaname='public' loop
  execute format('insert into inventory_original_rows select %L,to_jsonb(t) from public.%I t',t.tablename,t.tablename);
 end loop;
end$$;
create temporary table inventory_original_functions as select p.oid,p.proname,pg_get_functiondef(p.oid) definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f';
\ir ../../supabase/migrations/202611160004_inventory_management.sql
\ir ../../supabase/migrations/202611160004_inventory_management.sql
do $$declare old record;ok boolean;begin
 for old in select * from inventory_original_rows loop
  execute format('select exists(select 1 from public.%I t where to_jsonb(t)=$1)',old.table_name) into ok using old.row_value;
  perform public.ci_assert(ok,'inventory migration changed existing records: '||old.table_name);
 end loop;
 for old in select * from inventory_original_functions where proname not in ('require_staff','post_transfer','post_adjustment') loop
  perform public.ci_assert(pg_get_functiondef(old.oid)=old.definition,'inventory migration changed an unrelated routine: '||old.proname);
 end loop;
end$$;
select public.ci_assert(not has_function_privilege('anon','public.post_transfer(text,uuid,uuid,numeric)','EXECUTE'),'anonymous transfer execute');
select public.ci_assert(not has_function_privilege('anon','public.post_adjustment(text,uuid,numeric,text)','EXECUTE'),'anonymous count execute');
select public.ci_assert(not has_function_privilege('anon','public.erp_inventory_snapshot()','EXECUTE'),'anonymous inventory read');
select public.ci_assert(not has_function_privilege('anon','public.erp_inventory_write(uuid,text,jsonb)','EXECUTE'),'anonymous inventory write');
select public.ci_assert(not has_table_privilege('authenticated','public.erp_inventory_backorders','INSERT'),'direct backorder insertion');
select public.ci_assert(not has_table_privilege('authenticated','public.erp_inventory_requests','UPDATE'),'direct request mutation');

do $$declare uid uuid;failed boolean;loc uuid;other uuid;begin
 select id into loc from public.locations order by name limit 1;select id into other from public.locations where id<>loc limit 1;
 foreach uid in array array[null::uuid,'00000000-0000-0000-0000-000000000003'::uuid,'00000000-0000-0000-0000-000000000004'::uuid] loop
  perform set_config('request.jwt.claim.sub',coalesce(uid::text,''),true);
  failed:=false;begin perform public.post_transfer('1018',loc,other,1);exception when insufficient_privilege then failed:=true;end;perform public.ci_assert(failed,'missing/customer identity transfer');
  failed:=false;begin perform public.post_adjustment('1018',loc,0,'Cycle count correction');exception when insufficient_privilege then failed:=true;end;perform public.ci_assert(failed,'missing/customer identity adjustment');
  failed:=false;begin perform public.erp_inventory_snapshot();exception when insufficient_privilege then failed:=true;end;perform public.ci_assert(failed,'missing/customer identity read');
  failed:=false;begin perform public.erp_inventory_write(gen_random_uuid(),'transfer','{}');exception when insufficient_privilege then failed:=true;end;perform public.ci_assert(failed,'missing/customer identity gateway');
 end loop;
 perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',true);perform public.erp_inventory_snapshot();
end$$;

insert into public.suppliers(id,name,quoted_lead_days,payment_terms_days) values('00000000-0000-0000-0000-000000000841','Inventory fixture supplier',5,30);
insert into public.items(sku,name,category,barcode,base_unit,purchase_unit,conversion_factor,unit_cost,selling_price,supplier_id,lead_days) values
 ('INV-EACH','Inventory can','Beverage','INV-EACH','each','case of 24',24,.35,1.5,'00000000-0000-0000-0000-000000000841',99),
 ('INV-OZ','Inventory ounce','Ingredient','INV-OZ','oz','bag',10,.5,0,'00000000-0000-0000-0000-000000000841',99),
 ('INV-MADE','Inventory made item','Ingredient','INV-MADE','each','each',1,0,0,null,0);
insert into public.bom_lines(parent_sku,component_sku,quantity) values('INV-MADE','INV-OZ',2);
insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type,reference_document)
 select 'INV-EACH',id,20,.35,'Receipt','Inventory test opening' from public.locations order by name limit 1;
insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type,reference_document)
 select 'INV-OZ',id,12.5,.5,'Receipt','Inventory test opening' from public.locations order by name limit 1;
insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type,reference_document)
 select 'INV-MADE',id,4,1,'Production Receipt','Inventory test opening' from public.locations order by name limit 1;

do $$declare loc uuid;other uuid;request uuid;payload jsonb;answer jsonb;again jsonb;snapshot jsonb;first_id uuid;second_id uuid;third_id uuid;before_count integer;before_stock numeric;failed boolean;bad numeric;tx uuid;d date:=(now() at time zone 'America/Denver')::date;
begin
 perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
 select id into loc from public.locations order by name limit 1;select id into other from public.locations where id<>loc order by name limit 1;
 -- A transfer is paired, conserves company quantity/value, and safely retries.
 request:=gen_random_uuid();payload:=jsonb_build_object('sku','INV-EACH','fromId',loc,'toId',other,'quantity',5);
 answer:=public.erp_inventory_write(request,'transfer',payload);again:=public.erp_inventory_write(request,'transfer',payload);perform public.ci_assert(answer=again,'transfer retry differs');
 perform public.ci_assert((select count(*)=2 and sum(quantity)=0 and sum(quantity*unit_cost)=0 from public.inventory_transactions where reference_document=answer->>'resourceId'),'transfer not paired/conserved');
 perform public.ci_assert((select sum(quantity)=20 from public.inventory_transactions where item_sku='INV-EACH'),'company units changed');
 failed:=false;begin perform public.erp_inventory_write(request,'transfer',payload||'{"quantity":1}'::jsonb);exception when others then failed:=true;end;perform public.ci_assert(failed,'request reused with other data');
 foreach bad in array array[-1::numeric,0::numeric,.5::numeric,'NaN'::numeric,'Infinity'::numeric,null::numeric] loop
  select count(*) into before_count from public.inventory_transactions;failed:=false;
  begin perform public.post_transfer('INV-EACH',loc,other,bad);exception when others then failed:=true;end;
  perform public.ci_assert(failed and (select count(*)=before_count from public.inventory_transactions),'invalid transfer posted');
 end loop;
 failed:=false;begin perform public.post_transfer('INV-EACH',loc,loc,1);exception when others then failed:=true;end;perform public.ci_assert(failed,'same location transfer');
 failed:=false;begin perform public.post_transfer('INV-EACH',loc,other,1000);exception when others then failed:=true;end;perform public.ci_assert(failed,'oversized transfer');
 -- Physical count = 17, then damage quantity 3 is submitted as remaining stock 14.
 answer:=public.erp_inventory_write(gen_random_uuid(),'adjustment',jsonb_build_object('sku','INV-EACH','locationId',loc,'counted',17,'reason','Cycle count correction'));
 perform public.ci_assert((answer->>'variance')::numeric=2,'count variance');
 request:=gen_random_uuid();payload:=jsonb_build_object('sku','INV-EACH','locationId',loc,'counted',14,'reason','Damaged');
 answer:=public.erp_inventory_write(request,'adjustment',payload);again:=public.erp_inventory_write(request,'adjustment',payload);perform public.ci_assert(answer=again,'damage retry');
 perform public.ci_assert((answer->>'variance')::numeric=-3 and (select sum(quantity)=14 from public.inventory_transactions where item_sku='INV-EACH' and location_id=loc),'damage remaining count');
 perform public.ci_assert(exists(select 1 from public.inventory_transactions where item_sku='INV-EACH' and reason_code='Damaged' and transaction_type='Waste' and quantity=-3 and user_id=auth.uid() and metadata->>'counted_quantity'='14'),'damage reason/audit/type');
 foreach bad in array array[-1::numeric,.5::numeric,'NaN'::numeric,'Infinity'::numeric,null::numeric] loop
  select count(*) into before_count from public.inventory_transactions;failed:=false;
  begin perform public.post_adjustment('INV-EACH',loc,bad,'Cycle count correction');exception when others then failed:=true;end;
  perform public.ci_assert(failed and (select count(*)=before_count from public.inventory_transactions),'invalid count posted');
 end loop;
 failed:=false;begin perform public.post_adjustment('INV-EACH',loc,14,'Invented');exception when others then failed:=true;end;perform public.ci_assert(failed,'arbitrary reason accepted');
 failed:=false;begin perform public.post_adjustment('INV-EACH',loc,15,'Damaged');exception when others then failed:=true;end;perform public.ci_assert(failed,'damage increased stock');
 select count(*) into before_count from public.inventory_transactions;perform public.post_adjustment('INV-EACH',loc,14,'Cycle count correction');perform public.ci_assert((select count(*)=before_count from public.inventory_transactions),'zero variance posted');
 tx:=public.post_transfer('INV-OZ',loc,other,.5);perform public.ci_assert((select sum(quantity)=0 from public.inventory_transactions where reference_document=tx::text),'fractional ounces transfer');
 tx:=public.post_transfer('INV-MADE',loc,other,1);perform public.ci_assert((select bool_and(unit_cost=1) from public.inventory_transactions where reference_document=tx::text),'made-item rollup cost');
 -- Two distinct backorders, including partial fulfillment and FIFO shortage guards.
 request:=gen_random_uuid();payload:=jsonb_build_object('sku','INV-EACH','locationId',loc,'quantity',20,'reference','Order A','notes','Inventory test');
 answer:=public.erp_inventory_write(request,'create_backorder',payload);again:=public.erp_inventory_write(request,'create_backorder',payload);first_id:=(answer->>'resourceId')::uuid;perform public.ci_assert(answer=again,'backorder retry duplicated');
 update public.erp_inventory_backorders set created_at=now()-interval '1 minute' where id=first_id;
 answer:=public.erp_inventory_write(gen_random_uuid(),'create_backorder',jsonb_build_object('sku','INV-EACH','locationId',loc,'quantity',10,'reference','Order B'));second_id:=(answer->>'resourceId')::uuid;
 perform public.ci_assert((select sum(quantity)=14 from public.inventory_transactions where item_sku='INV-EACH' and location_id=loc),'creating demand changed physical stock');
 request:=gen_random_uuid();payload:=jsonb_build_object('id',first_id,'quantity',8);answer:=public.erp_inventory_write(request,'fulfill_backorder',payload);again:=public.erp_inventory_write(request,'fulfill_backorder',payload);perform public.ci_assert(answer=again,'fulfillment retry duplicated');
 perform public.ci_assert((select quantity_fulfilled=8 and status='Open' from public.erp_inventory_backorders where id=first_id),'partial fulfillment state');
 perform public.ci_assert((select sum(quantity)=6 from public.inventory_transactions where item_sku='INV-EACH' and location_id=loc),'partial fulfillment stock');
 failed:=false;begin perform public.erp_inventory_write(gen_random_uuid(),'fulfill_backorder',jsonb_build_object('id',second_id,'quantity',1));exception when others then failed:=true;end;perform public.ci_assert(failed,'later backorder took earlier queue stock');
 insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type,reference_document) values('INV-EACH',loc,30,.35,'Receipt','Inventory fulfillment replenishment');
 perform public.erp_inventory_write(gen_random_uuid(),'fulfill_backorder',jsonb_build_object('id',first_id,'quantity',12));perform public.erp_inventory_write(gen_random_uuid(),'fulfill_backorder',jsonb_build_object('id',second_id,'quantity',10));
 perform public.ci_assert((select bool_and(status='Fulfilled') from public.erp_inventory_backorders where id in(first_id,second_id)),'complete backorder state');
 answer:=public.erp_inventory_write(gen_random_uuid(),'create_backorder',jsonb_build_object('sku','INV-EACH','locationId',loc,'quantity',5,'reference','Order C'));third_id:=(answer->>'resourceId')::uuid;
 perform public.erp_inventory_write(gen_random_uuid(),'fulfill_backorder',jsonb_build_object('id',third_id,'quantity',2));select sum(quantity) into before_stock from public.inventory_transactions where item_sku='INV-EACH' and location_id=loc;
 perform public.erp_inventory_write(gen_random_uuid(),'cancel_backorder',jsonb_build_object('id',third_id,'reason','Customer cancelled remainder'));
 perform public.ci_assert((select status='Cancelled' and quantity_fulfilled=2 and cancellation_reason='Customer cancelled remainder' from public.erp_inventory_backorders where id=third_id),'cancelled history');
 perform public.ci_assert((select sum(quantity)=before_stock from public.inventory_transactions where item_sku='INV-EACH' and location_id=loc),'cancel changed physical stock');
 failed:=false;begin perform public.erp_inventory_write(gen_random_uuid(),'fulfill_backorder',jsonb_build_object('id',third_id,'quantity',1));exception when others then failed:=true;end;perform public.ci_assert(failed,'cancelled backorder fulfillment');
 -- Snapshot uses assigned supplier lead and exact unreceived pack conversions.
 insert into public.purchase_orders(id,po_no,supplier_id,ship_to_location_id,ordered_at,expected_at,status) values
  ('00000000-0000-0000-0000-000000000851','INV-PARTIAL','00000000-0000-0000-0000-000000000841',loc,now(),((d+2)::text||' 12:00 America/Denver')::timestamptz,'Partially Received'),
  ('00000000-0000-0000-0000-000000000852','INV-FINAL-SHORT','00000000-0000-0000-0000-000000000841',loc,now(),now(),'Received');
 insert into public.purchase_order_lines(purchase_order_id,item_sku,quantity_purchase,quantity_received_purchase,unit_price_purchase) values
  ('00000000-0000-0000-0000-000000000851','INV-EACH',2,.5,8.4),('00000000-0000-0000-0000-000000000852','INV-EACH',2,.5,8.4);
 snapshot:=public.erp_inventory_snapshot();
 perform public.ci_assert(jsonb_array_length(snapshot->'locations')>=3,'at least three locations');
 perform public.ci_assert(exists(select 1 from jsonb_array_elements(snapshot->'incoming') e where e->>'poNo'='INV-PARTIAL' and (e->>'quantity')::numeric=36 and e->>'locationId'=loc::text and (e->>'expectedOn')::date=d+2),'remaining receipt/destination/date');
 perform public.ci_assert(not exists(select 1 from jsonb_array_elements(snapshot->'incoming') e where e->>'poNo'='INV-FINAL-SHORT'),'closed short counted as promised incoming');
 perform public.ci_assert(exists(select 1 from jsonb_array_elements(snapshot->'items') e where e->>'sku'='INV-EACH' and (e->>'leadDays')::integer=5),'used stale item lead instead of supplier');
 update public.suppliers set quoted_lead_days=7 where id='00000000-0000-0000-0000-000000000841';snapshot:=public.erp_inventory_snapshot();
 perform public.ci_assert(exists(select 1 from jsonb_array_elements(snapshot->'items') e where e->>'sku'='INV-EACH' and (e->>'leadDays')::integer=7),'supplier update not reflected');
 perform public.ci_assert((select count(*) from public.erp_inventory_requests)=(select count(*) from public.erp_inventory_audit),'one audit per successful request');
end$$;
-- Verify repeat migration preserves newly recorded inventory/backorders too.
create temporary table inventory_saved_requests as select * from public.erp_inventory_requests;
create temporary table inventory_saved_backorders as select * from public.erp_inventory_backorders;
\ir ../../supabase/migrations/202611160004_inventory_management.sql
select public.ci_assert(not exists(select 1 from inventory_saved_requests x where not exists(select 1 from public.erp_inventory_requests y where to_jsonb(y)=to_jsonb(x))),'repeat lost requests');
select public.ci_assert(not exists(select 1 from inventory_saved_backorders x where not exists(select 1 from public.erp_inventory_backorders y where to_jsonb(y)=to_jsonb(x))),'repeat lost backorders');
select 'PASS: inventory schema preservation, role and grant checks, paired transfers, negative/NaN/fraction guards, damage audit, recipe costs, idempotency, FIFO partial/full/cancelled backorders, supplier dates and remaining-pack quantities';
