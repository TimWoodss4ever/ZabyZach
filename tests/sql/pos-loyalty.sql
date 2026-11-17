-- Disposable CI database only; rollback every test customer and sale.
\set ON_ERROR_STOP on
begin;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
select public.ci_assert(not has_function_privilege('anon','public.erp_pos_customer(text,text)','EXECUTE'),'anon loyalty lookup');
select public.ci_assert(not has_function_privilege('authenticated','public.erp_rewards_balance(uuid)','EXECUTE'),'raw balance helper exposed');
do $$declare store uuid; customer uuid; result jsonb; redeemed jsonb; request uuid:=gen_random_uuid(); before_count integer; line uuid; rejected boolean;
begin
 select id into store from public.locations where can_sell order by name limit 1;
 insert into public.items(sku,name,category,barcode,base_unit,purchase_unit,unit_cost,selling_price) values('CI-POS','POS test drink','Beverage','CI-POS-BARCODE','each','case',1,5);
 insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type) values('CI-POS',store,1000,1,'Receipt');
 perform public.ci_assert(public.erp_pos_customer('8015550199') is null,'unknown member should be null');
 result:=public.erp_pos_customer('(801)555-0199','CI Andrew');customer:=(result->>'id')::uuid;
 perform public.ci_assert((public.erp_pos_customer('+1 801 555 0199')->>'id')::uuid=customer,'phone normalization mismatch');
 result:=public.erp_pos_sale(request,store,'[{"sku":"CI-POS","qty":24}]',0,'8015550199','CI Andrew',false);
 perform public.ci_assert((result->>'rewards_earned')::integer=120 and (result->>'rewards_balance')::integer=120,'earn before tax and retain unreturned points');
 select count(*) into before_count from public.sales;
 perform public.ci_assert(public.erp_pos_sale(request,store,'[{"sku":"CI-POS","qty":24}]',0,'8015550199','CI Andrew',false)=result,'idempotent reply changed');
 perform public.ci_assert((select count(*) from public.sales)=before_count,'duplicate request posted twice');
 rejected:=false;begin perform public.erp_pos_sale(request,store,'[{"sku":"CI-POS","qty":1}]',0,'8015550199','CI Andrew',false);exception when others then rejected:=true;end;
 perform public.ci_assert(rejected,'changed request accepted');
 redeemed:=public.erp_pos_sale(gen_random_uuid(),store,'[{"sku":"CI-POS","qty":2}]',0,'8015550199','CI Andrew',true);
 perform public.ci_assert((redeemed->>'discount')::numeric=5 and (redeemed->>'rewards_earned')::integer=5 and (redeemed->>'rewards_balance')::integer=25,'redemption or points calculation');
 select id into line from public.sale_lines where sale_id=(redeemed->>'sale_id')::uuid;
 perform public.process_return(gen_random_uuid(),line,1,'Wrong order','Restock');
 perform public.ci_assert(public.erp_rewards_balance(customer)=72,'partial refund points');
 perform public.process_return(gen_random_uuid(),line,1,'Wrong order','Restock');
 perform public.ci_assert(public.erp_rewards_balance(customer)=120,'full refund points');
 -- Exactly $5 becomes a zero-dollar sale; points stay spent until an actual return.
 redeemed:=public.erp_pos_sale(gen_random_uuid(),store,'[{"sku":"CI-POS","qty":1}]',0,'8015550199','CI Andrew',true);
 perform public.ci_assert((redeemed->>'rewards_balance')::integer=20,'free rewarded sale restored unreturned points');
 select id into line from public.sale_lines where sale_id=(redeemed->>'sale_id')::uuid;
 perform public.process_return(gen_random_uuid(),line,1,'Wrong order','Restock');
 perform public.ci_assert(public.erp_rewards_balance(customer)=120,'zero-dollar refund did not restore points');
 -- A failed stock check must roll back enrollment, rewards, and idempotency record.
 rejected:=false;begin perform public.erp_pos_sale(gen_random_uuid(),store,'[{"sku":"CI-POS","qty":999999}]',0,'3855550199','Should rollback',false);exception when others then rejected:=true;end;
 perform public.ci_assert(rejected and public.erp_pos_customer('3855550199') is null,'failed checkout enrolled a customer');
 perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000003',true);
 rejected:=false;begin perform public.erp_pos_customer('8015550199');exception when insufficient_privilege then rejected:=true;end;
 perform public.ci_assert(rejected,'customer role lookup allowed');
 perform set_config('request.jwt.claim.sub','',true);
 rejected:=false;begin perform public.erp_pos_customer('8015550199');exception when insufficient_privilege then rejected:=true;end;
 perform public.ci_assert(rejected,'missing identity lookup allowed');
end $$;
rollback;
