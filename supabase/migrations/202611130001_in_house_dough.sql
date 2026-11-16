-- Historical catalog conversion. The current base already includes in-house dough.
-- Do not reinterpret live flour, delete old PO lines, reset costs, or invent stock.
do $conversion$
begin
 if exists(select 1 from public.items where sku='1001' and name='Bread flour' and base_unit='oz' and conversion_factor=800)
  and exists(select 1 from public.bom_lines where parent_sku='1030' and component_sku='1001' and quantity=9.6)
  and not exists(select 1 from public.bom_lines where parent_sku like '200%' and component_sku='1001') then
  raise notice 'In-house dough catalog already installed; preserving all inventory and purchase history';return;
 end if;
 if not exists(select 1 from public.items where sku='1001' and name='Frozen dough ball (16 oz)' and base_unit='each' and conversion_factor=40) then
  raise exception 'Unrecognized dough catalog; review the conversion before changing item meanings';
 end if;
 if exists(select 1 from public.inventory_transactions where item_sku='1001')
  or exists(select 1 from public.purchase_order_lines where item_sku='1001')
  or exists(select 1 from public.sale_lines where item_sku='1001') then
  raise exception 'Legacy purchased dough has transaction history. A reviewed data conversion is required; no records were changed';
 end if;
 insert into public.suppliers(name,quoted_lead_days,payment_terms_days) values('Provo Water Utility',1,30) on conflict(name) do nothing;
 insert into public.items(sku,name,category,barcode,base_unit,purchase_unit,conversion_factor,unit_cost,selling_price,shelf_life_days,supplier_id,lead_days)
 select v.sku,v.name,'Ingredient','ZBZ-'||v.sku,v.unit,v.pack,v.factor,v.cost,0,v.shelf,s.id,v.lead from(values
  ('1021','Instant yeast','oz','2 lb bag',32::numeric,.20::numeric,365,'Summit Dry Goods',7),
  ('1022','Olive oil','oz','1 gallon jug',128,.08,365,'Summit Dry Goods',7),
  ('1023','Fine salt','oz','50 lb sack',800,.01,730,'Summit Dry Goods',7),
  ('1024','Filtered water','oz','1 gallon equivalent',128,.001,30,'Provo Water Utility',1),
  ('1030','House-made dough ball (16 oz)','each','each',1,0,2,null,0)
 ) as v(sku,name,unit,pack,factor,cost,shelf,supplier,lead) left join public.suppliers s on s.name=v.supplier on conflict(sku) do nothing;
 update public.items set name='Bread flour',base_unit='oz',purchase_unit='50 lb sack',conversion_factor=800,unit_cost=.04,shelf_life_days=180,
  supplier_id=(select id from public.suppliers where name='Summit Dry Goods'),lead_days=7 where sku='1001';
 -- Only menu parents change. The dough-to-flour link must never become a self-link.
 update public.bom_lines set component_sku='1030' where parent_sku in('2001','2002','2003','2004','2005','2006','2007') and component_sku='1001';
 insert into public.bom_lines(parent_sku,component_sku,quantity) values
  ('1030','1001',9.6),('1030','1024',5.8),('1030','1021',.2),('1030','1022',.25),('1030','1023',.15)
 on conflict(parent_sku,component_sku) do update set quantity=excluded.quantity;
end
$conversion$;
