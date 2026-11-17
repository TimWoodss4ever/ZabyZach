-- Add targeted read indexes and server-side inventory usage aggregates.
begin;

create index if not exists inventory_transactions_recent_usage_idx
 on public.inventory_transactions(occurred_at)
 include(item_sku,location_id,quantity)
 where quantity<0 and lower(transaction_type) in ('sale','production','production issue','backorder fulfillment');

create index if not exists sales_completed_store_day_idx
 on public.sales(created_at) include(location_id)
 where status='Completed';

drop function if exists public.erp_inventory_recorded_usage();
create or replace function public.erp_inventory_recorded_usage(p_since timestamptz)
returns table(item_sku text,location_id uuid,quantity numeric,transaction_type text)
language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin
 perform public.require_staff();
 if p_since is null then raise exception 'Usage start time is required.';end if;
 return query
 select t.item_sku,t.location_id,sum(t.quantity)::numeric,'Sale'::text
 from public.inventory_transactions t
 where t.occurred_at>=p_since and t.quantity<0
  and lower(t.transaction_type) in ('sale','production','production issue','backorder fulfillment')
 group by t.item_sku,t.location_id;
end $$;
revoke all on function public.erp_inventory_recorded_usage(timestamptz) from public,anon,authenticated;
grant execute on function public.erp_inventory_recorded_usage(timestamptz) to authenticated;

create or replace function public.erp_inventory_sample_usage()
returns table(item_sku text,location_id uuid,quantity numeric,transaction_type text)
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare today date:=(now() at time zone 'America/Denver')::date;begin
 perform public.require_staff();
 return query
 with actual_days as materialized (
  select s.location_id,(s.created_at at time zone 'America/Denver')::date as trading_date
  from public.sales s
  where s.status='Completed'
   and s.created_at>=(today-179)::timestamp at time zone 'America/Denver'
   and s.created_at<(today+1)::timestamp at time zone 'America/Denver'
  union
  select t.location_id,(t.occurred_at at time zone 'America/Denver')::date
  from public.inventory_transactions t
  where t.quantity<0 and lower(t.transaction_type) in ('sale','production','production issue','backorder fulfillment')
   and t.occurred_at>=(today-179)::timestamp at time zone 'America/Denver'
   and t.occurred_at<(today+1)::timestamp at time zone 'America/Denver'
 )
 select h.item_sku,h.location_id,-sum(h.quantity),'Sale'::text
 from public.erp_sample_material_history h
 where h.usage_date between today-179 and today
  and not exists(select 1 from actual_days d where d.location_id=h.location_id and d.trading_date=h.usage_date)
 group by h.item_sku,h.location_id;
end $$;
revoke all on function public.erp_inventory_sample_usage() from public,anon,authenticated;
grant execute on function public.erp_inventory_sample_usage() to authenticated;

commit;
