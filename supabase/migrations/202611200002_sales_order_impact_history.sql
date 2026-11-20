begin;

-- Retain order-state milestones for future detail history. Existing order creation
-- timestamps are backfilled; unavailable historical status-change times are not guessed.
create table if not exists public.erp_sales_order_events (
 id uuid primary key default pg_catalog.gen_random_uuid(),
 order_id uuid not null references public.sales_orders(id) on delete cascade,
 event_type text not null check (event_type in ('Order Placed','Prepared','Fulfilled','Closed','Cancelled')),
 occurred_at timestamptz not null,
 actor_id uuid references auth.users(id),
 metadata jsonb not null default '{}'::jsonb
);
alter table public.erp_sales_order_events enable row level security;
revoke all on public.erp_sales_order_events from public, anon, authenticated;
create index if not exists erp_sales_order_events_order_time_idx
 on public.erp_sales_order_events(order_id, occurred_at, id);

insert into public.erp_sales_order_events(order_id,event_type,occurred_at,actor_id,metadata)
select o.id,'Order Placed',o.created_at,o.created_by,jsonb_build_object('source','migration backfill')
from public.sales_orders o
where not exists (
 select 1 from public.erp_sales_order_events e
 where e.order_id=o.id and e.event_type='Order Placed'
);

create or replace function public.erp_record_sales_order_event()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if tg_op='INSERT' then
  insert into public.erp_sales_order_events(order_id,event_type,occurred_at,actor_id,metadata)
  values(new.id,'Order Placed',new.created_at,new.created_by,jsonb_build_object('source','order created'));
  return new;
 end if;
 if old.erp_prepared_at is null and new.erp_prepared_at is not null then
  insert into public.erp_sales_order_events(order_id,event_type,occurred_at,actor_id,metadata)
  values(new.id,'Prepared',new.erp_prepared_at,auth.uid(),jsonb_build_object('sale_id',new.erp_sale_id));
 end if;
 if old.status is distinct from new.status then
  insert into public.erp_sales_order_events(order_id,event_type,occurred_at,actor_id,metadata)
  values(new.id,new.status,pg_catalog.clock_timestamp(),auth.uid(),jsonb_build_object('sale_id',new.erp_sale_id));
 end if;
 return new;
end
$$;
revoke all on function public.erp_record_sales_order_event() from public,anon,authenticated;
drop trigger if exists erp_sales_order_event_history on public.sales_orders;
create trigger erp_sales_order_event_history
after insert or update on public.sales_orders
for each row execute function public.erp_record_sales_order_event();

create or replace function public.erp_sales_order_impact(p_order uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare o public.sales_orders%rowtype; result jsonb;
begin
 if auth.uid() is null or coalesce(public.current_role(),'') not in ('Manager','Cashier') then
  raise exception 'Staff role required' using errcode='42501';
 end if;
 if p_order is null then raise exception 'Order is required'; end if;
 select * into o from public.sales_orders where id=p_order;
 if not found then raise exception 'Sales order not found'; end if;

 select jsonb_build_object(
  'order',jsonb_build_object(
   'id',o.id,'order_no',o.erp_order_number,'customer',coalesce(nullif(o.erp_name,''),'Pickup customer'),
   'phone',o.erp_phone,'location_name',(select l.name from public.locations l where l.id=o.location_id),
   'pickup_at',o.pickup_at,'status',o.status,'created_at',o.created_at,
   'prepared_at',o.erp_prepared_at,'sale_id',o.erp_sale_id,'simulated_paid',o.erp_simulated_paid
  ),
  'sales',coalesce((
   select jsonb_agg(jsonb_build_object(
    'id',s.id,'kind',case when s.id=o.erp_sale_id then 'Order sale' else 'Exchange replacement sale' end,
    'receipt_no',s.receipt_no,'status',s.status,'created_at',s.created_at,
    'subtotal',s.subtotal,'discount',s.discount,'tax',s.tax,'total',s.total,'cogs',s.cogs,
    'payment_method',s.payment_method,
    'lines',coalesce((select jsonb_agg(jsonb_build_object(
      'sku',sl.item_sku,'name',i.name,'quantity',sl.quantity,'unit_price',sl.unit_price,'unit_cost',sl.unit_cost
     ) order by sl.id) from public.sale_lines sl join public.items i on i.sku=sl.item_sku where sl.sale_id=s.id),'[]'::jsonb)
   ) order by s.created_at,s.id)
   from public.sales s
   where s.id=o.erp_sale_id or exists(
    select 1 from public.sales_returns r where r.original_sale_id=o.erp_sale_id and r.replacement_sale_id=s.id
   )
  ),'[]'::jsonb),
  'returns',coalesce((
   select jsonb_agg(jsonb_build_object(
    'id',r.id,'transaction_type',r.transaction_type,'created_at',r.created_at,
    'refund_subtotal',r.refund_subtotal,'refund_tax',r.refund_tax,'refund_total',r.refund_total,
    'replacement_total',r.replacement_total,'settlement_net',r.settlement_net,'settlement_mode',r.settlement_mode,
    'lines',coalesce((select jsonb_agg(jsonb_build_object(
      'sku',rl.item_sku,'name',i.name,'quantity',rl.quantity,'disposition',rl.disposition,
      'reason_code',rl.reason_code,'refund_total',rl.refund_total,'cost_amount',rl.cost_amount
     ) order by rl.id) from public.sales_return_lines rl join public.items i on i.sku=rl.item_sku where rl.return_id=r.id),'[]'::jsonb)
   ) order by r.created_at,r.id)
   from public.sales_returns r where r.original_sale_id=o.erp_sale_id
  ),'[]'::jsonb),
  'inventory',coalesce((
   select jsonb_agg(jsonb_build_object(
    'id',t.id,'sku',t.item_sku,'name',i.name,'unit',i.base_unit,'quantity',t.quantity,
    'unit_cost',t.unit_cost,'transaction_type',t.transaction_type,'reason_code',t.reason_code,
    'reference_document',t.reference_document,'occurred_at',t.occurred_at
   ) order by t.occurred_at,t.id)
   from public.inventory_transactions t join public.items i on i.sku=t.item_sku
   where
    exists(select 1 from public.sales s where (s.id=o.erp_sale_id or exists(
      select 1 from public.sales_returns r where r.original_sale_id=o.erp_sale_id and r.replacement_sale_id=s.id
     )) and t.reference_document=s.receipt_no)
    or t.metadata->>'sales_order_id'=o.id::text
    or exists(select 1 from public.sales_returns r where r.original_sale_id=o.erp_sale_id and t.reference_document='RETURN-'||r.id::text)
  ),'[]'::jsonb),
  'events',coalesce((
   select jsonb_agg(jsonb_build_object('event_type',e.event_type,'occurred_at',e.occurred_at) order by e.occurred_at,e.id)
   from public.erp_sales_order_events e where e.order_id=o.id
  ),'[]'::jsonb)
 ) into result;
 return result;
end
$$;
revoke all on function public.erp_sales_order_impact(uuid) from public,anon;
grant execute on function public.erp_sales_order_impact(uuid) to authenticated;

commit;
