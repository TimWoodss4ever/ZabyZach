-- Za by Zack mini-ERP: Postgres-backed ledger and transaction RPCs.
create extension if not exists pgcrypto;

create table if not exists public.locations (
  id uuid primary key default gen_random_uuid(), name text not null unique,
  can_sell boolean not null default true, created_at timestamptz not null default now()
);
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('Manager','Cashier','Customer')),
  customer_id uuid, created_at timestamptz not null default now()
);
create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(), name text not null,
  email text, phone text, customer_type text not null default 'Individual'
);
alter table public.profiles drop constraint if exists profiles_customer_id_fkey;
alter table public.profiles add constraint profiles_customer_id_fkey foreign key(customer_id) references public.customers(id);
create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(), name text not null unique,
  contact_name text, phone text, email text, address text,
  quoted_lead_days integer not null default 0, payment_terms_days integer not null default 30
);
create table if not exists public.items (
  sku text primary key, name text not null, category text not null,
  barcode text not null unique, base_unit text not null check(base_unit in ('oz','each')),
  purchase_unit text not null, conversion_factor numeric not null default 1 check(conversion_factor>0),
  unit_cost numeric not null default 0 check(unit_cost>=0), selling_price numeric not null default 0,
  shelf_life_days integer, supplier_id uuid references public.suppliers(id), lead_days integer not null default 0,
  active boolean not null default true
);
create table if not exists public.bom_lines (
  parent_sku text not null references public.items(sku) on delete cascade,
  component_sku text not null references public.items(sku), quantity numeric not null check(quantity>0),
  primary key(parent_sku,component_sku), check(parent_sku<>component_sku)
);
create table if not exists public.settings (
  setting_key text primary key, value jsonb not null, updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);
create table if not exists public.inventory_transactions (
  id uuid primary key default gen_random_uuid(), item_sku text not null references public.items(sku),
  location_id uuid not null references public.locations(id), quantity numeric not null check(quantity<>0),
  unit_cost numeric not null check(unit_cost>=0), transaction_type text not null,
  reason_code text, reference_document text, user_id uuid references auth.users(id),
  occurred_at timestamptz not null default now(), metadata jsonb not null default '{}'::jsonb
);
create index if not exists inventory_transactions_item_location_time on public.inventory_transactions(item_sku,location_id,occurred_at);
create index if not exists inventory_transactions_reference on public.inventory_transactions(reference_document);
create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(), receipt_no text not null unique,
  location_id uuid not null references public.locations(id), customer_id uuid references public.customers(id),
  subtotal numeric not null, discount numeric not null default 0, tax numeric not null default 0,
  total numeric not null, cogs numeric not null default 0, status text not null default 'Completed',
  created_by uuid references auth.users(id), created_at timestamptz not null default now()
);
create table if not exists public.sale_lines (
  id uuid primary key default gen_random_uuid(), sale_id uuid not null references public.sales(id) on delete cascade,
  item_sku text not null references public.items(sku), quantity numeric not null check(quantity>0),
  unit_price numeric not null, unit_cost numeric not null, discount numeric not null default 0
);
create table if not exists public.sales_orders (
  id uuid primary key default gen_random_uuid(), customer_id uuid references public.customers(id),
  location_id uuid not null references public.locations(id), pickup_at timestamptz not null,
  discount_pct numeric not null default 0 check(discount_pct between 0 and 100),
  discount_amount numeric not null default 0 check(discount_amount >= 0),
  status text not null default 'Order Placed' check(status in ('Order Placed','Fulfilled','Closed','Cancelled')),
  notes text, created_by uuid references auth.users(id), created_at timestamptz not null default now()
);
create table if not exists public.sales_order_lines (
  id uuid primary key default gen_random_uuid(), order_id uuid not null references public.sales_orders(id) on delete cascade,
  item_sku text not null references public.items(sku), quantity numeric not null check(quantity>0), unit_price numeric not null
);
create table if not exists public.purchase_orders (
  id uuid primary key default gen_random_uuid(), po_no text not null unique, supplier_id uuid not null references public.suppliers(id),
  ship_to_location_id uuid not null references public.locations(id), ordered_at timestamptz not null default now(),
  expected_at timestamptz not null, received_at timestamptz, status text not null default 'Order Sent',
  created_by uuid references auth.users(id), created_at timestamptz not null default now()
);
create table if not exists public.purchase_order_lines (
  id uuid primary key default gen_random_uuid(), purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,
  item_sku text not null references public.items(sku), quantity_purchase numeric not null check(quantity_purchase>0),
  quantity_received_purchase numeric not null default 0, unit_price_purchase numeric not null check(unit_price_purchase>=0)
);
create table if not exists public.supplier_invoices (
  id uuid primary key default gen_random_uuid(), purchase_order_id uuid not null references public.purchase_orders(id),
  amount numeric not null, due_at date not null, paid_at date, created_at timestamptz not null default now()
);
create table if not exists public.production_orders (
  id uuid primary key default gen_random_uuid(), order_no text not null unique,
  parent_sku text not null references public.items(sku), location_id uuid not null references public.locations(id),
  quantity_started numeric not null check(quantity_started>0), quantity_good numeric not null default 0,
  quantity_scrapped numeric not null default 0, status text not null default 'Planned',
  started_at timestamptz, finished_at timestamptz, reason_code text,
  created_by uuid references auth.users(id), created_at timestamptz not null default now()
);

insert into public.locations(name,can_sell) values
 ('Provo Campus Store',true),('Orem Store',true),('Central Commissary',false)
on conflict(name) do nothing;
insert into public.settings(setting_key,value) values
 ('sales_tax_rate','0.0725'::jsonb),('ordering_cost','25'::jsonb),('annual_holding_rate','0.25'::jsonb),
 ('safety_stock_days','2'::jsonb),
 ('adjustment_reason_codes','["Cycle count correction","Spoiled/Expired","Damaged","Dropped/Spilled","Theft/Unknown loss"]'::jsonb),
 ('return_reason_codes','["Burnt","Undercooked","Wrong order","Cold on pickup","Damaged packaging","Customer changed mind"]'::jsonb),
 ('waste_reason_codes','["Burnt","Dropped","Wrong toppings","Undercooked","Other"]'::jsonb)
on conflict(setting_key) do nothing;

insert into public.suppliers(name,quoted_lead_days,payment_terms_days) values
 ('Wasatch Dairy Co.',3,15),('Valley Meats',5,30),('Mountain Produce',2,7),
 ('Summit Dry Goods',7,30),('Beehive Packaging',10,45),('Cascade Beverage & Sides',4,30),('Provo Water Utility',1,30)
on conflict(name) do nothing;

-- Compact item seed is intentionally held in SQL so a Supabase project can be rebuilt.
insert into public.items(sku,name,category,barcode,base_unit,purchase_unit,conversion_factor,unit_cost,selling_price,shelf_life_days,supplier_id,lead_days)
select v.sku,v.name,v.category,'ZBZ-'||v.sku,v.unit,v.pack,v.factor,v.cost,v.price,v.shelf,s.id,v.lead
from (values
 ('1001','Bread flour','Ingredient','oz','50 lb sack',800::numeric,.04::numeric,0::numeric,180, 'Summit Dry Goods',7),
 ('1002','Pizza sauce','Ingredient','oz','#10 can',106,.06,0,30,'Summit Dry Goods',7),
 ('1003','Shredded mozzarella','Ingredient','oz','5 lb bag',80,.22,0,21,'Wasatch Dairy Co.',3),
 ('1004','Grated parmesan','Ingredient','oz','1 lb bag',16,.40,0,60,'Wasatch Dairy Co.',3),
 ('1005','Pepperoni','Ingredient','oz','5 lb box',80,.30,0,45,'Valley Meats',5),
 ('1006','Italian sausage crumbles','Ingredient','oz','5 lb bag',80,.28,0,14,'Valley Meats',5),
 ('1007','Diced ham','Ingredient','oz','5 lb bag',80,.26,0,14,'Valley Meats',5),
 ('1008','Bacon crumbles','Ingredient','oz','2 lb bag',32,.35,0,30,'Valley Meats',5),
 ('1009','Grilled chicken strips','Ingredient','oz','5 lb bag',80,.32,0,10,'Valley Meats',5),
 ('1010','Pineapple tidbits','Ingredient','oz','#10 can',106,.12,0,180,'Summit Dry Goods',7),
 ('1011','Sliced mushrooms','Ingredient','oz','3 lb bag',48,.15,0,7,'Mountain Produce',2),
 ('1012','Sliced black olives','Ingredient','oz','#10 can',106,.14,0,180,'Summit Dry Goods',7),
 ('1013','Diced green peppers','Ingredient','oz','3 lb bag',48,.10,0,7,'Mountain Produce',2),
 ('1014','Diced red onions','Ingredient','oz','3 lb bag',48,.08,0,10,'Mountain Produce',2),
 ('1015','BBQ sauce','Ingredient','oz','gallon',128,.07,0,90,'Summit Dry Goods',7),
 ('1016','Garlic butter','Ingredient','oz','2 lb tub',32,.12,0,30,'Wasatch Dairy Co.',3),
 ('1017','Ranch dipping cup','Sides','each','case of 100',100,.18,.75,60,'Cascade Beverage & Sides',4),
 ('1018','Canned soda (12 oz)','Beverage','each','case of 24',24,.35,1.50,270,'Cascade Beverage & Sides',4),
 ('1019','Large pizza box','Packaging','each','bundle of 50',50,.40,0,null,'Beehive Packaging',10),
 ('1020','Breadstick bag','Packaging','each','pack of 250',250,.10,0,null,'Beehive Packaging',10),
 ('1021','Instant yeast','Ingredient','oz','2 lb bag',32,.20,0,365,'Summit Dry Goods',7),
 ('1022','Olive oil','Ingredient','oz','1 gallon jug',128,.08,0,365,'Summit Dry Goods',7),
 ('1023','Fine salt','Ingredient','oz','50 lb sack',800,.01,0,730,'Summit Dry Goods',7),
 ('1024','Filtered water','Ingredient','oz','1 gallon equivalent',128,.001,0,30,'Provo Water Utility',1),
 ('1030','House-made dough ball (16 oz)','Ingredient','each','each',1,0,0,2,null,0),
 ('2001','Large Cheese Pizza','Pizza','each','each',1,0,11.99,null,'Summit Dry Goods',7),
 ('2002','Large Pepperoni Pizza','Pizza','each','each',1,0,13.99,null,'Valley Meats',5),
 ('2003','Large Hawaiian Pizza','Pizza','each','each',1,0,14.99,null,'Valley Meats',5),
 ('2004','Large Supreme Pizza','Pizza','each','each',1,0,16.99,null,'Mountain Produce',2),
 ('2005','Large Veggie Pizza','Pizza','each','each',1,0,14.99,null,'Mountain Produce',2),
 ('2006','Large BBQ Chicken Pizza','Pizza','each','each',1,0,15.99,null,'Valley Meats',5),
 ('2007','Breadsticks (8 pc)','Sides','each','each',1,0,5.99,null,'Wasatch Dairy Co.',3)
) as v(sku,name,category,unit,pack,factor,cost,price,shelf,supplier,lead)
left join public.suppliers s on s.name=v.supplier
on conflict(sku) do nothing;

insert into public.bom_lines(parent_sku,component_sku,quantity) values
 ('1030','1001',9.6),('1030','1024',5.8),('1030','1021',.2),('1030','1022',.25),('1030','1023',.15),
 ('2001','1030',1),('2001','1002',6),('2001','1003',10),('2001','1004',.5),('2001','1019',1),
 ('2002','1030',1),('2002','1002',6),('2002','1003',8),('2002','1005',3),('2002','1019',1),
 ('2003','1030',1),('2003','1002',6),('2003','1003',8),('2003','1007',3),('2003','1010',3),('2003','1019',1),
 ('2004','1030',1),('2004','1002',6),('2004','1003',8),('2004','1005',2),('2004','1006',2),('2004','1013',1.5),('2004','1014',1),('2004','1012',1),('2004','1011',1.5),('2004','1019',1),
 ('2005','1030',1),('2005','1002',6),('2005','1003',8),('2005','1013',2),('2005','1014',1.5),('2005','1012',1.5),('2005','1011',2),('2005','1019',1),
 ('2006','1030',1),('2006','1015',5),('2006','1003',8),('2006','1009',3),('2006','1014',1),('2006','1008',1),('2006','1019',1),
 ('2007','1030',1),('2007','1016',2),('2007','1004',.5),('2007','1020',1)
on conflict(parent_sku,component_sku) do nothing;

create or replace function public.current_role() returns text language sql stable security definer set search_path=public
as $$ select role from public.profiles where user_id=auth.uid() $$;
create or replace function public.require_staff() returns void language plpgsql security definer set search_path=public
as $$ begin if public.current_role() not in ('Manager','Cashier') then raise exception 'Manager or Cashier role required'; end if; end $$;

create or replace function public.post_transfer(p_item_sku text,p_from uuid,p_to uuid,p_quantity numeric)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_id uuid:=gen_random_uuid(); v_cost numeric; v_onhand numeric;
begin
 perform public.require_staff(); if p_from=p_to or p_quantity<=0 then raise exception 'Choose distinct locations and a positive quantity'; end if;
 select unit_cost into v_cost from public.items where sku=p_item_sku for update;
 select coalesce(sum(quantity),0) into v_onhand from public.inventory_transactions where item_sku=p_item_sku and location_id=p_from;
 if v_onhand<p_quantity then raise exception 'Insufficient stock: available %, requested %',v_onhand,p_quantity; end if;
 insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type,reference_document,user_id,metadata)
 values(p_item_sku,p_from,-p_quantity,v_cost,'Transfer Out',v_id::text,auth.uid(),jsonb_build_object('counter_location',p_to)),
       (p_item_sku,p_to,p_quantity,v_cost,'Transfer In',v_id::text,auth.uid(),jsonb_build_object('counter_location',p_from));
 return v_id;
end $$;

create or replace function public.post_adjustment(p_item_sku text,p_location uuid,p_counted numeric,p_reason text)
returns numeric language plpgsql security definer set search_path=public as $$
declare v_onhand numeric; v_delta numeric; v_cost numeric;
begin
 perform public.require_staff(); if coalesce(trim(p_reason),'')='' then raise exception 'Reason code required'; end if;
 select unit_cost into v_cost from public.items where sku=p_item_sku for update;
 select coalesce(sum(quantity),0) into v_onhand from public.inventory_transactions where item_sku=p_item_sku and location_id=p_location;
 v_delta:=p_counted-v_onhand; if v_delta<>0 then
  insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type,reason_code,reference_document,user_id)
  values(p_item_sku,p_location,v_delta,v_cost,'Adjustment',p_reason,'Cycle count',auth.uid());
 end if; return v_delta;
end $$;

create or replace function public.receive_purchase_order(p_po uuid,p_line uuid,p_quantity_purchase numeric,p_unit_price_purchase numeric,p_received_at timestamptz default now())
returns numeric language plpgsql security definer set search_path=public as $$
declare v_item text; v_location uuid; v_factor numeric; v_old_qty numeric; v_old_cost numeric; v_new_qty numeric; v_new_cost numeric; v_base numeric; v_po_status text;
begin
 perform public.require_staff(); if p_quantity_purchase<=0 or p_unit_price_purchase<0 then raise exception 'Invalid receipt quantity or cost'; end if;
 select pol.item_sku,po.ship_to_location_id,i.conversion_factor,i.unit_cost into v_item,v_location,v_factor,v_old_cost
 from public.purchase_order_lines pol join public.purchase_orders po on po.id=pol.purchase_order_id join public.items i on i.sku=pol.item_sku
 where po.id=p_po and pol.id=p_line for update of pol,po,i;
 if v_item is null then raise exception 'Purchase order line not found'; end if;
 select coalesce(sum(quantity),0) into v_old_qty from public.inventory_transactions where item_sku=v_item;
 v_base:=p_quantity_purchase*v_factor; v_new_qty:=v_old_qty+v_base;
 v_new_cost:=case when v_new_qty<=0 then p_unit_price_purchase/v_factor else (v_old_qty*v_old_cost+v_base*(p_unit_price_purchase/v_factor))/v_new_qty end;
 update public.items set unit_cost=v_new_cost where sku=v_item;
 update public.purchase_order_lines set quantity_received_purchase=quantity_received_purchase+p_quantity_purchase where id=p_line;
 insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type,reference_document,user_id)
 values(v_item,v_location,v_base,p_unit_price_purchase/v_factor,'Receipt',(select po_no from public.purchase_orders where id=p_po),auth.uid());
 update public.purchase_orders set received_at=p_received_at,status='Received' where id=p_po;
 insert into public.supplier_invoices(purchase_order_id,amount,due_at)
 values(p_po,p_quantity_purchase*p_unit_price_purchase,p_received_at::date+coalesce((select s.payment_terms_days from public.suppliers s join public.purchase_orders p on p.supplier_id=s.id where p.id=p_po),30));
 return v_new_cost;
end $$;

create or replace function public.record_sale(p_location uuid,p_lines jsonb,p_discount_percent numeric default 0,p_customer uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_sale uuid:=gen_random_uuid(); v_receipt text; v_subtotal numeric:=0; v_discount numeric:=0; v_tax numeric:=0; v_cogs numeric:=0; v_sku text; v_qty numeric; v_price numeric; v_cost numeric; v_comp record; v_have numeric; v_need numeric; v_item public.items%rowtype; v_tax_rate numeric;
begin
 perform public.require_staff(); if jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)=0 then raise exception 'Sale requires at least one line'; end if;
 if p_discount_percent<0 or p_discount_percent>100 then raise exception 'Discount must be between 0 and 100 percent'; end if;
 select coalesce((value#>>'{}')::numeric,.0725) into v_tax_rate from public.settings where setting_key='sales_tax_rate'; v_tax_rate:=coalesce(v_tax_rate,.0725);
 v_receipt:='ZBZ-'||to_char(now(),'YYMMDD-HH24MISS')||'-'||substr(v_sale::text,1,4);
 insert into public.sales(id,receipt_no,location_id,customer_id,subtotal,discount,tax,total,cogs,created_by) values(v_sale,v_receipt,p_location,p_customer,0,0,0,0,0,auth.uid());
 for v_sku,v_qty in select x.sku,x.qty from jsonb_to_recordset(p_lines) as x(sku text,qty numeric) loop
  if v_qty<=0 then raise exception 'Line quantities must be positive'; end if;
  select * into v_item from public.items where sku=v_sku and active for update; if not found then raise exception 'Unknown or inactive item %',v_sku; end if;
  v_price:=v_item.selling_price; v_cost:=v_item.unit_cost;
  select coalesce(sum(b.quantity*c.unit_cost),0) into v_cost from public.bom_lines b join public.items c on c.sku=b.component_sku where b.parent_sku=v_sku;
  if exists(select 1 from public.bom_lines where parent_sku=v_sku) then
   for v_comp in select b.component_sku,b.quantity*c.unit_cost as unit_cost,b.quantity from public.bom_lines b join public.items c on c.sku=b.component_sku where b.parent_sku=v_sku loop
    v_need:=v_comp.quantity*v_qty;
    select coalesce(sum(quantity),0) into v_have from public.inventory_transactions where item_sku=v_comp.component_sku and location_id=p_location;
    if v_have<v_need then raise exception 'Insufficient % at selected location (need %, have %)',v_comp.component_sku,v_need,v_have; end if;
    insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type,reference_document,user_id)
    values(v_comp.component_sku,p_location,-v_need,(select unit_cost from public.items where sku=v_comp.component_sku),'Sale',v_receipt,auth.uid());
   end loop;
  else
   select coalesce(sum(quantity),0) into v_have from public.inventory_transactions where item_sku=v_sku and location_id=p_location;
   if v_have<v_qty then raise exception 'Insufficient % at selected location',v_sku; end if;
   insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type,reference_document,user_id) values(v_sku,p_location,-v_qty,v_cost,'Sale',v_receipt,auth.uid());
  end if;
  insert into public.sale_lines(sale_id,item_sku,quantity,unit_price,unit_cost) values(v_sale,v_sku,v_qty,v_price,v_cost);
  v_subtotal:=v_subtotal+v_qty*v_price; v_cogs:=v_cogs+v_qty*v_cost;
 end loop;
 v_discount:=v_subtotal*p_discount_percent/100; v_tax:=(v_subtotal-v_discount)*v_tax_rate;
 update public.sales set subtotal=v_subtotal,discount=v_discount,tax=v_tax,total=v_subtotal-v_discount+v_tax,cogs=v_cogs where id=v_sale;
 return jsonb_build_object('sale_id',v_sale,'receipt_no',v_receipt,'subtotal',v_subtotal,'discount',v_discount,'tax',v_tax,'total',v_subtotal-v_discount+v_tax,'cogs',v_cogs);
end $$;

create or replace function public.issue_production_order(p_order uuid)
returns void language plpgsql security definer set search_path=public as $$
declare v_order public.production_orders%rowtype; v_line record; v_have numeric;
begin
 perform public.require_staff(); select * into v_order from public.production_orders where id=p_order for update;
 if not found or v_order.status<>'Planned' then raise exception 'Production order is not planned'; end if;
 for v_line in select b.component_sku,b.quantity from public.bom_lines b where b.parent_sku=v_order.parent_sku loop
  select coalesce(sum(quantity),0) into v_have from public.inventory_transactions where item_sku=v_line.component_sku and location_id=v_order.location_id;
  if v_have<v_line.quantity*v_order.quantity_started then raise exception 'Insufficient component stock: %',v_line.component_sku; end if;
  insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type,reference_document,user_id)
  select v_line.component_sku,v_order.location_id,-v_line.quantity*v_order.quantity_started,i.unit_cost,'Production Issue',v_order.order_no,auth.uid() from public.items i where i.sku=v_line.component_sku;
 end loop;
 update public.production_orders set status='In Progress',started_at=now() where id=p_order;
end $$;

create or replace function public.complete_production_order(p_order uuid,p_good numeric,p_scrapped numeric,p_reason text default null)
returns void language plpgsql security definer set search_path=public as $$
declare v_order public.production_orders%rowtype; v_cost numeric;
begin
 perform public.require_staff(); select * into v_order from public.production_orders where id=p_order for update;
 if not found or v_order.status<>'In Progress' then raise exception 'Production order must be in progress'; end if;
 if p_good<0 or p_scrapped<0 or p_good+p_scrapped>v_order.quantity_started then raise exception 'Invalid good or scrap quantity'; end if;
 if p_scrapped>0 and coalesce(trim(p_reason),'')='' then raise exception 'Scrap reason is required'; end if;
 select coalesce(sum(b.quantity*i.unit_cost),0) into v_cost from public.bom_lines b join public.items i on i.sku=b.component_sku where b.parent_sku=v_order.parent_sku;
 if p_good>0 then insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type,reference_document,user_id)
 values(v_order.parent_sku,v_order.location_id,p_good,v_cost,'Production Receipt',v_order.order_no,auth.uid()); end if;
 if p_scrapped>0 then insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type,reason_code,reference_document,user_id)
 values(v_order.parent_sku,v_order.location_id,-p_scrapped,v_cost,'Waste',p_reason,v_order.order_no,auth.uid()); end if;
 update public.production_orders set status='Completed',quantity_good=p_good,quantity_scrapped=p_scrapped,finished_at=now(),reason_code=p_reason where id=p_order;
end $$;

alter table public.locations enable row level security;
alter table public.profiles enable row level security;
alter table public.customers enable row level security;
alter table public.suppliers enable row level security;
alter table public.items enable row level security;
alter table public.bom_lines enable row level security;
alter table public.settings enable row level security;
alter table public.inventory_transactions enable row level security;
alter table public.sales enable row level security;
alter table public.sale_lines enable row level security;
alter table public.sales_orders enable row level security;
alter table public.sales_order_lines enable row level security;
alter table public.purchase_orders enable row level security;
alter table public.purchase_order_lines enable row level security;
alter table public.supplier_invoices enable row level security;
alter table public.production_orders enable row level security;

create policy "signed in users read items" on public.items for select to authenticated using(true);
create policy "signed in users read locations" on public.locations for select to authenticated using(true);
create policy "staff read inventory ledger" on public.inventory_transactions for select to authenticated using(public.current_role() in ('Manager','Cashier'));
create policy "staff read suppliers" on public.suppliers for select to authenticated using(public.current_role() in ('Manager','Cashier'));
create policy "staff read POs" on public.purchase_orders for select to authenticated using(public.current_role() in ('Manager','Cashier'));
create policy "staff read PO lines" on public.purchase_order_lines for select to authenticated using(public.current_role() in ('Manager','Cashier'));
create policy "staff read sales" on public.sales for select to authenticated using(public.current_role() in ('Manager','Cashier'));
create policy "staff read sale lines" on public.sale_lines for select to authenticated using(public.current_role() in ('Manager','Cashier'));
create policy "user reads own profile" on public.profiles for select to authenticated using(user_id=auth.uid() or public.current_role()='Manager');
create policy "manager edits settings" on public.settings for all to authenticated using(public.current_role()='Manager') with check(public.current_role()='Manager');
create policy "customer sees own orders" on public.sales_orders for select to authenticated using(created_by=auth.uid() or public.current_role() in ('Manager','Cashier'));

grant execute on function public.post_transfer(text,uuid,uuid,numeric) to authenticated;
grant execute on function public.post_adjustment(text,uuid,numeric,text) to authenticated;
grant execute on function public.receive_purchase_order(uuid,uuid,numeric,numeric,timestamptz) to authenticated;
grant execute on function public.record_sale(uuid,jsonb,numeric,uuid) to authenticated;
grant execute on function public.issue_production_order(uuid) to authenticated;
grant execute on function public.complete_production_order(uuid,numeric,numeric,text) to authenticated;

do $$ begin
 alter publication supabase_realtime add table public.inventory_transactions;
 alter publication supabase_realtime add table public.sales;
 alter publication supabase_realtime add table public.sales_orders;
exception when duplicate_object then null; when undefined_object then null; end $$;
