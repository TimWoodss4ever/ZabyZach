-- CI fixture, deliberately created BEFORE the new migration to verify preservation.
insert into auth.users(id) values ('00000000-0000-0000-0000-000000000001'),('00000000-0000-0000-0000-000000000002'),('00000000-0000-0000-0000-000000000003'),('00000000-0000-0000-0000-000000000004');
insert into public.profiles(user_id,role) values ('00000000-0000-0000-0000-000000000001','Manager'),('00000000-0000-0000-0000-000000000002','Cashier'),('00000000-0000-0000-0000-000000000003','Customer');
insert into public.suppliers(id,name,quoted_lead_days,payment_terms_days) values('00000000-0000-0000-0000-000000000010','CI legacy supplier',3,15);
insert into public.items(sku,name,category,barcode,base_unit,purchase_unit,conversion_factor,unit_cost,supplier_id)
 values('CI-ITEM','CI purchased item','Ingredient','CI-BARCODE','oz','5 lb box',80,1,'00000000-0000-0000-0000-000000000010');
insert into public.purchase_orders(id,po_no,supplier_id,ship_to_location_id,ordered_at,expected_at,received_at,status)
 select '00000000-0000-0000-0000-000000000020','CI-LEGACY-PO','00000000-0000-0000-0000-000000000010',id,now()-interval '10 days',now()-interval '7 days',now()-interval '8 days','Received' from public.locations limit 1;
insert into public.purchase_order_lines(id,purchase_order_id,item_sku,quantity_purchase,quantity_received_purchase,unit_price_purchase)
 values('00000000-0000-0000-0000-000000000021','00000000-0000-0000-0000-000000000020','CI-ITEM',10,10,80);
insert into public.supplier_invoices(id,purchase_order_id,amount,due_at,paid_at)
 values('00000000-0000-0000-0000-000000000022','00000000-0000-0000-0000-000000000020',800,current_date+7,current_date-2);
insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type,reference_document)
 select 'CI-ITEM',id,800,1,'Receipt','CI-LEGACY-PO' from public.locations limit 1;
create table public.ci_original_rows(table_name text,row_value jsonb);
do $$declare t text;begin
 foreach t in array array['suppliers','items','locations','purchase_orders','purchase_order_lines','supplier_invoices','inventory_transactions','profiles','settings'] loop
  execute format('insert into public.ci_original_rows select %L,to_jsonb(t) from public.%I t',t,t);
 end loop;
end $$;
create table public.ci_original_functions as select p.oid,pg_get_functiondef(p.oid) definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f';
