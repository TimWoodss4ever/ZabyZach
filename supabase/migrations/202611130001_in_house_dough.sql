-- Convert the demo catalog from purchased frozen dough to in-house dough production.
insert into public.suppliers(name,quoted_lead_days,payment_terms_days)
values ('Provo Water Utility',1,30)
on conflict(name) do nothing;

update public.items
set name='Bread flour',base_unit='oz',purchase_unit='50 lb sack',conversion_factor=800,
    unit_cost=.04,shelf_life_days=180,
    supplier_id=(select id from public.suppliers where name='Summit Dry Goods'),lead_days=7
where sku='1001';

insert into public.items(sku,name,category,barcode,base_unit,purchase_unit,conversion_factor,unit_cost,selling_price,shelf_life_days,supplier_id,lead_days)
select v.sku,v.name,'Ingredient','ZBZ-'||v.sku,v.unit,v.pack,v.factor,v.cost,0,v.shelf,s.id,v.lead
from (values
 ('1021','Instant yeast','oz','2 lb bag',32::numeric,.20::numeric,365,'Summit Dry Goods',7),
 ('1022','Olive oil','oz','1 gallon jug',128,.08,365,'Summit Dry Goods',7),
 ('1023','Fine salt','oz','50 lb sack',800,.01,730,'Summit Dry Goods',7),
 ('1024','Filtered water','oz','1 gallon equivalent',128,.001,30,'Provo Water Utility',1),
 ('1030','House-made dough ball (16 oz)','each','each',1,0,2,null,0)
) as v(sku,name,unit,pack,factor,cost,shelf,supplier,lead)
left join public.suppliers s on s.name=v.supplier
on conflict(sku) do update set name=excluded.name,category=excluded.category,base_unit=excluded.base_unit,
 purchase_unit=excluded.purchase_unit,conversion_factor=excluded.conversion_factor,unit_cost=excluded.unit_cost,
 shelf_life_days=excluded.shelf_life_days,supplier_id=excluded.supplier_id,lead_days=excluded.lead_days;

-- Preserve the old dough balances as finished dough; remove old dough purchase lines because their units changed.
update public.inventory_transactions set item_sku='1030' where item_sku='1001';
delete from public.purchase_order_lines where item_sku='1001';

update public.bom_lines set component_sku='1030' where component_sku='1001';
insert into public.bom_lines(parent_sku,component_sku,quantity) values
 ('1030','1001',9.6),('1030','1024',5.8),('1030','1021',.2),('1030','1022',.25),('1030','1023',.15)
on conflict(parent_sku,component_sku) do update set quantity=excluded.quantity;

-- Add opening stocks for the new dough inputs so the converted demo can run production immediately.
insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type,reference_document,metadata)
select stock.sku,l.id,stock.quantity,i.unit_cost,'Receipt','In-house dough conversion',jsonb_build_object('note','Opening ingredient balance for the demo catalog conversion')
from (values ('1001',12000::numeric),('1021',300),('1022',1200),('1023',12000),('1024',12000)) as stock(sku,quantity)
join public.items i on i.sku=stock.sku
cross join public.locations l;
