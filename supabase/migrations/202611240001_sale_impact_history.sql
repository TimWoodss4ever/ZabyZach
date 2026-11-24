-- "View impact" for counter (POS) sales: the same history the existing
-- erp_sales_order_impact gives pickup/delivery orders (sale, returns, exchange
-- replacements, inventory postings), looked up by sale id. Read-only. Safe to re-run.
begin;

create or replace function public.erp_sale_impact(p_sale uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare s public.sales%rowtype; result jsonb;
begin
 if auth.uid() is null or coalesce(public.current_role(),'') not in ('Manager','Cashier') then
  raise exception 'Staff role required' using errcode='42501';
 end if;
 if p_sale is null then raise exception 'Sale is required'; end if;
 select * into s from public.sales where id=p_sale;
 if not found then raise exception 'Sale not found'; end if;

 select jsonb_build_object(
  'order',jsonb_build_object(
   'id',s.id,
   'order_no',coalesce(nullif(regexp_replace(s.receipt_no,'[^0-9]','','g'),'')::bigint,0),
   'customer',coalesce(nullif(s.pickup_name,''),(select c.name from public.customers c where c.id=s.customer_id),'Walk-in customer'),
   'phone',(select c.phone from public.customers c where c.id=s.customer_id),
   'location_name',(select l.name from public.locations l where l.id=s.location_id),
   'pickup_at',s.created_at,'status','Completed','created_at',s.created_at,'prepared_at',s.created_at,
   'sale_id',s.id,'simulated_paid',true,'erp_fulfillment_type','counter'),
  'sales',coalesce((
   select jsonb_agg(jsonb_build_object(
    'id',x.id,'kind',case when x.id=s.id then 'Counter sale' else 'Exchange replacement sale' end,
    'receipt_no',x.receipt_no,'status',x.status,'created_at',x.created_at,
    'subtotal',x.subtotal,'discount',x.discount,'tax',x.tax,'total',x.total,'cogs',x.cogs,
    'payment_method',x.payment_method,
    'lines',coalesce((select jsonb_agg(jsonb_build_object(
      'sku',sl.item_sku,'name',i.name,'quantity',sl.quantity,'unit_price',sl.unit_price,'unit_cost',sl.unit_cost
     ) order by sl.id) from public.sale_lines sl join public.items i on i.sku=sl.item_sku where sl.sale_id=x.id),'[]'::jsonb)
   ) order by x.created_at,x.id)
   from public.sales x
   where x.id=s.id or exists(select 1 from public.sales_returns r where r.original_sale_id=s.id and r.replacement_sale_id=x.id)
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
   from public.sales_returns r where r.original_sale_id=s.id
  ),'[]'::jsonb),
  'inventory',coalesce((
   select jsonb_agg(jsonb_build_object(
    'id',t.id,'sku',t.item_sku,'name',i.name,'unit',i.base_unit,'quantity',t.quantity,
    'unit_cost',t.unit_cost,'transaction_type',t.transaction_type,'reason_code',t.reason_code,
    'reference_document',t.reference_document,'occurred_at',t.occurred_at
   ) order by t.occurred_at,t.id)
   from public.inventory_transactions t join public.items i on i.sku=t.item_sku
   where exists(select 1 from public.sales x where (x.id=s.id or exists(
      select 1 from public.sales_returns r where r.original_sale_id=s.id and r.replacement_sale_id=x.id
     )) and t.reference_document=x.receipt_no)
    or exists(select 1 from public.sales_returns r where r.original_sale_id=s.id and t.reference_document='RETURN-'||r.id::text)
  ),'[]'::jsonb),
  'events',jsonb_build_array(jsonb_build_object('event_type','Completed','occurred_at',s.created_at))
 ) into result;
 return result;
end
$$;
revoke all on function public.erp_sale_impact(uuid) from public,anon;
grant execute on function public.erp_sale_impact(uuid) to authenticated;

commit;
