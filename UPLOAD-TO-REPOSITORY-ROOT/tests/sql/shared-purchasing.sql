\set ON_ERROR_STOP on
create function public.ci_assert(ok boolean,message text) returns void language plpgsql as $$begin if ok is distinct from true then raise exception 'TEST FAILED: %',message;end if;end$$;
-- Original values remain a subset of each row: new columns are allowed, rewrites are not.
do $$declare old record; found_row boolean;begin
 for old in select * from public.ci_original_rows loop
  execute format('select exists(select 1 from public.%I t where to_jsonb(t) @> $1)',old.table_name) into found_row using old.row_value;
  perform public.ci_assert(found_row,'migration rewrote or removed original '||old.table_name);
 end loop;
 for old in select * from public.ci_original_functions loop perform public.ci_assert(pg_get_functiondef(old.oid)=old.definition,'original database function changed');end loop;
end$$;
select public.ci_assert(not has_function_privilege('anon','public.erp_purchasing_snapshot()','EXECUTE'),'anonymous snapshot access');
select public.ci_assert(not has_function_privilege('anon','public.erp_purchasing_write(uuid,text,jsonb)','EXECUTE'),'anonymous write access');
select public.ci_assert(has_function_privilege('authenticated','public.erp_purchasing_write(uuid,text,jsonb)','EXECUTE'),'authenticated RPC grant missing');
select public.ci_assert(not has_table_privilege('authenticated','public.erp_supplier_payments','INSERT'),'direct payment insertion allowed');
select public.ci_assert(not has_table_privilege('authenticated','public.erp_purchase_receipts','UPDATE'),'direct receipt mutation allowed');

do $$declare
 manager uuid:='00000000-0000-0000-0000-000000000001'; supplier uuid:='00000000-0000-0000-0000-000000000010';
 day date:=(now() at time zone 'America/Denver')::date; dest uuid; other_dest uuid; po uuid; line uuid; invoice uuid; first_receipt uuid; second_receipt uuid;
 request uuid; payload jsonb; answer jsonb; again jsonb; failed boolean; before_count integer; before_stock numeric; before_amount numeric; before_pay numeric; qty numeric;
begin
 select id into dest from public.locations order by name limit 1;select id into other_dest from public.locations where id<>dest order by name limit 1;
 -- Explicitly reject missing profile, Cashier, Customer, and no authenticated identity.
 foreach manager in array array[null::uuid,'00000000-0000-0000-0000-000000000004'::uuid,'00000000-0000-0000-0000-000000000002'::uuid,'00000000-0000-0000-0000-000000000003'::uuid] loop
  perform set_config('request.jwt.claim.sub',coalesce(manager::text,''),true);failed:=false;
  begin perform public.erp_purchasing_snapshot();exception when insufficient_privilege then failed:=true;end;
  perform public.ci_assert(failed,'non-manager read allowed');failed:=false;
  begin perform public.erp_purchasing_write(gen_random_uuid(),'inventory_review','{"notes":"no access"}'::jsonb);exception when insufficient_privilege then failed:=true;end;
  perform public.ci_assert(failed,'non-manager write allowed');
 end loop;
 manager:='00000000-0000-0000-0000-000000000001';perform set_config('request.jwt.claim.sub',manager::text,true);
 answer:=public.erp_purchasing_snapshot();perform public.ci_assert((answer->>'version')::integer=1,'snapshot version');
 perform public.ci_assert((select paid_at is not null and amount=800 from public.supplier_invoices where id='00000000-0000-0000-0000-000000000022'),'legacy invoice altered');
 -- A final half delivery: exactly half the stock, one invoice, original ordered quantity retained.
 answer:=public.erp_purchasing_write(gen_random_uuid(),'create_orders',jsonb_build_object('orders',jsonb_build_array(jsonb_build_object('supplierId',supplier,'locationId',dest,'date',day-7,'send',true,'lines',jsonb_build_array(jsonb_build_object('sku','CI-ITEM','qty',10,'price',160))))));
 po:=(answer->'ids'->>0)::uuid;select id into line from public.purchase_order_lines where purchase_order_id=po;
 request:=gen_random_uuid();payload:=jsonb_build_object('id',po,'revision',0,'date',day-2,'locationId',other_dest,'final',true,'tax',2.75,'lines',jsonb_build_array(jsonb_build_object('id',line,'qty',5,'price',160)));
 answer:=public.erp_purchasing_write(request,'receive_order',payload);again:=public.erp_purchasing_write(request,'receive_order',payload);
 perform public.ci_assert(answer=again,'idempotent retry result changed');
 perform public.ci_assert((select quantity_purchase=10 and quantity_received_purchase=5 from public.purchase_order_lines where id=line),'final half quantities');
 perform public.ci_assert((select status='Received' from public.purchase_orders where id=po),'final short not finalized');
 perform public.ci_assert((select count(*)=1 from public.erp_purchase_receipts where purchase_order_id=po),'duplicate receipt');
 perform public.ci_assert((select sum(t.quantity)=400 from public.inventory_transactions t join public.erp_purchase_receipt_lines l on l.transaction_id=t.id where l.purchase_order_line_id=line and t.location_id=other_dest),'receiving location or unit conversion incorrect');
 perform public.ci_assert((select abs(unit_cost-4::numeric/3)<.000001 from public.items where sku='CI-ITEM'),'weighted cost incorrect');
 select id into invoice from public.supplier_invoices where purchase_order_id=po;
 perform public.ci_assert((select amount=802.75 and due_at=day+13 from public.supplier_invoices where id=invoice),'receipt invoice tax or Net terms incorrect');
 failed:=false;begin perform public.erp_purchasing_write(request,'receive_order',payload||'{"tax":3}'::jsonb);exception when others then failed:=true;end;
 perform public.ci_assert(failed,'request ID reused with different input');
 -- Existing PO promise survives a supplier terms/lead edit; no static record edits.
 perform public.erp_purchasing_write(gen_random_uuid(),'save_supplier',jsonb_build_object('id',supplier,'revision',0,'name','CI legacy supplier','contact','Changed contact','email','ci@example.com','phone','123','address','CI','lead',9,'terms',30,'active',true,'notes','Changed future promise'));
 perform public.ci_assert((select erp_quoted_lead_days=3 and erp_payment_terms_days=15 from public.purchase_orders where id=po),'existing PO promise changed');
 failed:=false;begin perform public.erp_purchasing_write(gen_random_uuid(),'save_supplier',jsonb_build_object('id',supplier,'revision',0,'name','Stale edit','lead',1,'terms',1,'active',true));exception when others then failed:=true;end;
 perform public.ci_assert(failed,'stale supplier edit allowed');
 -- New draft picks up the new promise only when issued.
 answer:=public.erp_purchasing_write(gen_random_uuid(),'create_orders',jsonb_build_object('orders',jsonb_build_array(jsonb_build_object('supplierId',supplier,'locationId',dest,'date',day-8,'send',false,'lines',jsonb_build_array(jsonb_build_object('sku','CI-ITEM','qty',10,'price',160))))));
 po:=(answer->'ids'->>0)::uuid;select id into line from public.purchase_order_lines where purchase_order_id=po;
 perform public.erp_purchasing_write(gen_random_uuid(),'send_order',jsonb_build_object('id',po,'revision',0));
 perform public.ci_assert((select erp_quoted_lead_days=9 and erp_payment_terms_days=30 and status='Order Sent' from public.purchase_orders where id=po),'send snapshot');
 -- Correct sent date (receipts none), then receive two partial deliveries.
 perform public.erp_purchasing_write(gen_random_uuid(),'correct_order',jsonb_build_object('id',po,'revision',1,'date',day-8,'lead',3,'reason','Match original purchase order','lines',jsonb_build_array(jsonb_build_object('id',line,'qty',10)),'receipts','[]'::jsonb));
 answer:=public.erp_purchasing_write(gen_random_uuid(),'receive_order',jsonb_build_object('id',po,'revision',2,'date',day-3,'locationId',dest,'final',false,'tax',0,'lines',jsonb_build_array(jsonb_build_object('id',line,'qty',3,'price',160))));
 first_receipt:=(answer->>'receiptId')::uuid;
 perform public.ci_assert((select status='Partially Received' from public.purchase_orders where id=po),'partial prematurely finished');
 failed:=false;begin perform public.erp_purchasing_write(gen_random_uuid(),'receive_order',jsonb_build_object('id',po,'revision',3,'date',day-1,'locationId',dest,'final',false,'tax',0,'lines',jsonb_build_array(jsonb_build_object('id',line,'qty',8,'price',160))));exception when others then failed:=true;end;
 perform public.ci_assert(failed,'overreceipt accepted');
 perform public.ci_assert((select quantity_received_purchase=3 from public.purchase_order_lines where id=line),'failed receipt mutated quantities');
 answer:=public.erp_purchasing_write(gen_random_uuid(),'receive_order',jsonb_build_object('id',po,'revision',3,'date',day-1,'locationId',dest,'final',false,'tax',0,'lines',jsonb_build_array(jsonb_build_object('id',line,'qty',2,'price',160))));
 second_receipt:=(answer->>'receiptId')::uuid;
 perform public.ci_assert((select count(*)=2 from public.supplier_invoices where purchase_order_id=po),'per-delivery invoices missing');
 select id into invoice from public.supplier_invoices where erp_receipt_id=first_receipt;
 request:=gen_random_uuid();payload:=jsonb_build_object('id',invoice,'revision',0,'date',day-2,'amount',100,'reference','CI payment 1');
 perform public.erp_purchasing_write(request,'pay_invoice',payload);perform public.erp_purchasing_write(request,'pay_invoice',payload);
 perform public.ci_assert((select sum(amount)=100 and count(*)=1 from public.erp_supplier_payments where invoice_id=invoice),'duplicate payment');
 perform public.ci_assert((select paid_at is null from public.supplier_invoices where id=invoice),'partial payment marked paid');
 failed:=false;begin perform public.erp_purchasing_write(gen_random_uuid(),'pay_invoice',jsonb_build_object('id',invoice,'revision',1,'date',day-2,'amount',500,'reference','overpay'));exception when others then failed:=true;end;
 perform public.ci_assert(failed,'overpayment accepted');
 -- Payment chronology protects receipt corrections; a rejected edit rolls everything back.
 select sum(quantity) into before_stock from public.inventory_transactions where item_sku='CI-ITEM';
 select sum(amount) into before_amount from public.supplier_invoices where purchase_order_id=po;
 payload:=jsonb_build_object('id',po,'revision',4,'date',day-9,'lead',4,'reason','Audit correction','lines',jsonb_build_array(jsonb_build_object('id',line,'qty',12)),'receipts',jsonb_build_array(jsonb_build_object('id',first_receipt,'date',day-1),jsonb_build_object('id',second_receipt,'date',day-1)));
 failed:=false;begin perform public.erp_purchasing_write(gen_random_uuid(),'correct_order',payload);exception when others then failed:=true;end;
 perform public.ci_assert(failed,'receipt moved after a payment');
 perform public.ci_assert((select quantity_purchase=10 from public.purchase_order_lines where id=line),'failed correction partially changed order');
 payload:=jsonb_set(payload,'{receipts,0,date}',to_jsonb(day-4));
 perform public.erp_purchasing_write(gen_random_uuid(),'correct_order',payload);
 perform public.ci_assert((select quantity_purchase=12 and quantity_received_purchase=5 from public.purchase_order_lines where id=line),'corrected quantities incorrect');
 perform public.ci_assert((select sum(quantity)=before_stock from public.inventory_transactions where item_sku='CI-ITEM'),'correction changed stock');
 perform public.ci_assert((select sum(amount)=before_amount from public.supplier_invoices where purchase_order_id=po),'correction changed invoice amounts');
 perform public.ci_assert((select due_at=day+26 and erp_invoice_date=day-4 from public.supplier_invoices where id=invoice),'corrected invoice dates wrong');
 perform public.ci_assert((select bool_and((t.occurred_at at time zone 'America/Denver')::date=day-4) from public.inventory_transactions t join public.erp_purchase_receipt_lines l on l.transaction_id=t.id where l.receipt_id=first_receipt),'corrected ledger dates wrong');
 perform public.erp_purchasing_write(gen_random_uuid(),'finish_short',jsonb_build_object('id',po,'revision',5,'reason','Supplier confirmed no further shipment'));
 perform public.ci_assert((select status='Received' from public.purchase_orders where id=po),'finish short failed');
 failed:=false;begin perform public.erp_purchasing_write(gen_random_uuid(),'close_order',jsonb_build_object('id',po,'revision',6));exception when others then failed:=true;end;
 perform public.ci_assert(failed,'unpaid PO closed');
 perform public.erp_purchasing_write(gen_random_uuid(),'pay_invoice',jsonb_build_object('id',invoice,'revision',2,'date',day-1,'amount',380,'reference','CI payment 2'));
 select id into invoice from public.supplier_invoices where erp_receipt_id=second_receipt;
 perform public.erp_purchasing_write(gen_random_uuid(),'pay_invoice',jsonb_build_object('id',invoice,'revision',1,'date',day,'amount',320,'reference','CI payment 3'));
 perform public.erp_purchasing_write(gen_random_uuid(),'close_order',jsonb_build_object('id',po,'revision',6));
 perform public.ci_assert((select status='Closed' from public.purchase_orders where id=po),'paid PO could not close');
 perform public.ci_assert(not exists(select 1 from public.supplier_invoices where purchase_order_id=po and paid_at is null),'fully paid invoices not marked paid');
 -- Validation of one invalid grouped draft rolls back the entire group.
 select count(*) into before_count from public.purchase_orders;
 payload:=jsonb_build_object('orders',jsonb_build_array(jsonb_build_object('supplierId',supplier,'locationId',dest,'date',day,'send',false,'lines',jsonb_build_array(jsonb_build_object('sku','CI-ITEM','qty',1,'price',160))),jsonb_build_object('supplierId',supplier,'locationId',dest,'date',day,'send',false,'lines',jsonb_build_array(jsonb_build_object('sku','MISSING','qty',1,'price',1)))));
 failed:=false;begin perform public.erp_purchasing_write(gen_random_uuid(),'create_orders',payload);exception when others then failed:=true;end;
 perform public.ci_assert(failed,'invalid grouped draft accepted');perform public.ci_assert((select count(*)=before_count from public.purchase_orders),'grouped draft partially posted');
 perform public.erp_purchasing_write(gen_random_uuid(),'save_review',jsonb_build_object('supplierId',supplier,'decision','Watch','notes','Review actual late and short deliveries'));
 perform public.erp_purchasing_write(gen_random_uuid(),'inventory_review',jsonb_build_object('notes','Reviewed real inventory'));
 perform public.erp_purchasing_write(gen_random_uuid(),'save_options',jsonb_build_object('revision',0,'orderCost',35,'holdingRate',.3,'safetyDays',3,'reviewDays',7));
 perform public.ci_assert((select count(*)=1 from public.erp_supplier_reviews where supplier_id=supplier),'review missing');
 perform public.ci_assert((select order_cost=35 from public.erp_purchasing_options),'ordering options missing');
 perform public.ci_assert((select count(*) from public.erp_purchasing_requests)=(select count(*) from public.erp_purchasing_audit),'audit missing');
 answer:=public.erp_purchasing_snapshot();perform public.ci_assert(jsonb_array_length(answer->'receipts')=3,'shared snapshot receipt count');
end$$;
-- Actual SQL role invocation: the RPC works without direct table SELECT privileges.
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
set role authenticated;
select public.ci_assert((public.erp_purchasing_snapshot()->>'userId')='00000000-0000-0000-0000-000000000001','authenticated role RPC call');
reset role;
select 'PASS: additive migration preservation, original functions, role checks, atomic partial/final receiving, inventory conversion/cost, tax/terms invoices, idempotency, payments, source corrections/rollback, reviews, options and shared snapshots.' result;
