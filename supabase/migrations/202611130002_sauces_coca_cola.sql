-- Expanded sauce and Coca-Cola can assortment.
-- Existing generic soda SKU is retained as Coca-Cola Original Taste.
update public.items set name='Coca-Cola Original Taste (12 oz can)' where sku='1018';
insert into public.items(sku,name,category,barcode,base_unit,purchase_unit,conversion_factor,unit_cost,selling_price,shelf_life_days,supplier_id,lead_days)
select v.sku,v.name,v.category,v.barcode,v.unit,v.pack,v.factor,v.cost,v.price,v.shelf,s.id,v.lead
from (values
 ('1031','Zack’s house sauce','Ingredient','ZBZ-1031','oz','1 gallon jug',128,0.08,0,30,'Summit Dry Goods',7),
 ('1032','Alfredo sauce','Ingredient','ZBZ-1032','oz','1 gallon jug',128,0.12,0,21,'Summit Dry Goods',7),
 ('1033','Buffalo sauce','Ingredient','ZBZ-1033','oz','1 gallon jug',128,0.07,0,90,'Summit Dry Goods',7),
 ('1034','Basil pesto sauce','Ingredient','ZBZ-1034','oz','1 gallon jug',128,0.18,0,21,'Summit Dry Goods',7),
 ('1040','2 oz portion cup & lid','Packaging','ZBZ-1040','each','case of 250',250,0.04,0,null,'Beehive Packaging',10),
 ('1041','House sauce dipping cup','Sides','ZBZ-1041','each','each',1,0.2,0.75,2,null,0),
 ('1042','BBQ dipping cup','Sides','ZBZ-1042','each','each',1,0.18000000000000002,0.75,2,null,0),
 ('1043','Buffalo dipping cup','Sides','ZBZ-1043','each','each',1,0.18000000000000002,0.75,2,null,0),
 ('1051','Diet Coke (12 oz can)','Beverage','ZBZ-1051','each','case of 24',24,0.35,1.5,270,'Cascade Beverage & Sides',4),
 ('1052','Coca-Cola Zero Sugar (12 oz can)','Beverage','ZBZ-1052','each','case of 24',24,0.35,1.5,270,'Cascade Beverage & Sides',4),
 ('1053','Coca-Cola Cherry (12 oz can)','Beverage','ZBZ-1053','each','case of 24',24,0.35,1.5,270,'Cascade Beverage & Sides',4),
 ('1054','Sprite (12 oz can)','Beverage','ZBZ-1054','each','case of 24',24,0.35,1.5,270,'Cascade Beverage & Sides',4),
 ('1055','Fanta Orange (12 oz can)','Beverage','ZBZ-1055','each','case of 24',24,0.35,1.5,270,'Cascade Beverage & Sides',4)
) as v(sku,name,category,barcode,unit,pack,factor,cost,price,shelf,supplier,lead)
left join public.suppliers s on s.name=v.supplier
on conflict(sku) do nothing;
insert into public.bom_lines(parent_sku,component_sku,quantity) values
 ('1041','1031',2),
 ('1041','1040',1),
 ('1042','1015',2),
 ('1042','1040',1),
 ('1043','1033',2),
 ('1043','1040',1)
on conflict(parent_sku,component_sku) do update set quantity=excluded.quantity;
