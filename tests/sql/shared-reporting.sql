-- DISPOSABLE CI DATABASE ONLY. Never run fixtures in Supabase.
\set ON_ERROR_STOP on
create temporary table reporting_original_rows(table_name text,row_value jsonb);
do $$declare t record;begin
 for t in select tablename from pg_tables where schemaname='public' loop
  execute format('insert into reporting_original_rows select %L,to_jsonb(t) from public.%I t',t.tablename,t.tablename);
 end loop;
end$$;
create temporary table reporting_original_functions as
 select p.oid,pg_get_functiondef(p.oid) definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.prokind='f';
\ir ../../supabase/migrations/202611160001_shared_reporting.sql
do $$declare old record;exists_row boolean;begin
 for old in select * from reporting_original_rows loop
  execute format('select exists(select 1 from public.%I t where to_jsonb(t)=$1)',old.table_name) into exists_row using old.row_value;
  perform public.ci_assert(exists_row,'reporting migration changed existing '||old.table_name);
 end loop;
 for old in select * from reporting_original_functions loop
  perform public.ci_assert(pg_get_functiondef(old.oid)=old.definition,'reporting migration changed an existing function');
 end loop;
end$$;
select public.ci_assert(not has_function_privilege('anon','public.erp_reporting_snapshot(date,date,uuid)','EXECUTE'),'anonymous reporting access');
select public.ci_assert(not has_function_privilege('anon','public.erp_reporting_expense(uuid,date,uuid,text,numeric,text)','EXECUTE'),'anonymous expense write');
select public.ci_assert(not has_function_privilege('authenticated','public.erp_reporting_inventory(timestamptz,timestamptz)','EXECUTE'),'internal inventory helper exposed');
select public.ci_assert(not has_table_privilege('authenticated','public.erp_reporting_expenses','INSERT'),'direct expense insert exposed');
select public.ci_assert(not has_table_privilege('authenticated','public.erp_reporting_expenses','SELECT'),'direct expense read exposed');
do $$declare uid uuid;failed boolean;d date:=(now() at time zone 'America/Denver')::date;begin
 foreach uid in array array[null::uuid,'00000000-0000-0000-0000-000000000002'::uuid,'00000000-0000-0000-0000-000000000003'::uuid,'00000000-0000-0000-0000-000000000004'::uuid] loop
  perform set_config('request.jwt.claim.sub',coalesce(uid::text,''),true);
  failed:=false;begin perform public.erp_reporting_snapshot(d,d);exception when insufficient_privilege then failed:=true;end;
  perform public.ci_assert(failed,'non-manager report read');
  failed:=false;begin perform public.erp_reporting_expense(gen_random_uuid(),d,null,'Other',1,'denied');exception when insufficient_privilege then failed:=true;end;
  perform public.ci_assert(failed,'non-manager expense write');
  failed:=false;begin perform public.erp_reporting_void_expense(gen_random_uuid(),'denied');exception when insufficient_privilege then failed:=true;end;
  perform public.ci_assert(failed,'non-manager expense void');
 end loop;
end$$;

-- Dedicated location/items isolate these arithmetic tests from prior fixtures.
insert into public.locations(id,name) values('00000000-0000-0000-0000-000000000901','Reporting CI location'),('00000000-0000-0000-0000-000000000902','Reporting CI transfer location');
insert into public.items(sku,name,category,barcode,base_unit,purchase_unit,conversion_factor,unit_cost)
 values('REPORT-CI','Report CI item','Beverage','REPORT-CI','each','case',10,3);
insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type,occurred_at)
values
 ('REPORT-CI','00000000-0000-0000-0000-000000000901',10,2,'Receipt',((now() at time zone 'America/Denver')::date-10)::timestamp at time zone 'America/Denver'),
 ('REPORT-CI','00000000-0000-0000-0000-000000000901',10,4,'Receipt',((now() at time zone 'America/Denver')::date-5)::timestamp at time zone 'America/Denver'),
 ('REPORT-CI','00000000-0000-0000-0000-000000000901',-2,3,'Transfer Out',((now() at time zone 'America/Denver')::date-4)::timestamp at time zone 'America/Denver'),
 ('REPORT-CI','00000000-0000-0000-0000-000000000902',2,3,'Transfer In',((now() at time zone 'America/Denver')::date-4)::timestamp at time zone 'America/Denver'),
 ('REPORT-CI','00000000-0000-0000-0000-000000000901',-4,3,'Sale',((now() at time zone 'America/Denver')::date-3)::timestamp at time zone 'America/Denver');
insert into public.sales(id,receipt_no,location_id,subtotal,discount,tax,total,cogs,created_at)
values('00000000-0000-0000-0000-000000000910','REPORT-CI-SALE','00000000-0000-0000-0000-000000000901',100,10,6.525,96.525,12,
 ((now() at time zone 'America/Denver')::date-3)::timestamp at time zone 'America/Denver');
insert into public.sale_lines(sale_id,item_sku,quantity,unit_price,unit_cost)
values('00000000-0000-0000-0000-000000000910','REPORT-CI',4,25,3);
insert into public.suppliers(id,name,quoted_lead_days)
 values('00000000-0000-0000-0000-000000000930','Reporting CI supplier',3);
insert into public.purchase_orders(id,po_no,supplier_id,ship_to_location_id,ordered_at,expected_at,received_at,status,erp_quoted_lead_days)
 values('00000000-0000-0000-0000-000000000931','REPORT-CI-PO','00000000-0000-0000-0000-000000000930','00000000-0000-0000-0000-000000000901',
 ((now() at time zone 'America/Denver')::date-6)::timestamp at time zone 'America/Denver',
 ((now() at time zone 'America/Denver')::date-3)::timestamp at time zone 'America/Denver',
 ((now() at time zone 'America/Denver')::date-1)::timestamp at time zone 'America/Denver','Received',3);
insert into public.erp_purchase_receipts(purchase_order_id,received_on,location_id,final_delivery,created_by)
 values('00000000-0000-0000-0000-000000000931',(now() at time zone 'America/Denver')::date-1,'00000000-0000-0000-0000-000000000901',true,'00000000-0000-0000-0000-000000000001');

do $$declare d date:=(now() at time zone 'America/Denver')::date;answer jsonb;v jsonb;line_id uuid;return_id uuid;loc uuid:='00000000-0000-0000-0000-000000000901';eid uuid:='00000000-0000-0000-0000-000000000920';failed boolean;begin
 perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
 answer:=public.erp_reporting_snapshot(d-7,d,loc);
 select e into v from jsonb_array_elements(answer->'inventory') e where e->>'item_sku'='REPORT-CI';
 perform public.ci_assert((v->>'opening_quantity')::numeric=10,'opening quantity');
 perform public.ci_assert((v->>'opening_cost')::numeric=2,'opening WAC');
 perform public.ci_assert((v->>'quantity')::numeric=14,'closing stock after transfer and sale');
 perform public.ci_assert((v->>'average_cost')::numeric=3,'10@2 plus 10@4 must average 3');
 perform public.ci_assert((answer#>>'{pnl,gross}')::numeric=100,'posted gross sales');
 perform public.ci_assert((answer#>>'{pnl,cogs}')::numeric=12,'posted COGS');
 perform public.ci_assert((select sum((e->>'net')::numeric) from jsonb_array_elements(answer->'daily')e)=90,'daily sales net discount');
 perform public.ci_assert((select sum((e->>'net')::numeric) from jsonb_array_elements(answer->'weekly')e)=90,'weekly reconciles');
 perform public.ci_assert((answer#>>'{topItems,0,units}')::numeric=4,'top items filtered by location and period');
 select e into v from jsonb_array_elements(answer->'suppliers')e where e->>'id'='00000000-0000-0000-0000-000000000930';
 perform public.ci_assert((v->>'deliveries')::numeric=1 and (v->>'actual')::numeric=5 and (v->>'quoted')::numeric=3 and (v->>'late')::numeric=1,'supplier actual versus quoted lead time');
 select id into line_id from public.sale_lines where sale_id='00000000-0000-0000-0000-000000000910';
 v:=public.process_return(gen_random_uuid(),line_id,1,'Wrong order','Restock');
 return_id:=(v->>'return_id')::uuid;
 -- Move fixture timestamps off the transaction's exact now() boundary.
 update public.sales_returns set created_at=now()-interval '1 second' where id=return_id;
 update public.inventory_transactions set occurred_at=now()-interval '1 second' where item_sku='REPORT-CI' and transaction_type='Return Restock';
 answer:=public.erp_reporting_snapshot(d-7,d,loc);
 perform public.ci_assert((answer#>>'{pnl,refunds}')::numeric=22.5,'refund after original discount');
 perform public.ci_assert((answer#>>'{pnl,cogs}')::numeric=9,'restock reverses original COGS once');
 perform public.ci_assert((answer#>>'{topItems,0,units}')::numeric=3,'restock reduces net units');
 perform public.ci_assert((select sum((e->>'net')::numeric) from jsonb_array_elements(answer->'daily')e)=67.5,'refund on return date');
 v:=public.process_return(gen_random_uuid(),line_id,1,'Wrong order','Waste');
 update public.sales_returns set created_at=now()-interval '1 second' where id=(v->>'return_id')::uuid;
 answer:=public.erp_reporting_snapshot(d-7,d,loc);
 perform public.ci_assert((answer#>>'{pnl,cogs}')::numeric=9 and (answer#>>'{pnl,waste}')::numeric=0,'waste return must retain COGS without charging waste twice');
 perform public.erp_reporting_expense(eid,d,loc,'Labor',5.25,'CI expense');
 perform public.erp_reporting_expense(eid,d,loc,'Labor',5.25,'CI expense');
 perform public.ci_assert((select count(*)=1 from public.erp_reporting_expenses where id=eid),'retry duplicated expense');
 failed:=false;begin perform public.erp_reporting_expense(eid,d,loc,'Labor',6,'CI expense');exception when others then failed:=true;end;
 perform public.ci_assert(failed,'request ID accepted conflicting payload');
 failed:=false;begin perform public.erp_reporting_expense(gen_random_uuid(),d,loc,'Labor',-1,'CI expense');exception when others then failed:=true;end;
 perform public.ci_assert(failed,'negative expense accepted');
 failed:=false;begin perform public.erp_reporting_expense(gen_random_uuid(),d+1,loc,'Labor',1,'CI expense');exception when others then failed:=true;end;
 perform public.ci_assert(failed,'future expense accepted');
 failed:=false;begin perform public.erp_reporting_snapshot(d,d-1,loc);exception when others then failed:=true;end;
 perform public.ci_assert(failed,'reversed range accepted');
 answer:=public.erp_reporting_snapshot(d-7,d,loc);
 perform public.ci_assert((answer#>>'{pnl,expenses}')::numeric=5.25,'saved expense missing from P&L');
 perform public.erp_reporting_expense(gen_random_uuid(),d,null,'Rent',9,'Company overhead');
 answer:=public.erp_reporting_snapshot(d-7,d,loc);
 perform public.ci_assert((answer#>>'{pnl,expenses}')::numeric=5.25,'company overhead incorrectly allocated to one location');
 perform public.erp_reporting_void_expense(eid,'Correction');perform public.erp_reporting_void_expense(eid,'Correction');
 answer:=public.erp_reporting_snapshot(d-7,d,loc);
 perform public.ci_assert((answer#>>'{pnl,expenses}')::numeric=0,'voided expense still counted');
 perform public.ci_assert((select void_reason='Correction' from public.erp_reporting_expenses where id=eid),'void audit not retained');
end$$;
create temporary table reporting_saved_expenses as select * from public.erp_reporting_expenses;
\ir ../../supabase/migrations/202611160001_shared_reporting.sql
select public.ci_assert(not exists(select * from reporting_saved_expenses except select * from public.erp_reporting_expenses),'rerun changed saved expenses');
select 'PASS: reporting migration preservation, permissions, WAC, location transfer, sales grouping, expense retry/void and repeat migration';
