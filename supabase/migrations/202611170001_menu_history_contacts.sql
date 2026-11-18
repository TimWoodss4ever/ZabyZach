-- Apply this file only to the existing project. Do not replay old migrations.
-- Synthetic coursework history is kept OUT of the real sales/stock ledgers.
begin;
select pg_advisory_xact_lock(1179468369,170001);

-- Fail before writing if this is not the shared team schema in the supplied ZIP.
do $$ begin
 if to_regprocedure('public.erp_reporting_snapshot_v2(date,date,uuid)') is null
  or to_regprocedure('public.erp_purchasing_snapshot()') is null
  or to_regprocedure('public.erp_inventory_unit_cost(text)') is null then
  raise exception 'Required shared reporting, purchasing or inventory migration is missing. Nothing was installed.';
 end if;
end $$;

-- Original fictional demo contacts. Fill blanks only; never overwrite team edits.
with contacts(name,email,phone) as (values
 ('Wasatch Dairy Co.','orders@wasatchdairy.example','(801) 555-0134'),
 ('Valley Meats','dispatch@valleymeats.example','(801) 555-0178'),
 ('Mountain Produce','sales@mountainproduce.example','(801) 555-0119'),
 ('Summit Dry Goods','orders@summitdry.example','(801) 555-0142'),
 ('Beehive Packaging','orders@beehivepack.example','(801) 555-0161'),
 ('Cascade Beverage & Sides','sales@cascadesides.example','(801) 555-0195'),
 ('Provo Water Utility','service@provowater.example','(801) 555-0120'))
update public.suppliers s set
 contact_name=coalesce(nullif(trim(s.contact_name),''),'Orders team'),
 email=coalesce(nullif(trim(s.email),''),c.email),
 phone=coalesce(nullif(trim(s.phone),''),c.phone),
 address=coalesce(nullif(trim(s.address),''),'Utah, USA'),
 erp_revision=s.erp_revision+1
from contacts c where lower(trim(s.name))=lower(c.name) and
 (nullif(trim(s.contact_name),'') is null or nullif(trim(s.email),'') is null
  or nullif(trim(s.phone),'') is null or nullif(trim(s.address),'') is null);

create table if not exists public.erp_sample_history_batches (
 id text primary key,from_date date not null,to_date date not null,
 method text not null,created_at timestamptz not null default now(),check(from_date<=to_date)
);
create table if not exists public.erp_sample_menu_history (
 batch_id text not null references public.erp_sample_history_batches(id),
 sale_date date not null,location_id uuid not null references public.locations(id),
 item_sku text not null references public.items(sku),quantity integer not null check(quantity>0),
 unit_price numeric not null check(unit_price>=0),unit_cost numeric not null check(unit_cost>=0),
 discount numeric not null check(discount>=0),tax numeric not null check(tax>=0),
 primary key(batch_id,sale_date,location_id,item_sku),check(discount<=quantity*unit_price)
);
-- Frozen BOM explosion: subsequent recipe edits never rewrite past sample usage.
create table if not exists public.erp_sample_material_history (
 batch_id text not null references public.erp_sample_history_batches(id),
 usage_date date not null,location_id uuid not null references public.locations(id),
 item_sku text not null references public.items(sku),quantity numeric not null check(quantity>0),
 primary key(batch_id,usage_date,location_id,item_sku)
);
-- Manager-only read access; clients cannot modify or regenerate history.
alter table public.erp_sample_history_batches enable row level security;
alter table public.erp_sample_menu_history enable row level security;
alter table public.erp_sample_material_history enable row level security;
revoke all on public.erp_sample_history_batches,public.erp_sample_menu_history,public.erp_sample_material_history from public,anon,authenticated;
grant select on public.erp_sample_history_batches,public.erp_sample_menu_history,public.erp_sample_material_history to authenticated;
drop policy if exists sample_batches_manager on public.erp_sample_history_batches;
create policy sample_batches_manager on public.erp_sample_history_batches for select to authenticated using(public.current_role()='Manager');
drop policy if exists sample_menu_manager on public.erp_sample_menu_history;
create policy sample_menu_manager on public.erp_sample_menu_history for select to authenticated using(public.current_role()='Manager');
drop policy if exists sample_material_manager on public.erp_sample_material_history;
create policy sample_material_manager on public.erp_sample_material_history for select to authenticated using(public.current_role()='Manager');

-- Generate ONCE: six COMPLETE calendar months plus the elapsed current month.
-- No random(): weekday, school/summer seasonality, gradual trend, weekly cycles,
-- correlated store-day variation and smaller item-level variation are repeatable.
do $$
declare business_today date:=(now() at time zone 'America/Denver')::date;
 first_day date;last_day date;tax_rate numeric;
begin
 if exists(select 1 from public.erp_sample_history_batches where id='menu-history-v1') then return;end if;
 if not exists(select 1 from public.locations where can_sell) or
  not exists(select 1 from public.items where active and selling_price>0) then
  raise exception 'Selling locations or menu items are missing. Nothing was installed.';
 end if;
 first_day:=(date_trunc('month',business_today::timestamp)-interval '6 months')::date;
 last_day:=business_today-1;
 select coalesce((value#>>'{}')::numeric,.0725) into tax_rate from public.settings where setting_key='sales_tax_rate';
 tax_rate:=coalesce(tax_rate,.0725);
 insert into public.erp_sample_history_batches values('menu-history-v1',first_day,last_day,
  'AI-generated course simulation, not actual sales. Catalog prices and rolled-up BOM costs frozen at import; weekdays/weekends, school/summer seasonality, gradual growth and deterministic bounded demand variation. Real store-days take precedence. No stock, bills or payments are posted.',now());
 with days as(select d::date AS trading_date from generate_series(first_day::timestamp,last_day::timestamp,interval '1 day') d),
 store_days as(
  select trading_date,l.id location_id,l.name,
   (case when l.name ilike '%Provo%' then 72 else 51 end)::numeric *
   (case extract(isodow from trading_date)::int when 1 then .78 when 2 then .84 when 3 then .92 when 4 then 1.08 when 5 then 1.48 when 6 then 1.42 else .86 end) *
   (case when l.name ilike '%Provo%' and extract(month from trading_date) in(5,6,7) then .70
    when l.name ilike '%Provo%' and extract(month from trading_date) in(9,10,11) then 1.14 else 1 end) *
   (case when to_char(trading_date,'MM-DD') in('12-25','01-01','07-04') then .38 else 1 end) *
   (0.95+0.10*(trading_date-first_day)::numeric/greatest(1,last_day-first_day)) *
   (1+0.06*sin(2*pi()*(trading_date-first_day)/28.0)) *
   (.90+mod(('x'||substr(md5(trading_date::text||l.id::text),1,8))::bit(32)::bigint,201)/1000.0) as demand
  from days cross join public.locations l where l.can_sell
  and not exists(select 1 from public.sales s where s.location_id=l.id and s.status='Completed'
   and s.created_at>=trading_date::timestamp at time zone 'America/Denver'
   and s.created_at<(trading_date+1)::timestamp at time zone 'America/Denver')
 ), mix as(
  select sd.*,i.sku,i.selling_price,public.erp_inventory_unit_cost(i.sku) unit_cost,
   case i.sku when '2001' then .22 when '2002' then .34 when '2003' then .10
    when '2004' then .14 when '2005' then .07 when '2006' then .13 when '2007' then .23
    when '1018' then .29 when '1051' then .09 when '1052' then .12 when '1053' then .07
    when '1054' then .11 when '1055' then .06 when '1017' then .17
    when '1041' then .08 when '1042' then .05 when '1043' then .06 when '1044' then .04
    else case when i.category='Pizza' then .06 when i.category='Beverage' then .04 else .05 end end as share,
   (.82+mod(('x'||substr(md5(sd.trading_date::text||sd.location_id::text||i.sku),1,8))::bit(32)::bigint,361)/1000.0) item_factor,
   case when i.category='Beverage' and extract(month from sd.trading_date) in(6,7,8) then 1.18
    when i.sku='2007' and extract(isodow from sd.trading_date) in(5,6) then 1.12 else 1 end item_season
  from store_days sd cross join public.items i where i.active and i.selling_price>0
 ), quantities as(
  select *,greatest(1,round(demand*share*item_factor*item_season))::integer quantity,
   case when extract(isodow from trading_date) in(1,2) then .045 else .015 end discount_rate from mix
 )
 insert into public.erp_sample_menu_history(batch_id,sale_date,location_id,item_sku,quantity,unit_price,unit_cost,discount,tax)
 select 'menu-history-v1',trading_date,location_id,sku,quantity,selling_price,unit_cost,
  round(quantity*selling_price*discount_rate,2),round((quantity*selling_price-round(quantity*selling_price*discount_rate,2))*tax_rate,2)
 from quantities;
 -- All nested components, including dough, are planned from the actual BOM.
 -- Keep intermediate ingredients too: dough usage and flour requirements stay visible.
 with recursive explosion(trading_date,location_id,sku,quantity,path) as(
  select sale_date,location_id,item_sku,quantity::numeric,array[item_sku] from public.erp_sample_menu_history where batch_id='menu-history-v1'
  union all select e.trading_date,e.location_id,b.component_sku,e.quantity*b.quantity,e.path||b.component_sku
   from explosion e join public.bom_lines b on b.parent_sku=e.sku where not b.component_sku=any(e.path) and cardinality(e.path)<64
 )
 insert into public.erp_sample_material_history(batch_id,usage_date,location_id,item_sku,quantity)
 select 'menu-history-v1',trading_date,location_id,sku,sum(quantity) from explosion e
 where not exists(select 1 from public.items i where i.sku=e.sku and i.selling_price>0 and exists(select 1 from public.bom_lines b where b.parent_sku=i.sku))
 group by trading_date,location_id,sku;
end $$;

-- Source precedence applies at STORE-DAY level to avoid mixing partial real
-- receipts with a full simulated trading day. Actual ledger usage stays intact.
create or replace function public.erp_history_menu(p_from date,p_to date,p_location uuid default null)
returns setof public.erp_sample_menu_history language sql stable security definer set search_path=pg_catalog,public as $$
 select h.* from public.erp_sample_menu_history h where h.sale_date between p_from and p_to
 and (p_location is null or h.location_id=p_location)
 and not exists(select 1 from public.sales s where s.location_id=h.location_id and s.status='Completed'
  and s.created_at>=h.sale_date::timestamp at time zone 'America/Denver'
  and s.created_at<(h.sale_date+1)::timestamp at time zone 'America/Denver');
$$;
create or replace function public.erp_history_usage(p_from date,p_to date,p_location uuid default null)
returns table(item_sku text,location_id uuid,daily numeric) language sql stable security definer set search_path=pg_catalog,public as $$
 with actual_days as materialized(
  select distinct s.location_id,(s.created_at at time zone 'America/Denver')::date AS trading_date from public.sales s where s.status='Completed'
   and s.created_at>=p_from::timestamp at time zone 'America/Denver' and s.created_at<least((p_to+1)::timestamp at time zone 'America/Denver',now())
  union select distinct t.location_id,(t.occurred_at at time zone 'America/Denver')::date from public.inventory_transactions t
   where t.quantity<0 and t.transaction_type in('Sale','Production Issue','Backorder Fulfillment')
   and t.occurred_at>=p_from::timestamp at time zone 'America/Denver' and t.occurred_at<least((p_to+1)::timestamp at time zone 'America/Denver',now())
 ), events as(
  select t.item_sku,t.location_id,-t.quantity quantity from public.inventory_transactions t
   where t.quantity<0 and t.transaction_type in('Sale','Production Issue','Backorder Fulfillment')
   and t.occurred_at>=p_from::timestamp at time zone 'America/Denver' and t.occurred_at<least((p_to+1)::timestamp at time zone 'America/Denver',now())
   and (p_location is null or t.location_id=p_location)
  union all select h.item_sku,h.location_id,h.quantity from public.erp_sample_material_history h
   where h.usage_date between p_from and p_to and (p_location is null or h.location_id=p_location)
   and not exists(select 1 from actual_days d where d.location_id=h.location_id and d.trading_date=h.usage_date)
 ) select e.item_sku,e.location_id,sum(e.quantity)/greatest(1,p_to-p_from+1) from events e group by e.item_sku,e.location_id;
$$;

-- Aggregate sample usage only; the inventory page keeps its real ledger reads.
create or replace function public.erp_inventory_sample_usage()
returns table(item_sku text,location_id uuid,quantity numeric,transaction_type text)
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare today date:=(now() at time zone 'America/Denver')::date;begin
 perform public.require_staff();
 return query select h.item_sku,h.location_id,-sum(h.quantity),'Sale'::text
 from public.erp_sample_material_history h where h.usage_date between today-179 and today
 and not exists(select 1 from public.sales s where s.location_id=h.location_id and s.status='Completed'
  and s.created_at>=h.usage_date::timestamp at time zone 'America/Denver'
  and s.created_at<(h.usage_date+1)::timestamp at time zone 'America/Denver')
 and not exists(select 1 from public.inventory_transactions t where t.location_id=h.location_id and t.quantity<0
  and t.transaction_type in('Sale','Production Issue','Backorder Fulfillment')
  and t.occurred_at>=h.usage_date::timestamp at time zone 'America/Denver'
  and t.occurred_at<(h.usage_date+1)::timestamp at time zone 'America/Denver')
 group by h.item_sku,h.location_id;
end $$;
revoke all on function public.erp_inventory_sample_usage() from public,anon,authenticated;
grant execute on function public.erp_inventory_sample_usage() to authenticated;

-- New read endpoints wrap the existing contracts. Old website stays operational
-- while SQL is installed; no operational RPC or original report is replaced.
create or replace function public.erp_purchasing_snapshot_with_history() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare result jsonb;today date:=(now() at time zone 'America/Denver')::date;begin
 result:=public.erp_purchasing_snapshot(); -- existing manager authorization
 return result||jsonb_build_object('dailyUsage',coalesce((select jsonb_object_agg(u.item_sku,u.daily) from(
  select h.item_sku,sum(h.daily) daily from public.erp_history_usage(today-179,today) h group by h.item_sku)u),'{}'::jsonb));
end $$;

create or replace function public.erp_reporting_snapshot_with_history(p_from date,p_to date,p_location uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare result jsonb;pnl jsonb;days jsonb;weeks jsonb;tops jsonb;lows jsonb;history jsonb;tot record;begin
 result:=public.erp_reporting_snapshot_v2(p_from,p_to,p_location); -- date validation + manager check
 select coalesce(sum(quantity*unit_price),0) gross,coalesce(sum(discount),0) discounts,
  coalesce(sum(tax),0) tax,coalesce(sum(quantity*unit_cost),0) cogs,
  coalesce(sum(quantity),0) units,count(distinct sale_date) days
 into tot from public.erp_history_menu(p_from,p_to,p_location);
 pnl:=result->'pnl';
 pnl:=pnl||jsonb_build_object('gross',(pnl->>'gross')::numeric+tot.gross,
  'discounts',(pnl->>'discounts')::numeric+tot.discounts,'tax',(pnl->>'tax')::numeric+tot.tax,'cogs',(pnl->>'cogs')::numeric+tot.cogs);
 with sample as(select sale_date,sum(quantity*unit_price) gross,sum(discount) discount,sum(tax) tax,sum(quantity*unit_price-discount) net from public.erp_history_menu(p_from,p_to,p_location) group by sale_date)
 select coalesce(jsonb_agg(d.value||jsonb_build_object('net',(d.value->>'net')::numeric+coalesce(s.net,0),'gross',(d.value->>'gross')::numeric+coalesce(s.gross,0),'discount',(d.value->>'discount')::numeric+coalesce(s.discount,0),'tax',(d.value->>'tax')::numeric+coalesce(s.tax,0)) order by d.value->>'day'),'[]'::jsonb)
 into days from jsonb_array_elements(result->'daily')d(value) left join sample s on s.sale_date=(d.value->>'day')::date;
 select coalesce(jsonb_agg(to_jsonb(w) order by w.week),'[]'::jsonb) into weeks from(
  select date_trunc('week',(d->>'day')::date)::date AS week,sum((d->>'net')::numeric) net from jsonb_array_elements(days)d group by 1)w;
 -- Recompute full rankings rather than merging only the original top 20.
 with units as(
  select sl.item_sku,sl.quantity units from public.sale_lines sl join public.sales s on s.id=sl.sale_id
   where s.status='Completed' and s.created_at>=p_from::timestamp at time zone 'America/Denver'
   and s.created_at<least((p_to+1)::timestamp at time zone 'America/Denver',now()) and (p_location is null or s.location_id=p_location)
  union all select sl.item_sku,-sl.quantity from public.sales_return_lines sl join public.sales_returns r on r.id=sl.return_id
   join public.sales s on s.id=r.original_sale_id where r.created_at>=p_from::timestamp at time zone 'America/Denver'
   and r.created_at<least((p_to+1)::timestamp at time zone 'America/Denver',now()) and (p_location is null or s.location_id=p_location)
  union all select item_sku,quantity from public.erp_history_menu(p_from,p_to,p_location)
 ) select coalesce(jsonb_agg(to_jsonb(t) order by t.units desc,t.name),'[]'::jsonb) into tops from(
  select u.item_sku,i.name,sum(u.units) units from units u join public.items i on i.sku=u.item_sku group by u.item_sku,i.name
  having sum(u.units)<>0 order by units desc,i.name limit 20)t;
 -- Recommendations use the same 180-day usage basis as the purchasing screen.
 with usage as(select * from public.erp_history_usage(p_to-179,p_to,p_location)),
 candidates as(select v.value||jsonb_build_object('supplier',s.name,'supplier_active',s.erp_active,
  'lead',greatest(coalesce(s.quoted_lead_days,i.lead_days),0),'daily_usage',coalesce(u.daily,0),
  'on_order',coalesce(o.qty,0),'safety',opt.safety_days,'review',opt.review_days,
  'conversion_factor',i.conversion_factor,'purchase_unit',i.purchase_unit,'shelf_life_days',i.shelf_life_days,'openOrders',coalesce(o.orders,'[]'::jsonb)) payload
  from jsonb_array_elements(result->'inventory')v(value) join public.items i on i.sku=v.value->>'item_sku'
  left join public.suppliers s on s.id=i.supplier_id cross join public.erp_purchasing_options opt
  left join usage u on u.item_sku=i.sku and u.location_id=(v.value->>'location_id')::uuid
  left join lateral(select sum(greatest(pl.quantity_purchase-pl.quantity_received_purchase,0)*i.conversion_factor) qty,
   jsonb_agg(jsonb_build_object('id',po.id,'po_no',po.po_no,'expected_on',(po.expected_at at time zone 'America/Denver')::date,
    'remaining_base',greatest(pl.quantity_purchase-pl.quantity_received_purchase,0)*i.conversion_factor) order by po.expected_at) orders
   from public.purchase_order_lines pl join public.purchase_orders po on po.id=pl.purchase_order_id
   where pl.item_sku=i.sku and po.ship_to_location_id=(v.value->>'location_id')::uuid and po.status in('Order Sent','Partially Received')
    and po.ordered_at<least((p_to+1)::timestamp at time zone 'America/Denver',now())
    and pl.quantity_purchase>pl.quantity_received_purchase)o on true
  where i.active and not exists(select 1 from public.bom_lines b where b.parent_sku=i.sku)
 ) select coalesce(jsonb_agg(payload order by payload->>'location_name',payload->>'name'),'[]'::jsonb) into lows from candidates
 where (payload->>'quantity')::numeric<=0 or (payload->>'quantity')::numeric<(payload->>'daily_usage')::numeric*((payload->>'lead')::numeric+(payload->>'safety')::numeric);
 select jsonb_build_object('from',from_date,'to',to_date,'method',method,'includedDays',tot.days,'includedUnits',tot.units) into history
 from public.erp_sample_history_batches where id='menu-history-v1';
 return result||jsonb_build_object('pnl',pnl,'daily',days,'weekly',weeks,'topItems',tops,'lowStock',lows,'sampleHistory',history);
end $$;

revoke all on function public.erp_history_menu(date,date,uuid),public.erp_history_usage(date,date,uuid) from public,anon,authenticated;
revoke all on function public.erp_purchasing_snapshot_with_history(),public.erp_reporting_snapshot_with_history(date,date,uuid) from public,anon,authenticated;
grant execute on function public.erp_purchasing_snapshot_with_history(),public.erp_reporting_snapshot_with_history(date,date,uuid) to authenticated;
commit;

-- Installation summary (read only).
select b.from_date,b.to_date,count(*) as simulated_item_days,sum(h.quantity) as simulated_menu_units,
 'AI-generated course data; real sales and current inventory unchanged' as source
from public.erp_sample_history_batches b join public.erp_sample_menu_history h on h.batch_id=b.id
group by b.id,b.from_date,b.to_date;
