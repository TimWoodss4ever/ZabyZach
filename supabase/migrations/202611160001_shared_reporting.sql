-- Requirements 9/10. Additive: never replay earlier migrations in production.
begin;

create table if not exists public.erp_reporting_expenses (
 id uuid primary key,
 expense_date date not null,
 location_id uuid references public.locations(id),
 category text not null check(category in ('Labor','Rent','Utilities','Delivery','Other')),
 amount numeric(14,2) not null check(amount between 0.01 and 999999999),
 description text not null check(length(trim(description)) between 1 and 500),
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 voided_at timestamptz,
 voided_by uuid references auth.users(id),
 void_reason text
);
alter table public.erp_reporting_expenses enable row level security;
revoke all on public.erp_reporting_expenses from public,anon,authenticated;
create index if not exists erp_reporting_expenses_date_idx on public.erp_reporting_expenses(expense_date,location_id);

create or replace function public.erp_reporting_expense(
 p_id uuid,p_date date,p_location uuid,p_category text,p_amount numeric,p_description text
) returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare saved public.erp_reporting_expenses%rowtype;
begin
 if auth.uid() is null or public.current_role() is distinct from 'Manager' then
  raise exception 'Manager role required' using errcode='42501';
 end if;
 if p_id is null or p_date is null or p_date>(now() at time zone 'America/Denver')::date
  or p_category is null or p_category not in ('Labor','Rent','Utilities','Delivery','Other')
  or p_amount is null or not(p_amount between 0.01 and 999999999) or p_amount<>round(p_amount,2)
  or p_description is null or length(trim(p_description)) not between 1 and 500 then
  raise exception 'Provide a valid expense date, category, amount and description';
 end if;
 insert into public.erp_reporting_expenses(id,expense_date,location_id,category,amount,description,created_by)
 values(p_id,p_date,p_location,p_category,p_amount,trim(p_description),auth.uid()) on conflict(id) do nothing;
 select * into saved from public.erp_reporting_expenses where id=p_id;
 if saved.created_by<>auth.uid() or saved.expense_date<>p_date or saved.location_id is distinct from p_location
  or saved.category<>p_category or saved.amount<>p_amount or saved.description<>trim(p_description) then
  raise exception 'This expense request ID was already used for different values';
 end if;
 return saved.id;
end $$;

create or replace function public.erp_reporting_void_expense(p_id uuid,p_reason text)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if auth.uid() is null or public.current_role() is distinct from 'Manager' then
  raise exception 'Manager role required' using errcode='42501';
 end if;
 if p_reason is null or length(trim(p_reason)) not between 1 and 500 then raise exception 'A void reason is required'; end if;
 update public.erp_reporting_expenses set voided_at=now(),voided_by=auth.uid(),void_reason=trim(p_reason)
 where id=p_id and voided_at is null;
 if not found and not exists(select 1 from public.erp_reporting_expenses where id=p_id) then raise exception 'Expense not found'; end if;
end $$;

-- Replay existing posted quantities/costs; transfers do not change the company's
-- average cost. Incoming stock blends with the remaining positive stock balance.
-- This helper is private and does not change posted costs, quantities or RPCs.
create or replace function public.erp_reporting_inventory(p_start timestamptz,p_end timestamptz)
returns table(item_sku text,location_id uuid,opening_quantity numeric,quantity numeric,
 opening_cost numeric,average_cost numeric,negative_history boolean)
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare i record; t record; l record; balances jsonb; opening jsonb;
 q numeric; cost numeric; start_cost numeric; captured boolean; bad boolean; loc_qty numeric;
begin
 for i in select sku from public.items order by sku loop
  balances:='{}'; opening:='{}'; q:=0; cost:=0; start_cost:=0; captured:=false; bad:=false;
  for t in select it.* from public.inventory_transactions it
   where it.item_sku=i.sku and it.occurred_at<p_end order by it.occurred_at,it.id loop
   if not captured and t.occurred_at>=p_start then
    opening:=balances; start_cost:=cost; captured:=true;
   end if;
   loc_qty:=coalesce((balances->>t.location_id::text)::numeric,0)+t.quantity;
   balances:=jsonb_set(balances,array[t.location_id::text],to_jsonb(loc_qty));
   if t.transaction_type not in ('Transfer In','Transfer Out') then
    if t.quantity>0 then
     cost:=(greatest(q,0)*cost+t.quantity*t.unit_cost)/(greatest(q,0)+t.quantity);
    end if;
    q:=q+t.quantity;
    if q<0 then bad:=true; end if;
   end if;
   if loc_qty<0 then bad:=true; end if;
  end loop;
  if not captured then opening:=balances; start_cost:=cost; end if;
  for l in select id from public.locations loop
   item_sku:=i.sku; location_id:=l.id;
   opening_quantity:=coalesce((opening->>l.id::text)::numeric,0);
   quantity:=coalesce((balances->>l.id::text)::numeric,0);
   opening_cost:=start_cost; average_cost:=cost; negative_history:=bad;
   return next;
  end loop;
 end loop;
end $$;

create or replace function public.erp_reporting_snapshot(p_from date,p_to date,p_location uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare result jsonb; start_at timestamptz; end_at timestamptz; business_today date;
begin
 if auth.uid() is null or public.current_role() is distinct from 'Manager' then
  raise exception 'Manager role required' using errcode='42501';
 end if;
 business_today:=(now() at time zone 'America/Denver')::date;
 if p_from is null or p_to is null or p_from>p_to or p_to>business_today or p_to-p_from>3660 then
  raise exception 'Choose an ordered date range of at most 3661 days ending today or earlier';
 end if;
 if p_location is not null and not exists(select 1 from public.locations where id=p_location) then raise exception 'Unknown location'; end if;
 start_at:=p_from::timestamp at time zone 'America/Denver';
 end_at:=least((p_to+1)::timestamp at time zone 'America/Denver',now());
 with
 inv as materialized (select v.*,i.name,i.category,i.base_unit,i.purchase_unit,i.conversion_factor,i.active,i.supplier_id,i.lead_days,i.shelf_life_days,
  exists(select 1 from public.bom_lines b where b.parent_sku=i.sku) made,l.name location_name
  from public.erp_reporting_inventory(start_at,end_at) v join public.items i on i.sku=v.item_sku join public.locations l on l.id=v.location_id),
 sales_in_period as materialized (select s.* from public.sales s where s.status='Completed'
  and s.created_at>=start_at and s.created_at<end_at and (p_location is null or s.location_id=p_location)),
 returns_in_period as materialized (select r.* from public.sales_returns r join public.sales s on s.id=r.original_sale_id
  where r.created_at>=start_at and r.created_at<end_at and (p_location is null or s.location_id=p_location)),
 return_lines as materialized (select l.* from public.sales_return_lines l join returns_in_period r on r.id=l.return_id),
 expenses as materialized (select e.* from public.erp_reporting_expenses e where e.expense_date between p_from and p_to
  and (p_location is null or e.location_id=p_location)),
 movements as materialized (select t.* from public.inventory_transactions t where t.occurred_at>=start_at and t.occurred_at<end_at
  and (p_location is null or t.location_id=p_location)),
 daily_events as (
  select (s.created_at at time zone 'America/Denver')::date day,s.subtotal gross,s.discount discount,0::numeric refunds,s.tax tax from sales_in_period s
  union all select (r.created_at at time zone 'America/Denver')::date,0,0,r.refund_subtotal,-r.refund_tax from returns_in_period r),
 days as (select d::date day from generate_series(p_from::timestamp,p_to::timestamp,interval '1 day')d),
 daily as (select d.day,coalesce(sum(e.gross),0) gross,coalesce(sum(e.discount),0) discount,coalesce(sum(e.refunds),0) refunds,
  coalesce(sum(e.gross-e.discount-e.refunds),0) net,coalesce(sum(e.tax),0) tax from days d left join daily_events e on e.day=d.day group by d.day),
 weekly as (select date_trunc('week',day)::date week,sum(net) net from daily group by 1),
 top_events as (
  select l.item_sku,l.quantity units,l.quantity*l.unit_price revenue from public.sale_lines l join sales_in_period s on s.id=l.sale_id
  union all select l.item_sku,-l.quantity,-l.refund_subtotal from return_lines l),
 usage as (select t.item_sku,t.location_id,sum(-t.quantity)/30 daily from public.inventory_transactions t
  where t.quantity<0 and t.transaction_type in ('Sale','Production Issue') and t.occurred_at>=end_at-interval '30 days'
  and t.occurred_at<end_at group by t.item_sku,t.location_id),
 inbound as (select pol.item_sku,po.ship_to_location_id location_id,
  sum(greatest(pol.quantity_purchase-pol.quantity_received_purchase,0)*i.conversion_factor) quantity
  from public.purchase_order_lines pol join public.purchase_orders po on po.id=pol.purchase_order_id join public.items i on i.sku=pol.item_sku
  where po.status in ('Order Sent','Partially Received') and po.ordered_at<end_at
  group by pol.item_sku,po.ship_to_location_id),
 policy as (select coalesce((select safety_days from public.erp_purchasing_options where singleton),2) safety,
  coalesce((select review_days from public.erp_purchasing_options where singleton),7) review),
 replenishment as (select v.*,s.name supplier,s.erp_active supplier_active,
  greatest(coalesce(s.quoted_lead_days,v.lead_days),0) lead,
  coalesce(u.daily,0) daily_usage,coalesce(b.quantity,0) on_order,policy.safety,policy.review
  from inv v cross join policy left join public.suppliers s on s.id=v.supplier_id
  left join usage u on u.item_sku=v.item_sku and u.location_id=v.location_id
  left join inbound b on b.item_sku=v.item_sku and b.location_id=v.location_id
  where v.active and not v.made and (p_location is null or v.location_id=p_location)),
 deliveries as (
  select po.id,po.supplier_id,coalesce(po.erp_quoted_lead_days,s.quoted_lead_days) quoted,
   (max(r.received_on)-(po.ordered_at at time zone 'America/Denver')::date)::numeric actual
  from public.purchase_orders po join public.suppliers s on s.id=po.supplier_id join public.erp_purchase_receipts r on r.purchase_order_id=po.id
  where po.status='Received' and r.received_on<=p_to and (p_location is null or po.ship_to_location_id=p_location)
  group by po.id,s.quoted_lead_days
  having max(r.received_on) between p_from and p_to
  union all
  select po.id,po.supplier_id,coalesce(po.erp_quoted_lead_days,s.quoted_lead_days),
   ((coalesce(po.erp_legacy_received_at,po.received_at) at time zone 'America/Denver')::date-(po.ordered_at at time zone 'America/Denver')::date)::numeric
  from public.purchase_orders po join public.suppliers s on s.id=po.supplier_id
  where po.status='Received' and not exists(select 1 from public.erp_purchase_receipts r where r.purchase_order_id=po.id)
   and (coalesce(po.erp_legacy_received_at,po.received_at) at time zone 'America/Denver')::date between p_from and p_to
   and (p_location is null or po.ship_to_location_id=p_location)
 )
 select jsonb_build_object(
  'version',1,'today',business_today,'generatedAt',now(),'from',p_from,'to',p_to,
  'locations',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name) order by name) from public.locations),'[]'::jsonb),
  'pnl',jsonb_build_object(
   'gross',coalesce((select sum(subtotal) from sales_in_period),0),
   'discounts',coalesce((select sum(discount) from sales_in_period),0),
   'refunds',coalesce((select sum(refund_subtotal) from returns_in_period),0),
   'tax',coalesce((select sum(tax) from sales_in_period),0)-coalesce((select sum(refund_tax) from returns_in_period),0),
   'cogs',coalesce((select sum(cogs) from sales_in_period),0)-coalesce((select sum(cost_amount) from return_lines where disposition='Restock'),0),
   'waste',coalesce((select sum(-quantity*unit_cost) from movements where transaction_type='Waste' and quantity<0),0),
   'adjustments',coalesce((select sum(quantity*unit_cost) from movements where transaction_type='Adjustment'),0),
   'expenses',coalesce((select sum(amount) from expenses where voided_at is null),0),
   'zeroCostSales',(select count(*) from sales_in_period where subtotal>0 and cogs=0)),
  'inventory',coalesce((select jsonb_agg(to_jsonb(v) order by v.location_name,v.name) from inv v where p_location is null or v.location_id=p_location),'[]'::jsonb),
  'daily',coalesce((select jsonb_agg(to_jsonb(d) order by d.day) from daily d),'[]'::jsonb),
  'weekly',coalesce((select jsonb_agg(to_jsonb(w) order by w.week) from weekly w),'[]'::jsonb),
  'topItems',coalesce((select jsonb_agg(to_jsonb(x) order by x.units desc,x.name) from (
   select e.item_sku,i.name,sum(e.units) units from top_events e join public.items i on i.sku=e.item_sku group by e.item_sku,i.name
   having sum(e.units)<>0 order by units desc,i.name limit 20)x),'[]'::jsonb),
  'lowStock',coalesce((select jsonb_agg(to_jsonb(r) order by r.quantity-r.daily_usage*(r.lead+r.safety),r.item_sku,r.location_id)
   from replenishment r where r.quantity<r.daily_usage*(r.lead+r.safety) or r.quantity<=0),'[]'::jsonb),
  'suppliers',coalesce((select jsonb_agg(to_jsonb(x) order by x.name) from (
   select s.id,s.name,count(d.id) deliveries,avg(d.actual) actual,avg(d.quoted) quoted,
   count(d.id) filter(where d.actual>d.quoted) late from public.suppliers s left join deliveries d on d.supplier_id=s.id and d.actual>=0 group by s.id)x),'[]'::jsonb),
  'expenses',coalesce((select jsonb_agg(to_jsonb(e) order by e.expense_date desc,e.created_at desc) from expenses e),'[]'::jsonb)
 ) into result;
 return result;
end $$;

revoke all on function public.erp_reporting_inventory(timestamptz,timestamptz) from public,anon,authenticated;
revoke all on function public.erp_reporting_snapshot(date,date,uuid) from public,anon,authenticated;
revoke all on function public.erp_reporting_expense(uuid,date,uuid,text,numeric,text) from public,anon,authenticated;
revoke all on function public.erp_reporting_void_expense(uuid,text) from public,anon,authenticated;
grant execute on function public.erp_reporting_snapshot(date,date,uuid) to authenticated;
grant execute on function public.erp_reporting_expense(uuid,date,uuid,text,numeric,text) to authenticated;
grant execute on function public.erp_reporting_void_expense(uuid,text) to authenticated;
commit;
