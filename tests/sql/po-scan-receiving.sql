-- Disposable CI only. All test receipts/orders below roll back.
select public.ci_assert(public.erp_receipt_visibility_time('2026-11-17 12:00 America/Denver','2026-11-17 09:00 America/Denver')='2026-11-17 09:00 America/Denver'::timestamptz,'morning receipt was dated in the future');
select public.ci_assert(public.erp_receipt_visibility_time('2026-11-16 12:00 America/Denver','2026-11-17 09:00 America/Denver')='2026-11-16 12:00 America/Denver'::timestamptz,'historical receipt timestamp changed');
select public.ci_assert(public.erp_receipt_visibility_time('2026-11-17 12:00 America/Denver','2026-11-17 18:00 America/Denver')='2026-11-17 12:00 America/Denver'::timestamptz,'already-visible receipt timestamp changed');
begin;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
do $$declare supplier uuid;dest uuid;po uuid;line uuid;request uuid:=gen_random_uuid();payload jsonb;answer jsonb;receipt uuid;before_count bigint;day date:=(now() at time zone 'America/Denver')::date;
begin
 select id into supplier from public.suppliers where erp_active order by id limit 1;
 select id into dest from public.locations order by id limit 1;
 insert into public.items(sku,name,category,barcode,base_unit,purchase_unit,conversion_factor,unit_cost,selling_price,lead_days,supplier_id)
 values('CI-PO-SCAN','PO scan receiving fixture','Ingredient','CI-PO-SCAN','oz','5 lb bag',80,1,0,1,supplier);
 answer:=public.erp_purchasing_write(gen_random_uuid(),'create_orders',jsonb_build_object('orders',jsonb_build_array(jsonb_build_object('supplierId',supplier,'locationId',dest,'date',day,'send',true,'notes','CI barcode receipt','lines',jsonb_build_array(jsonb_build_object('sku','CI-PO-SCAN','qty',3,'price',80))))));
 select id into po from public.purchase_orders where erp_notes='CI barcode receipt';
 select id into line from public.purchase_order_lines where purchase_order_id=po;
 payload:=jsonb_build_object('id',po,'revision',1,'date',day,'locationId',dest,'final',false,'tax',0,'lines',jsonb_build_array(jsonb_build_object('id',line,'qty',2,'price',80)));
 -- Read the actual revision, rather than assuming a starting sequence.
 payload:=jsonb_set(payload,'{revision}',to_jsonb((select erp_revision from public.purchase_orders where id=po)));
 select count(*) into before_count from public.inventory_transactions where item_sku='CI-PO-SCAN';
 answer:=public.erp_purchasing_write(request,'receive_order',payload);
 select id into receipt from public.erp_purchase_receipts where purchase_order_id=po;
 perform public.ci_assert((select sum(quantity)=160 from public.inventory_transactions where item_sku='CI-PO-SCAN' and location_id=dest and occurred_at<=now()),'receipt not immediately visible at selected location in base units');
 perform public.ci_assert((select sum(quantity)=160 from public.inventory_transactions where item_sku='CI-PO-SCAN'),'receipt changed another location or doubled quantity');
 perform public.ci_assert((select count(*)=1 and sum(amount)=160 from public.supplier_invoices where purchase_order_id=po),'receipt invoice not atomic');
 perform public.ci_assert((select status='Partially Received' from public.purchase_orders where id=po),'partial receipt status incorrect');
 perform public.erp_purchasing_write(request,'receive_order',payload);
 perform public.ci_assert((select count(*)=before_count+1 from public.inventory_transactions where item_sku='CI-PO-SCAN'),'same receipt request increased inventory twice');
 perform public.ci_assert((select count(*)=1 from public.supplier_invoices where purchase_order_id=po),'same receipt request duplicated invoice');
end $$;
rollback;
select 'PASS: new receipt timestamps, immediate location stock, purchase-to-base conversion, atomic invoice, partial order and idempotent receipt retry.' as result;
