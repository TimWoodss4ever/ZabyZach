-- DISPOSABLE CI DATABASE ONLY. Never run fixtures in live Supabase.
\set ON_ERROR_STOP on
create temporary table quality_original_rows(table_name text,row_value jsonb);
do $$declare t record;begin
 for t in select tablename from pg_tables where schemaname='public' loop
  execute format('insert into quality_original_rows select %L,to_jsonb(t) from public.%I t',t.tablename,t.tablename);
 end loop;
end$$;
create temporary table quality_original_functions as
 select p.oid,pg_get_functiondef(p.oid) definition,p.proowner,p.proacl,p.proconfig,p.prosecdef
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f';
\ir ../../supabase/migrations/202611160003_reporting_quality.sql
do $$declare old record;ok boolean;begin
 for old in select * from quality_original_rows loop
  execute format('select exists(select 1 from public.%I t where to_jsonb(t)=$1)',old.table_name) into ok using old.row_value;
  perform public.ci_assert(ok,'reporting v2 changed preexisting records: '||old.table_name);
 end loop;
 for old in select table_name,count(*) as rows from quality_original_rows group by table_name loop
  execute format('select count(*)=$1 from public.%I',old.table_name) into ok using old.rows;
  perform public.ci_assert(ok,'reporting migration added/removed business records');
 end loop;
 for old in select * from quality_original_functions loop
  perform public.ci_assert(pg_get_functiondef(old.oid)=old.definition,'reporting update changed an existing function, including POS/staff/inventory');
  perform public.ci_assert((select proowner=old.proowner and proacl is not distinct from old.proacl and proconfig is not distinct from old.proconfig and prosecdef=old.prosecdef from pg_proc where oid=old.oid),'existing function attributes changed');
 end loop;
end$$;
select public.ci_assert(not has_function_privilege('anon','public.erp_reporting_snapshot_v2(date,date,uuid)','EXECUTE'),'anonymous reporting v2 execution');
select public.ci_assert(has_function_privilege('authenticated','public.erp_reporting_snapshot_v2(date,date,uuid)','EXECUTE'),'authenticated reporting v2 grant missing');

do $$declare uid uuid;failed boolean;d date:=(now() at time zone 'America/Denver')::date;begin
 foreach uid in array array[null::uuid,'00000000-0000-0000-0000-000000000002'::uuid,'00000000-0000-0000-0000-000000000003'::uuid,'00000000-0000-0000-0000-000000000004'::uuid] loop
  perform set_config('request.jwt.claim.sub',coalesce(uid::text,''),true);failed:=false;
  begin perform public.erp_reporting_snapshot_v2(d-7,d);exception when insufficient_privilege then failed:=true;end;
  perform public.ci_assert(failed,'non-manager reporting v2 read');
 end loop;
end$$;

-- Disjoint fixture IDs and SKUs isolate the four new report behaviors.
insert into public.locations(id,name) values
 ('00000000-0000-0000-0000-000000000961','Quality store A'),
 ('00000000-0000-0000-0000-000000000962','Quality store B');
insert into public.suppliers(id,name,quoted_lead_days) values('00000000-0000-0000-0000-000000000963','Quality supplier',3);
insert into public.items(sku,name,category,barcode,base_unit,purchase_unit,conversion_factor,unit_cost,selling_price,supplier_id)
 values('QUALITY-A','Quality item A','Beverage','QUALITY-A','each','case',10,2,10,'00000000-0000-0000-0000-000000000963'),
 ('QUALITY-B','Quality item B','Beverage','QUALITY-B','each','case',10,1,5,'00000000-0000-0000-0000-000000000963'),
 ('QUALITY-NEG','Quality historical item','Ingredient','QUALITY-NEG','oz','bag',1,2,0,null);
insert into public.inventory_transactions(id,item_sku,location_id,quantity,unit_cost,transaction_type,reference_document,occurred_at)
 values
 ('00000000-0000-0000-0000-000000000980','QUALITY-A','00000000-0000-0000-0000-000000000961',100,2,'Receipt','Quality opening',((now() at time zone 'America/Denver')::date-20)::timestamp at time zone 'America/Denver'),
 ('00000000-0000-0000-0000-000000000981','QUALITY-A','00000000-0000-0000-0000-000000000961',-99,2,'Sale','Quality usage history',((now() at time zone 'America/Denver')::date-2)::timestamp at time zone 'America/Denver'),
 ('00000000-0000-0000-0000-000000000982','QUALITY-B','00000000-0000-0000-0000-000000000961',50,1,'Receipt','Quality opening',((now() at time zone 'America/Denver')::date-20)::timestamp at time zone 'America/Denver'),
 ('00000000-0000-0000-0000-000000000983','QUALITY-NEG','00000000-0000-0000-0000-000000000961',1,2,'Receipt','Quality original receipt',((now() at time zone 'America/Denver')::date-20)::timestamp at time zone 'America/Denver'),
 ('00000000-0000-0000-0000-000000000984','QUALITY-NEG','00000000-0000-0000-0000-000000000961',-3,2,'Production','Quality historical production',((now() at time zone 'America/Denver')::date-19)::timestamp at time zone 'America/Denver'),
 ('00000000-0000-0000-0000-000000000985','QUALITY-NEG','00000000-0000-0000-0000-000000000961',5,2,'Receipt','Quality later receipt',((now() at time zone 'America/Denver')::date-18)::timestamp at time zone 'America/Denver');
insert into public.sales(id,receipt_no,location_id,subtotal,discount,tax,total,cogs,created_at)
 values
 ('00000000-0000-0000-0000-000000000986','QUALITY-MIXED','00000000-0000-0000-0000-000000000961',15,0,0,15,2,((now() at time zone 'America/Denver')::date-2)::timestamp at time zone 'America/Denver'),
 ('00000000-0000-0000-0000-000000000987','QUALITY-MISMATCH','00000000-0000-0000-0000-000000000961',10,0,0,10,9,((now() at time zone 'America/Denver')::date-2)::timestamp at time zone 'America/Denver'),
 ('00000000-0000-0000-0000-000000000988','QUALITY-OLD-REFUNDED','00000000-0000-0000-0000-000000000961',5,0,0,5,0,((now() at time zone 'America/Denver')::date-10)::timestamp at time zone 'America/Denver');
insert into public.sale_lines(id,sale_id,item_sku,quantity,unit_price,unit_cost) values
 ('00000000-0000-0000-0000-000000000990','00000000-0000-0000-0000-000000000986','QUALITY-A',1,10,2),
 ('00000000-0000-0000-0000-000000000991','00000000-0000-0000-0000-000000000986','QUALITY-B',1,5,0),
 ('00000000-0000-0000-0000-000000000992','00000000-0000-0000-0000-000000000987','QUALITY-B',2,5,1),
 ('00000000-0000-0000-0000-000000000993','00000000-0000-0000-0000-000000000988','QUALITY-B',1,5,0);
insert into public.sales_returns(id,request_id,request_payload,transaction_type,original_sale_id,refund_subtotal,refund_tax,refund_total,replacement_total,settlement_net,created_by,created_at)
 values('00000000-0000-0000-0000-000000000994','00000000-0000-0000-0000-000000000995','{}','Return','00000000-0000-0000-0000-000000000988',5,0,5,0,-5,'00000000-0000-0000-0000-000000000001',((now() at time zone 'America/Denver')::date-1)::timestamp at time zone 'America/Denver');
insert into public.sales_return_lines(return_id,original_sale_id,original_sale_line_id,item_sku,quantity,reason_code,disposition,refund_subtotal,refund_tax,refund_total,original_unit_cost,cost_amount)
 values('00000000-0000-0000-0000-000000000994','00000000-0000-0000-0000-000000000988','00000000-0000-0000-0000-000000000993','QUALITY-B',1,'Wrong order','Restock',5,0,5,0,0);

insert into public.purchase_orders(id,po_no,supplier_id,ship_to_location_id,ordered_at,expected_at,status,erp_quoted_lead_days)
 values
 ('00000000-0000-0000-0000-000000000971','QUALITY-CLOSED','00000000-0000-0000-0000-000000000963','00000000-0000-0000-0000-000000000961',((now() at time zone 'America/Denver')::date-6)::timestamp at time zone 'America/Denver',((now() at time zone 'America/Denver')::date-3)::timestamp at time zone 'America/Denver','Closed',3),
 ('00000000-0000-0000-0000-000000000972','QUALITY-RECEIVED','00000000-0000-0000-0000-000000000963','00000000-0000-0000-0000-000000000961',((now() at time zone 'America/Denver')::date-10)::timestamp at time zone 'America/Denver',((now() at time zone 'America/Denver')::date-4)::timestamp at time zone 'America/Denver','Received',6),
 ('00000000-0000-0000-0000-000000000973','QUALITY-OPEN','00000000-0000-0000-0000-000000000963','00000000-0000-0000-0000-000000000961',((now() at time zone 'America/Denver')::date-5)::timestamp at time zone 'America/Denver',((now() at time zone 'America/Denver')::date-1)::timestamp at time zone 'America/Denver','Partially Received',3);
insert into public.purchase_order_lines(purchase_order_id,item_sku,quantity_purchase,quantity_received_purchase,unit_price_purchase)
 values('00000000-0000-0000-0000-000000000973','QUALITY-A',20,0,20);
insert into public.erp_purchase_receipts(purchase_order_id,received_on,location_id,final_delivery,created_by)
 values
 ('00000000-0000-0000-0000-000000000971',(now() at time zone 'America/Denver')::date-4,'00000000-0000-0000-0000-000000000961',false,'00000000-0000-0000-0000-000000000001'),
 ('00000000-0000-0000-0000-000000000971',(now() at time zone 'America/Denver')::date-1,'00000000-0000-0000-0000-000000000961',true,'00000000-0000-0000-0000-000000000001'),
 ('00000000-0000-0000-0000-000000000972',(now() at time zone 'America/Denver')::date-6,'00000000-0000-0000-0000-000000000961',false,'00000000-0000-0000-0000-000000000001'),
 ('00000000-0000-0000-0000-000000000972',(now() at time zone 'America/Denver')::date-1,'00000000-0000-0000-0000-000000000961',true,'00000000-0000-0000-0000-000000000001');

do $$declare d date:=(now() at time zone 'America/Denver')::date;answer jsonb;old_report jsonb;v jsonb;loc uuid:='00000000-0000-0000-0000-000000000961';begin
 perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
 answer:=public.erp_reporting_snapshot_v2(d-7,d,loc);old_report:=public.erp_reporting_snapshot(d-7,d,loc);
 perform public.ci_assert((answer->>'version')::integer=2,'version 2 missing');
 perform public.ci_assert(answer->'pnl'=old_report->'pnl' and answer->'inventory'=old_report->'inventory' and answer->'daily'=old_report->'daily' and answer->'weekly'=old_report->'weekly' and answer->'topItems'=old_report->'topItems' and answer->'expenses'=old_report->'expenses','quality update altered existing financial or inventory calculations');
 select e into v from jsonb_array_elements(answer->'suppliers')e where e->>'id'='00000000-0000-0000-0000-000000000963';
 perform public.ci_assert((v->>'deliveries')::numeric=2 and (v->>'actual')::numeric=7 and (v->>'quoted')::numeric=4.5 and (v->>'late')::integer=2,'Closed orders or final-receipt averages are incorrect');
 select e into v from jsonb_array_elements(answer#>'{quality,costSales}')e where e->>'receipt_no'='QUALITY-MIXED';
 perform public.ci_assert((v->>'header_cogs')::numeric=2 and (v->>'zero_cost_lines')::integer=1,'mixed basket zero-cost line not flagged');
 select e into v from jsonb_array_elements(answer#>'{quality,costSales}')e where e->>'receipt_no'='QUALITY-MISMATCH';
 perform public.ci_assert((v->>'header_cogs')::numeric=9 and (v->>'line_cogs')::numeric=2,'header mismatch was hidden or substituted');
 select e into v from jsonb_array_elements(answer#>'{quality,costSales}')e where e->>'receipt_no'='QUALITY-OLD-REFUNDED';
 perform public.ci_assert(jsonb_array_length(v->'returns')=1 and v#>>'{returns,0,id}'='00000000-0000-0000-0000-000000000994','older sale refunded this period lost its warning or return ID');
 select e into v from jsonb_array_elements(answer#>'{quality,stockHistory}')e where e->>'sku'='QUALITY-NEG';
 perform public.ci_assert((v->>'lowest_balance')::numeric=-2 and (v->>'closing_quantity')::numeric=3 and (v->>'timestamp_batch_negative')::boolean and v->>'transaction_id'='00000000-0000-0000-0000-000000000984' and v->>'reference_document'='Quality historical production','negative history detail is wrong or warning erased after recovery');
 perform public.ci_assert(exists(select 1 from jsonb_array_elements(answer->'inventory')e where (e->>'negative_history')::boolean),'existing turnover-blocking warning lost');
 select e into v from jsonb_array_elements(answer->'lowStock')e where e->>'item_sku'='QUALITY-A';
 perform public.ci_assert((v->>'on_order')::numeric=200 and v#>>'{openOrders,0,po_no}'='QUALITY-OPEN' and (v#>>'{openOrders,0,expected_on}')::date=d-1,'outstanding delivery context or quantity incorrect');
 answer:=public.erp_reporting_snapshot_v2(d-7,d-3,loc);
 select e into v from jsonb_array_elements(answer->'suppliers')e where e->>'id'='00000000-0000-0000-0000-000000000963';
 perform public.ci_assert((v->>'deliveries')::integer=0,'earlier partial delivery was incorrectly counted as final receipt within historical range');
 answer:=public.erp_reporting_snapshot_v2(d-7,d,'00000000-0000-0000-0000-000000000962');
 select e into v from jsonb_array_elements(answer->'suppliers')e where e->>'id'='00000000-0000-0000-0000-000000000963';
 perform public.ci_assert((v->>'deliveries')::integer=0 and jsonb_array_length(answer#>'{quality,costSales}')=0,'supplier/cost location filter ignored');
end$$;

-- A repeat migration must preserve both original routines and the fixture rows.
create temporary table quality_repeat_rows(table_name text,row_value jsonb);
do $$declare t record;begin
 for t in select tablename from pg_tables where schemaname='public' loop
  execute format('insert into quality_repeat_rows select %L,to_jsonb(t) from public.%I t',t.tablename,t.tablename);
 end loop;
end$$;
\ir ../../supabase/migrations/202611160003_reporting_quality.sql
do $$declare old record;ok boolean;begin
 for old in select * from quality_repeat_rows loop
  execute format('select exists(select 1 from public.%I t where to_jsonb(t)=$1)',old.table_name) into ok using old.row_value;
  perform public.ci_assert(ok,'repeat quality migration changed business records');
 end loop;
 for old in select * from quality_original_functions loop
  perform public.ci_assert(pg_get_functiondef(old.oid)=old.definition,'repeat quality migration changed an existing function');
 end loop;
end$$;
select 'PASS: reporting-only preservation, role checks, supplier Closed/final-date handling, mixed/mismatched/refunded cost warnings, stock evidence, delivery context, location filters and repeat migration';
