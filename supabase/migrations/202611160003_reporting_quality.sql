-- Requirements 9/10 only. New read-only reporting RPC; existing RPCs and
-- business records (including historical costs/dates) are left unchanged.
begin;
create or replace function public.erp_reporting_snapshot_v2(p_from date,p_to date,p_location uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare base jsonb; start_at timestamptz; end_at timestamptz; supplier_rows jsonb;
 cost_rows jsonb; stock_rows jsonb; low_rows jsonb;
begin
 if auth.uid() is null or public.current_role() is distinct from 'Manager' then
  raise exception 'Manager role required' using errcode='42501';
 end if;
 -- The existing report validates dates/location and supplies unchanged totals.
 base:=public.erp_reporting_snapshot(p_from,p_to,p_location);
 if (base->>'version')::integer is distinct from 1 then raise exception 'The original reporting contract changed; review reporting v2 compatibility'; end if;
 start_at:=p_from::timestamp at time zone 'America/Denver';
 end_at:=least((p_to+1)::timestamp at time zone 'America/Denver',now());

 -- Aggregate ALL deliveries first. Only then apply the report date range.
 -- Closing/settling a received order must not remove its delivery performance.
 with completed as (
  select po.id,po.supplier_id,po.ordered_at,po.erp_quoted_lead_days,
   coalesce(po.erp_quoted_lead_days,s.quoted_lead_days) as quoted,
   case when count(r.id)>0 then greatest(max(r.received_on),(po.erp_legacy_received_at at time zone 'America/Denver')::date)
    else (coalesce(po.erp_legacy_received_at,po.received_at) at time zone 'America/Denver')::date end as delivered_on
  from public.purchase_orders po join public.suppliers s on s.id=po.supplier_id
  left join public.erp_purchase_receipts r on r.purchase_order_id=po.id
  where po.status in ('Received','Closed') and (p_location is null or po.ship_to_location_id=p_location)
  group by po.id,s.quoted_lead_days
 ), deliveries as (
  select c.*,c.delivered_on-(c.ordered_at at time zone 'America/Denver')::date as actual
  from completed c where c.delivered_on between p_from and p_to
 )
 select coalesce(jsonb_agg(to_jsonb(x) order by x.name),'[]'::jsonb) into supplier_rows from (
  select s.id,s.name,count(d.id) as deliveries,avg(d.actual) as actual,avg(d.quoted) as quoted,
   count(d.id) filter(where d.actual>d.quoted) as late,
   count(d.id) filter(where d.erp_quoted_lead_days is null) as legacy_quote_orders
  from public.suppliers s left join deliveries d on d.supplier_id=s.id and d.actual>=0 group by s.id
 ) x;

 -- Include sales and originals of returns that affect this period/location.
 -- These diagnostics never substitute a current cost for a posted cost.
 with candidates as (
  select s.*,l.name as location_name from public.sales s join public.locations l on l.id=s.location_id
  where s.status='Completed' and (p_location is null or s.location_id=p_location) and (
   (s.created_at>=start_at and s.created_at<end_at) or exists(
    select 1 from public.sales_returns r where r.original_sale_id=s.id and r.created_at>=start_at and r.created_at<end_at))
 ), checked as (
  select s.*,a.line_count,a.zero_lines,a.posted_lines,a.lines,
   array_remove(array[
    case when s.subtotal>0 and s.cogs=0 then 'Sale header has zero recorded COGS' end,
    case when a.zero_lines>0 then 'One or more sale lines have zero recorded unit cost' end,
    case when abs(s.cogs-a.posted_lines)>=0.005 then 'Header and line costs differ by at least half a cent' end,
    case when a.line_count=0 then 'Sale has no recorded lines' end
   ],null) as reasons
  from candidates s cross join lateral (
   select count(*) as line_count,count(*) filter(where sl.unit_cost=0) as zero_lines,
    coalesce(sum(sl.quantity*sl.unit_cost),0) as posted_lines,
    coalesce(jsonb_agg(jsonb_build_object('id',sl.id,'sku',sl.item_sku,'name',i.name,
     'quantity',sl.quantity,'unit_price',sl.unit_price,'unit_cost',sl.unit_cost) order by sl.id),'[]'::jsonb) as lines
   from public.sale_lines sl join public.items i on i.sku=sl.item_sku where sl.sale_id=s.id
  ) a
 )
 select coalesce(jsonb_agg(jsonb_build_object(
  'sale_id',s.id,'receipt_no',s.receipt_no,'created_at',s.created_at,'location_name',s.location_name,
  'header_cogs',s.cogs,'line_cogs',s.posted_lines,'zero_cost_lines',s.zero_lines,'reasons',to_jsonb(s.reasons),'lines',s.lines,
  'returns',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'created_at',r.created_at,
   'refund_subtotal',r.refund_subtotal,'restock_cost',coalesce((select sum(rl.cost_amount) from public.sales_return_lines rl where rl.return_id=r.id and rl.disposition='Restock'),0)) order by r.created_at,r.id)
   from public.sales_returns r where r.original_sale_id=s.id and r.created_at<end_at),'[]'::jsonb)
 ) order by s.created_at desc,s.id),'[]'::jsonb) into cost_rows from checked s where cardinality(s.reasons)>0;

 -- Match the existing warning basis and expose its recorded evidence. Cost is
 -- pooled across locations, so show source locations even with a store filter.
 with flagged as (
  select distinct v->>'item_sku' as sku from jsonb_array_elements(base->'inventory') v where (v->>'negative_history')::boolean
 ), ledger as materialized (
  select t.*,sum(t.quantity) over(partition by t.item_sku,t.location_id order by t.occurred_at,t.id rows unbounded preceding) as balance
  from public.inventory_transactions t join flagged f on f.sku=t.item_sku where t.occurred_at<end_at
 ), batches as (
  select item_sku,location_id,occurred_at,sum(quantity) as quantity_change from ledger group by item_sku,location_id,occurred_at
 ), batch_balances as (
  select b.*,sum(b.quantity_change) over(partition by b.item_sku,b.location_id order by b.occurred_at rows unbounded preceding) as balance from batches b
 ), summary as (
  select item_sku,location_id,min(balance) as lowest_balance,
   min(occurred_at) filter(where balance<0) as first_negative_at,
   max(occurred_at) filter(where balance<0) as last_negative_at,sum(quantity) as closing_quantity
  from ledger group by item_sku,location_id having min(balance)<0
 ), first_entry as (
  select distinct on(item_sku,location_id) item_sku,location_id,id,quantity,unit_cost,transaction_type,reference_document,occurred_at
  from ledger where balance<0 order by item_sku,location_id,occurred_at,id
 )
 select coalesce(jsonb_agg(jsonb_build_object(
  'sku',s.item_sku,'name',i.name,'location_name',l.name,'base_unit',i.base_unit,
  'first_negative_at',s.first_negative_at,'last_negative_at',s.last_negative_at,'lowest_balance',s.lowest_balance,'closing_quantity',s.closing_quantity,
  'transaction_id',f.id,'transaction_type',f.transaction_type,'reference_document',f.reference_document,
  'transaction_quantity',f.quantity,'posted_unit_cost',f.unit_cost,
  'timestamp_batch_negative',exists(select 1 from batch_balances b where b.item_sku=s.item_sku and b.location_id=s.location_id and b.balance<0)
 ) order by s.first_negative_at,s.item_sku,l.name),'[]'::jsonb) into stock_rows
 from summary s join first_entry f on f.item_sku=s.item_sku and f.location_id=s.location_id
 join public.items i on i.sku=s.item_sku join public.locations l on l.id=s.location_id;

 -- Outstanding deliveries are context for the recommendation, not new orders.
 select coalesce(jsonb_agg(r.value||jsonb_build_object('openOrders',coalesce((
  select jsonb_agg(jsonb_build_object('id',po.id,'po_no',po.po_no,
   'expected_on',(po.expected_at at time zone 'America/Denver')::date,
   'remaining_base',greatest(pl.quantity_purchase-pl.quantity_received_purchase,0)*i.conversion_factor)
   order by po.expected_at,po.id,pl.id)
  from public.purchase_orders po join public.purchase_order_lines pl on pl.purchase_order_id=po.id
  join public.items i on i.sku=pl.item_sku
  where po.status in ('Order Sent','Partially Received') and po.ordered_at<end_at
   and po.ship_to_location_id=(r.value->>'location_id')::uuid and pl.item_sku=r.value->>'item_sku'
   and pl.quantity_purchase>pl.quantity_received_purchase
 ),'[]'::jsonb)) order by r.ordinality),'[]'::jsonb) into low_rows
 from jsonb_array_elements(base->'lowStock') with ordinality r(value,ordinality);

 return base||jsonb_build_object('version',2,'suppliers',supplier_rows,'lowStock',low_rows,
  'quality',jsonb_build_object('costSales',cost_rows,'stockHistory',stock_rows));
end $$;
revoke all on function public.erp_reporting_snapshot_v2(date,date,uuid) from public,anon,authenticated;
grant execute on function public.erp_reporting_snapshot_v2(date,date,uuid) to authenticated;
commit;
