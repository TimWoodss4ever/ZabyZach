-- DISPOSABLE CI DATABASE ONLY. Never run these fixtures in production.
-- Apply twice: additive function rollout must preserve data and be repeatable.
create temp table eoq_preserved as select 'stock' kind,count(*) n from public.inventory_transactions
 union all select 'orders',count(*) from public.purchase_orders
 union all select 'sales',count(*) from public.sales;
\ir ../../supabase/migrations/202611210002_mrp_eoq_review.sql
\ir ../../supabase/migrations/202611210002_mrp_eoq_review.sql
select public.ci_assert(not exists(select * from eoq_preserved except
 (select 'stock',count(*) from public.inventory_transactions union all select 'orders',count(*) from public.purchase_orders union all select 'sales',count(*) from public.sales)), 'EOQ rollout changed business rows');
begin;
do $$declare
 loc uuid:=gen_random_uuid();other_loc uuid:=gen_random_uuid();supplier uuid:=gen_random_uuid();request uuid:=gen_random_uuid();mrp_request uuid:=gen_random_uuid();
 payload jsonb;result jsonb;snapshot jsonb;line jsonb;orders jsonb;rejected boolean;day date:=(now() at time zone 'America/Denver')::date;
begin
 perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
 insert into public.locations(id,name,can_sell)values(loc,'EOQ fixture',true),(other_loc,'EOQ other location',true);
 insert into public.suppliers(id,name,quoted_lead_days,payment_terms_days)values(supplier,'EOQ fixture supplier',3,30);
 insert into public.items(sku,name,category,barcode,base_unit,purchase_unit,conversion_factor,unit_cost,selling_price,supplier_id,lead_days)
 values('EOQ-A','EOQ component A','Ingredient','EOQ-A','oz','bag',64,1,0,supplier,3),('EOQ-B','EOQ component B','Ingredient','EOQ-B','oz','bag',64,1,0,supplier,3);
 insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type,occurred_at)values('EOQ-A',loc,-180,1,'Sale',now()-interval '1 day');
 snapshot:=public.erp_planning_snapshot();
 perform public.ci_assert(snapshot->'purchasePolicy'->>'version'='1','EOQ policy unavailable');
 perform public.ci_assert((snapshot->'purchasePolicy'->'options'->>'holding_rate')::numeric>0,'shared options unavailable');
 perform public.ci_assert(exists(select 1 from jsonb_array_elements(snapshot->'purchasePolicy'->'usage')u where u->>'item_sku'='EOQ-A' and u->>'location_id'=loc::text and (u->>'daily')::numeric=1),'location usage differs from historical source');
 line:=jsonb_build_object('sku','EOQ-A','qty',2,'price',64);
 orders:=jsonb_build_array(jsonb_build_object('supplierId',supplier,'locationId',loc,'date',day,'send',false,'notes','Created during shared inventory review','lines',jsonb_build_array(line)));
 payload:=jsonb_build_object('orders',orders);
 result:=public.erp_purchasing_write(request,'create_orders',payload);
 perform public.ci_assert(public.erp_purchasing_write(request,'create_orders',payload)=result,'idempotent draft recovery failed');
 snapshot:=public.erp_planning_snapshot();
 perform public.ci_assert(exists(select 1 from jsonb_array_elements(snapshot->'purchaseDrafts')p where p->>'item_sku'='EOQ-A' and p->>'location_id'=loc::text and p->>'source'='Inventory Review' and p->>'po_no' is not null),'inventory draft absent from MRP');
 perform public.ci_assert(not exists(select 1 from jsonb_array_elements(snapshot->'receipts')r where r->>'id'=result->'ids'->>0),'draft counted as supply');
 rejected:=false;begin perform public.erp_purchasing_write(gen_random_uuid(),'create_orders',payload);exception when others then if sqlerrm like '%purchase draft already exists%' then rejected:=true;else raise;end if;end;
 perform public.ci_assert(rejected,'inventory/manual workflow bypassed existing draft');
 orders:=jsonb_set(orders,'{0,requiredOn}',to_jsonb(day+7));orders:=jsonb_set(orders,'{0,orderBy}',to_jsonb(day+4));orders:=jsonb_set(orders,'{0,notes}','"MRP confirmed requirements EOQ test"');
 payload:=jsonb_build_object('revision',public.erp_read_revision(),'orders',orders);
 rejected:=false;begin perform public.erp_mrp_purchase_drafts(gen_random_uuid(),'create_orders',payload);exception when others then if sqlerrm like '%purchase draft already exists%' then rejected:=true;else raise;end if;end;
 perform public.ci_assert(rejected,'MRP bypassed inventory draft');
 -- Review the existing proposal without sending it or changing dates/stock.
 perform public.erp_purchasing_write(gen_random_uuid(),'edit_draft',jsonb_build_object('id',result->'ids'->>0,'revision',0,'lines',(select jsonb_agg(jsonb_build_object('id',id,'qty',3,'price',64)) from public.purchase_order_lines where purchase_order_id=(result->'ids'->>0)::uuid)));
 perform public.ci_assert((select quantity_purchase=3 from public.purchase_order_lines where purchase_order_id=(result->'ids'->>0)::uuid),'draft edit not saved');
 perform public.ci_assert((select status='Draft' and erp_revision=1 from public.purchase_orders where id=(result->'ids'->>0)::uuid),'edit issued draft or missed revision');
 -- Different destinations remain independent.
 payload:=jsonb_set(payload,'{orders,0,locationId}',to_jsonb(other_loc));payload:=jsonb_set(payload,'{revision}',to_jsonb(public.erp_read_revision()));
 perform public.erp_mrp_purchase_drafts(gen_random_uuid(),'create_orders',payload);
 -- Multiple requirement dates in one MRP request are intentional, not duplicates.
 orders:=jsonb_set(orders,'{0,lines,0,sku}','"EOQ-B"');
 orders:=orders||jsonb_build_array(jsonb_set(jsonb_set(orders->0,'{requiredOn}',to_jsonb(day+14)),'{orderBy}',to_jsonb(day+11)));
 payload:=jsonb_build_object('revision',public.erp_read_revision(),'orders',orders);
 result:=public.erp_mrp_purchase_drafts(mrp_request,'create_orders',payload);
 perform public.ci_assert(jsonb_array_length(result->'ids')=2,'dated groups incorrectly blocked');
 perform public.ci_assert(public.erp_mrp_purchase_drafts(mrp_request,'create_orders',payload)=result,'MRP retry did not recover after revision changed');
 perform public.ci_assert((select count(*) from public.purchase_orders where id in(select value::uuid from jsonb_array_elements_text(result->'ids')) and erp_mrp_required_on is not null and erp_mrp_order_by=erp_mrp_required_on-3)=2,'dates lost');
 -- Issued POs become dated receipts; actual stock does not change until receipt.
 perform public.erp_purchasing_write(gen_random_uuid(),'send_order',jsonb_build_object('id',result->'ids'->>0,'revision',0));
 snapshot:=public.erp_planning_snapshot();perform public.ci_assert(exists(select 1 from jsonb_array_elements(snapshot->'receipts')r where r->>'id'=result->'ids'->>0),'issued PO missing from dated supply');
 -- Receiving still posts stock once after the guard and edit extension.
 request:=gen_random_uuid();
 snapshot:=jsonb_build_object('id',result->'ids'->>0,'revision',1,'date',day,'locationId',loc,'final',true,'tax',0,'lines',(select jsonb_agg(jsonb_build_object('id',id,'qty',quantity_purchase,'price',unit_price_purchase)) from public.purchase_order_lines where purchase_order_id=(result->'ids'->>0)::uuid));
 perform public.erp_purchasing_write(request,'receive_order',snapshot);
 perform public.erp_purchasing_write(request,'receive_order',snapshot);
 perform public.ci_assert((select sum(quantity)=128 from public.inventory_transactions where item_sku='EOQ-B' and location_id=loc),'receipt was not posted exactly once');
 -- Options changes invalidate the purchase review revision, even with unchanged orders.
 payload:=jsonb_set(payload,'{revision}',to_jsonb(public.erp_read_revision()));
 update public.erp_purchasing_options set order_cost=order_cost+1,revision=revision+1;
 rejected:=false;begin perform public.erp_mrp_purchase_drafts(gen_random_uuid(),'create_orders',payload);exception when others then if sqlerrm like '%Planning data changed%' then rejected:=true;else raise;end if;end;
 perform public.ci_assert(rejected,'ordering policy change did not invalidate MRP review');
 perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000003',true);
 rejected:=false;begin perform public.erp_planning_snapshot();exception when insufficient_privilege then rejected:=true;end;perform public.ci_assert(rejected,'customer can read private policy');
end $$;
rollback;
