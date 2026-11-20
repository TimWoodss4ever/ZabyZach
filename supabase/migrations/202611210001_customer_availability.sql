-- Customer-safe current availability. Apply after the MRP planning hardening and stock visibility migrations. This adds read/configuration endpoints and does not rewrite any
-- existing ledger, checkout, purchasing, or sample-history records.
begin;
select pg_advisory_xact_lock(1179468369,210001);

do $$ begin
 if to_regprocedure('public.erp_history_menu(date,date,uuid)') is null
  or to_regprocedure('public.erp_history_usage(date,date,uuid)') is null
  or to_regprocedure('public.erp_checkout_order(uuid,jsonb)') is null then
  raise exception 'Customer availability prerequisites are missing. Nothing was installed.';
 end if;
end $$;

-- Preserve the already-reviewed customer checkout permission hotfix when a
-- database was built from the older completion migration. Match the guard
-- formatting-tolerantly, verify the owner-checking public wrapper, and leave
-- every other helper expression unchanged. No order or sale is posted here.
do $checkout_guard$
declare
 helper regprocedure:=to_regprocedure('public.erp_checkout_post_sale(uuid,jsonb,numeric,numeric,uuid)');
 checkout regprocedure:=to_regprocedure('public.erp_checkout_order(uuid,jsonb)');
 creator regprocedure:=to_regprocedure('public.erp_create_pickup_order(uuid,jsonb)');
 original text;corrected text;wrapper text;creator_body text;matches integer;
 staff_pattern text:=$pattern$coalesce[[:space:]]*\([[:space:]]*public\.current_role[[:space:]]*\([[:space:]]*\)[[:space:]]*,[[:space:]]*''[[:space:]]*\)[[:space:]]+not[[:space:]]+in[[:space:]]*\([[:space:]]*'Manager'[[:space:]]*,[[:space:]]*'Cashier'[[:space:]]*\)$pattern$;
 customer_pattern text:=$pattern$coalesce[[:space:]]*\([[:space:]]*public\.current_role[[:space:]]*\([[:space:]]*\)[[:space:]]*,[[:space:]]*''[[:space:]]*\)[[:space:]]+not[[:space:]]+in[[:space:]]*\([[:space:]]*'Manager'[[:space:]]*,[[:space:]]*'Cashier'[[:space:]]*,[[:space:]]*'Customer'[[:space:]]*\)$pattern$;
begin
 if helper is null or checkout is null then raise exception 'The reviewed customer checkout functions are missing. Nothing was installed.'; end if;
 if not (select prosecdef from pg_proc where oid=helper::oid) then raise exception 'Checkout posting helper is not SECURITY DEFINER. Nothing was installed.'; end if;
 original:=pg_get_functiondef(helper::oid);
 wrapper:=lower(regexp_replace(pg_get_functiondef(checkout::oid),'[[:space:]]+',' ','g'));
 -- Support both the original owner-checking wrapper and the current wrapper,
 -- which delegates creation to an owner-checking order function.
 if position('o.created_by is distinct from auth.uid()' in wrapper)>0
  and position('erp_checkout_post_sale' in wrapper)>0 then
  null;
 else
  if creator is null then raise exception 'The reviewed customer-order function is missing. Nothing was installed.'; end if;
  creator_body:=lower(regexp_replace(pg_get_functiondef(creator::oid),'[[:space:]]+',' ','g'));
  if position('public.erp_create_pickup_order' in wrapper)=0
   or position('public.current_role() is distinct from ''customer''' in wrapper)=0
   or position('existing.created_by is distinct from auth.uid()' in creator_body)=0 then
   raise exception 'Checkout differs from the reviewed ownership-checked definitions. Nothing was installed.';
  end if;
 end if;
 if position('Sale requires lines' in original)=0 then
  raise exception 'Checkout differs from the reviewed posting helper. Nothing was installed.';
 end if;
 select count(*) into matches from regexp_matches(original,staff_pattern,'gi');
 if matches=1 then
  corrected:=regexp_replace(original,staff_pattern,
   $replacement$coalesce(public.current_role(), '') NOT IN ('Manager', 'Cashier', 'Customer')$replacement$,'i');
  execute corrected;
 elsif matches=0 then
  select count(*) into matches from regexp_matches(original,customer_pattern,'gi');
  if matches<>1 then raise exception 'Unexpected checkout permission guard. Nothing was installed.'; end if;
 else raise exception 'Multiple checkout permission guards found. Nothing was installed.';
 end if;
 revoke all on function public.erp_checkout_post_sale(uuid,jsonb,numeric,numeric,uuid) from public,anon,authenticated;
end $checkout_guard$;

-- Used only when a valid 180-day reorder point cannot be calculated. The
-- defaults mean one complete recipe serving for recipe components and one
-- sellable unit for standalone products. Managers can tune both shared values.
create table if not exists public.erp_customer_availability_options (
 singleton boolean primary key default true check(singleton),
 minimum_recipe_servings numeric not null default 1 check(minimum_recipe_servings between .25 and 100),
 minimum_standalone_units numeric not null default 1 check(minimum_standalone_units between .25 and 100),
 revision integer not null default 1
);
insert into public.erp_customer_availability_options(singleton) values(true)
 on conflict(singleton) do nothing;
alter table public.erp_customer_availability_options enable row level security;
revoke all on public.erp_customer_availability_options from public,anon,authenticated;

create or replace function public.erp_customer_availability(p_location_name text)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare
 loc public.locations%rowtype;
 cfg public.erp_customer_availability_options%rowtype;
 today date:=(now() at time zone 'America/Denver')::date;
 answer jsonb;
begin
 if auth.uid() is null or public.current_role() is distinct from 'Customer' then
  raise exception 'Customer role required' using errcode='42501';
 end if;
 select * into loc from public.locations where name=trim(p_location_name) and can_sell and name<>'Central Commissary';
 if not found then raise exception 'Choose an available pickup location' using errcode='22023'; end if;
 select * into cfg from public.erp_customer_availability_options where singleton;
 if not found then raise exception 'Customer availability settings are missing'; end if;

 -- New online orders remain unposted until preparation. Reserve open order
 -- quantities here so the customer view reflects stock already committed to
 -- orders. Use finished product stock first, then reserve recipe components
 -- for the remaining make-to-order quantity. Future ledger entries and open
 -- purchase orders are excluded from current stock.
 with
 ledger_stock as (
  select t.item_sku,greatest(0,coalesce(sum(t.quantity),0)) on_hand
  from public.inventory_transactions t
  where t.location_id=loc.id and t.occurred_at<=statement_timestamp()
  group by t.item_sku
 ),
 pending_order_demand as (
  select l.item_sku,sum(l.quantity)::numeric demand
  from public.sales_orders o join public.sales_order_lines l on l.order_id=o.id
  where o.location_id=loc.id and o.status='Order Placed' and o.erp_sale_id is null
  group by l.item_sku
 ),
 direct_reservations as (
  select d.item_sku,least(d.demand,coalesce(s.on_hand,0)) reserved
  from pending_order_demand d left join ledger_stock s on s.item_sku=d.item_sku
 ),
 component_reservations as (
  select b.component_sku item_sku,
   sum(greatest(d.demand-coalesce(s.on_hand,0),0)*b.quantity) reserved
  from pending_order_demand d
  join public.bom_lines b on b.parent_sku=d.item_sku
  left join ledger_stock s on s.item_sku=d.item_sku
  group by b.component_sku
 ),
 raw_stock as (
  select s.item_sku,greatest(0,s.on_hand-coalesce(d.reserved,0)-coalesce(c.reserved,0)) on_hand
  from ledger_stock s
  left join direct_reservations d on d.item_sku=s.item_sku
  left join component_reservations c on c.item_sku=s.item_sku
 ),
 ingredient_usage as (
  select u.item_sku,u.daily from public.erp_history_usage(today-179,today,loc.id) u
 ),
 ingredient_basis as (
  select b.component_sku,
   max(b.quantity) filter(where p.category='Pizza' and p.active and p.selling_price>0) recipe_serving
  from public.bom_lines b join public.items p on p.sku=b.parent_sku
  group by b.component_sku
 ),
 ingredient_stock as (
  select i.sku,i.name,i.category,i.base_unit unit,
   coalesce(s.on_hand,0) on_hand,
   case when coalesce(u.daily,0)>0 and (greatest(coalesce(case when supplier.erp_active then supplier.quoted_lead_days end,i.lead_days,0),0)+coalesce(po.safety_days,0))>0
     then u.daily*(greatest(coalesce(case when supplier.erp_active then supplier.quoted_lead_days end,i.lead_days,0),0)+coalesce(po.safety_days,0))
     else coalesce(b.recipe_serving*cfg.minimum_recipe_servings,cfg.minimum_standalone_units)
   end low_threshold
  from public.items i
  left join raw_stock s on s.item_sku=i.sku
  left join ingredient_usage u on u.item_sku=i.sku
  left join ingredient_basis b on b.component_sku=i.sku
  left join public.suppliers supplier on supplier.id=i.supplier_id
  left join public.erp_purchasing_options po on po.singleton
 ),
 ingredient_status as (
  select x.*,
   case when x.on_hand<=0 then 'Unavailable'
    when x.on_hand<=x.low_threshold then 'Low stock' else 'Available' end status
  from ingredient_stock x
 ),
 product_usage as (
  select e.item_sku,sum(e.quantity)::numeric/180 daily
  from (
   select sl.item_sku,sl.quantity from public.sales s join public.sale_lines sl on sl.sale_id=s.id
   where s.location_id=loc.id and s.status='Completed'
    and s.created_at>=((today-179)::timestamp at time zone 'America/Denver')
    and s.created_at<least(((today+1)::timestamp at time zone 'America/Denver'),statement_timestamp())
   union all
   select h.item_sku,h.quantity::numeric from public.erp_history_menu(today-179,today,loc.id) h
  ) e group by e.item_sku
 ),
 products as (
  select i.sku,i.name,i.category,i.base_unit unit,
   case when exists(select 1 from public.bom_lines b where b.parent_sku=i.sku)
     then floor(coalesce(s.on_hand,0))::integer else floor(coalesce(s.on_hand,0))::integer end finished_units,
   case when exists(select 1 from public.bom_lines b where b.parent_sku=i.sku) then
     coalesce((select floor(min(coalesce(cs.on_hand,0)/nullif(b.quantity,0)))::integer
       from public.bom_lines b left join ingredient_status cs on cs.sku=b.component_sku
       where b.parent_sku=i.sku),0)
     else 0 end makeable_units,
   case when coalesce(u.daily,0)>0 and (greatest(coalesce(case when supplier.erp_active then supplier.quoted_lead_days end,i.lead_days,0),0)+coalesce(po.safety_days,0))>0
     then u.daily*(greatest(coalesce(case when supplier.erp_active then supplier.quoted_lead_days end,i.lead_days,0),0)+coalesce(po.safety_days,0))
     else cfg.minimum_standalone_units end low_threshold
  from public.items i
  left join raw_stock s on s.item_sku=i.sku
  left join product_usage u on u.item_sku=i.sku
  left join public.suppliers supplier on supplier.id=i.supplier_id
  left join public.erp_purchasing_options po on po.singleton
  where i.active and i.selling_price>0 and i.category in('Pizza','Sides','Beverage')
 ),
 product_capacity as (
  select p.*,(p.finished_units+p.makeable_units) available_units
  from products p
 ),
 product_status as (
  select p.*,
   case when p.available_units<=0 then 'Unavailable'
    when p.available_units<=p.low_threshold then 'Low stock' else 'Available' end status
  from product_capacity p
 ),
 component_lists as (
  select p.sku parent_sku,
   coalesce((select jsonb_agg(jsonb_build_object(
     'sku',b.component_sku,'name',c.name,'category',c.category,'unit',c.unit,
     'quantity_per_item',b.quantity,'available_units',c.on_hand,'status',c.status
    ) order by c.name,b.component_sku)
    from public.bom_lines b join ingredient_status c on c.sku=b.component_sku
    where b.parent_sku=p.sku),'[]'::jsonb) components
  from product_status p
 ),
 products_json as (
  select coalesce(jsonb_agg(jsonb_build_object(
   'sku',p.sku,'name',p.name,'category',p.category,'unit',p.unit,
   'status',p.status,'available_units',p.available_units,
   'finished_units',p.finished_units,'makeable_units',p.makeable_units,
   'components',c.components
  ) order by case p.category when 'Pizza' then 1 when 'Sides' then 2 else 3 end,p.name,p.sku),'[]'::jsonb) value
  from product_status p join component_lists c on c.parent_sku=p.sku
 ),
 components_json as (
  select coalesce(jsonb_agg(jsonb_build_object(
   'sku',x.sku,'name',x.name,'category',x.category,'unit',x.unit,
   'status',x.status,'available_units',x.on_hand,
   'used_in',x.used_in
  ) order by x.name,x.sku),'[]'::jsonb) value
  from (
   select distinct c.sku,c.name,c.category,c.unit,c.status,c.on_hand,
    array(select distinct p.name from public.bom_lines b join public.items p on p.sku=b.parent_sku
      where b.component_sku=c.sku and p.active and p.category='Pizza' and p.selling_price>0 order by p.name) used_in
   from ingredient_status c join public.bom_lines b on b.component_sku=c.sku
   join public.items p on p.sku=b.parent_sku
   where p.active and p.category='Pizza' and p.selling_price>0 and c.category='Ingredient'
  ) x
 )
 select jsonb_build_object(
  'location',loc.name,
  'as_of',statement_timestamp(),
  'refresh_seconds',15,
  'products',(select value from products_json),
  'ingredients',(select value from components_json),
  'low_rule','Low stock means at or below the location reorder point from 180-day usage × (item lead days + shared safety days). When that cannot be calculated, the manager-configured minimum recipe servings or standalone units is used.'
 ) into answer;
 return answer;
end $$;

create or replace function public.erp_customer_pickup_locations()
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare answer jsonb;begin
 if auth.uid() is null or public.current_role() is distinct from 'Customer' then
  raise exception 'Customer role required' using errcode='42501';
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('name',l.name) order by l.name),'[]'::jsonb)
 into answer from public.locations l where l.can_sell and l.name<>'Central Commissary';
 return answer;
end $$;

create or replace function public.erp_customer_availability_options_read()
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare answer jsonb;begin
 if auth.uid() is null or public.current_role() is distinct from 'Manager' then
  raise exception 'Manager role required' using errcode='42501';
 end if;
 select to_jsonb(o) into answer from public.erp_customer_availability_options o where singleton;
 if answer is null then raise exception 'Customer availability settings are missing'; end if;
 return answer;
end $$;

create or replace function public.erp_customer_availability_options_save(
 p_revision integer,p_minimum_recipe_servings numeric,p_minimum_standalone_units numeric)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare answer jsonb;begin
 if auth.uid() is null or public.current_role() is distinct from 'Manager' then
  raise exception 'Manager role required' using errcode='42501';
 end if;
 if p_minimum_recipe_servings is null or p_minimum_recipe_servings not between .25 and 100
  or p_minimum_standalone_units is null or p_minimum_standalone_units not between .25 and 100 then
  raise exception 'Minimum stock settings must be between 0.25 and 100';
 end if;
 update public.erp_customer_availability_options set
  minimum_recipe_servings=p_minimum_recipe_servings,
  minimum_standalone_units=p_minimum_standalone_units,revision=revision+1
 where singleton and revision=p_revision;
 if not found then raise exception 'Customer availability settings changed; refresh and try again' using errcode='40001'; end if;
 select to_jsonb(o) into answer from public.erp_customer_availability_options o where singleton;
 return answer;
end $$;

revoke all on function public.erp_customer_availability(text),
 public.erp_customer_pickup_locations(),
 public.erp_customer_availability_options_read(),
 public.erp_customer_availability_options_save(integer,numeric,numeric) from public,anon,authenticated;
grant execute on function public.erp_customer_availability(text),
 public.erp_customer_pickup_locations(),
 public.erp_customer_availability_options_read(),
 public.erp_customer_availability_options_save(integer,numeric,numeric) to authenticated;
commit;

select 'Customer availability RPC and manager-configured low-stock defaults installed; inventory history unchanged.' as result;
