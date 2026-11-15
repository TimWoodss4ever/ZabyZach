-- Returns and exchanges are accounting records only. No payment is processed.

-- Exchanges call record_sale to create the replacement sale. Put its trusted
-- application schema ahead of pg_temp to prevent temporary-object shadowing.
alter function public.record_sale(uuid, jsonb, numeric, uuid)
  set search_path to pg_catalog, public, pg_temp;

-- Enforce that a returned line belongs to the sale recorded on its return.
alter table public.sale_lines
  add constraint sale_lines_id_sale_id_unique unique (id, sale_id);

create table public.sales_returns (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  request_id uuid not null unique,
  request_payload jsonb not null,
  result jsonb,
  transaction_type text not null
    check (transaction_type in ('Return', 'Exchange')),
  original_sale_id uuid not null references public.sales(id),
  replacement_sale_id uuid unique references public.sales(id),
  refund_subtotal numeric not null check (refund_subtotal >= 0),
  refund_tax numeric not null check (refund_tax >= 0),
  refund_total numeric not null check (refund_total >= 0),
  replacement_total numeric not null default 0
    check (replacement_total >= 0),
  settlement_net numeric not null,
  settlement_mode text not null default 'Manual/Simulated'
    check (settlement_mode = 'Manual/Simulated'),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default pg_catalog.now(),
  check (
    (transaction_type = 'Return'
      and replacement_sale_id is null
      and replacement_total = 0
      and settlement_net = -refund_total)
    or
    (transaction_type = 'Exchange'
      and replacement_sale_id is not null
      and settlement_net = replacement_total - refund_total)
  )
);

create table public.sales_return_lines (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  return_id uuid not null references public.sales_returns(id),
  original_sale_id uuid not null,
  original_sale_line_id uuid not null,
  item_sku text not null references public.items(sku),
  quantity numeric not null check (quantity > 0),
  reason_code text not null,
  disposition text not null check (disposition in ('Restock', 'Waste')),
  refund_subtotal numeric not null check (refund_subtotal >= 0),
  refund_tax numeric not null check (refund_tax >= 0),
  refund_total numeric not null check (refund_total >= 0),
  original_unit_cost numeric not null check (original_unit_cost >= 0),
  cost_amount numeric not null check (cost_amount >= 0),
  created_at timestamptz not null default pg_catalog.now(),
  foreign key (original_sale_line_id, original_sale_id)
    references public.sale_lines(id, sale_id),
  unique (return_id, original_sale_line_id)
);

create index sales_return_lines_original_sale_line
  on public.sales_return_lines(original_sale_line_id);

alter table public.sales_returns enable row level security;
alter table public.sales_return_lines enable row level security;

-- Browser roles can read return history, but only the RPCs below can write it.
revoke all on table public.sales_returns
  from public, anon, authenticated;
revoke all on table public.sales_return_lines
  from public, anon, authenticated;
grant select on table public.sales_returns to authenticated;
grant select on table public.sales_return_lines to authenticated;

create policy "staff read returns"
  on public.sales_returns
  for select to authenticated
  using (coalesce(public.current_role() in ('Manager', 'Cashier'), false));

create policy "staff read return lines"
  on public.sales_return_lines
  for select to authenticated
  using (coalesce(public.current_role() in ('Manager', 'Cashier'), false));

-- Internal implementation: inaccessible to browser roles. The public RPCs
-- authorize staff before calling it.
create function public._apply_return_exchange(
  p_kind text,
  p_request_id uuid,
  p_sale_line_id uuid,
  p_quantity numeric,
  p_reason_code text,
  p_disposition text,
  p_replacement_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payload jsonb;
  v_prior public.sales_returns%rowtype;
  v_sale_id uuid;
  v_sale_status text;
  v_customer_id uuid;
  v_location_id uuid;
  v_sale_subtotal numeric;
  v_sale_discount numeric;
  v_sale_tax numeric;
  v_line_sku text;
  v_line_quantity numeric;
  v_unit_price numeric;
  v_unit_cost numeric;
  v_already_returned numeric;
  v_return_subtotal numeric;
  v_return_tax numeric;
  v_return_total numeric;
  v_cost_amount numeric;
  v_replacement_sale_id uuid;
  v_replacement_total numeric := 0;
  v_settlement_net numeric;
  v_return_id uuid;
  v_result jsonb;
  v_replacement_line jsonb;
  v_replacement_qty numeric;
begin
  perform public.require_staff();

  if p_kind is null or p_kind not in ('Return', 'Exchange') then
    raise exception 'Unsupported return transaction type';
  end if;
  if p_request_id is null or p_sale_line_id is null then
    raise exception 'Request ID and original sale line are required';
  end if;
  if p_quantity is null
     or p_quantity::text in ('NaN', 'Infinity', '-Infinity')
     or p_quantity <= 0 then
    raise exception 'Return quantity must be positive';
  end if;
  if p_disposition is null
     or p_disposition not in ('Restock', 'Waste') then
    raise exception 'Disposition must be Restock or Waste';
  end if;
  if coalesce(pg_catalog.btrim(p_reason_code), '') = '' then
    raise exception 'Return reason is required';
  end if;

  if p_kind = 'Exchange' then
    if p_replacement_lines is null
       or pg_catalog.jsonb_typeof(p_replacement_lines) is distinct from 'array'
       or pg_catalog.jsonb_array_length(p_replacement_lines) = 0 then
      raise exception 'Exchange requires at least one replacement item';
    end if;

    -- Match record_sale's line format exactly: each object has only sku and
    -- qty; SKU is a string and qty is a positive JSON number.
    for v_replacement_line in
      select e.value
        from pg_catalog.jsonb_array_elements(p_replacement_lines) as e(value)
    loop
      if pg_catalog.jsonb_typeof(v_replacement_line)
           is distinct from 'object' then
        raise exception 'Each replacement line must be an object';
      end if;
      if pg_catalog.jsonb_object_length(v_replacement_line) <> 2
         or not (v_replacement_line ? 'sku')
         or not (v_replacement_line ? 'qty')
         or pg_catalog.jsonb_typeof(v_replacement_line -> 'sku')
              is distinct from 'string'
         or pg_catalog.jsonb_typeof(v_replacement_line -> 'qty')
              is distinct from 'number'
         or coalesce(pg_catalog.btrim(v_replacement_line ->> 'sku'), '') = '' then
        raise exception 'Replacement lines must contain only a non-empty sku and numeric qty';
      end if;

      v_replacement_qty := (v_replacement_line ->> 'qty')::numeric;
      if v_replacement_qty::text in ('NaN', 'Infinity', '-Infinity')
         or v_replacement_qty <= 0 then
        raise exception 'Replacement quantities must be positive';
      end if;
    end loop;
  elsif p_replacement_lines is not null then
    raise exception 'A return cannot include replacement items';
  end if;

  v_payload := pg_catalog.jsonb_build_object(
    'kind', p_kind,
    'sale_line_id', p_sale_line_id,
    'quantity', p_quantity,
    'reason_code', p_reason_code,
    'disposition', p_disposition,
    'replacement_lines', p_replacement_lines
  );

  -- Serialize retries using the same request ID, even if they target
  -- different sale lines.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_request_id::text, 0)
  );

  select *
    into v_prior
    from public.sales_returns
   where request_id = p_request_id;

  if found then
    if v_prior.request_payload is distinct from v_payload then
      raise exception 'Request ID was already used with different return details';
    end if;
    if v_prior.result is null then
      raise exception 'Prior return request has no completed result';
    end if;
    return v_prior.result;
  end if;

  -- Lock both sale and line. The sale lock serializes all return attempts
  -- against that sale before checking cumulative returned quantity.
  select s.id, s.status, s.customer_id, s.location_id,
         s.subtotal, s.discount, s.tax,
         sl.item_sku, sl.quantity, sl.unit_price, sl.unit_cost
    into v_sale_id, v_sale_status, v_customer_id, v_location_id,
         v_sale_subtotal, v_sale_discount, v_sale_tax,
         v_line_sku, v_line_quantity, v_unit_price, v_unit_cost
    from public.sales s
    join public.sale_lines sl on sl.sale_id = s.id
   where sl.id = p_sale_line_id
   for update of s, sl;

  if not found then
    raise exception 'Original sale line was not found';
  end if;
  if v_sale_status is distinct from 'Completed' then
    raise exception 'Only completed sales can be returned or exchanged';
  end if;

  if not exists (
    select 1
      from public.settings st
     where st.setting_key = 'return_reason_codes'
       and st.value @> pg_catalog.jsonb_build_array(p_reason_code)
  ) then
    raise exception 'Unknown return reason code';
  end if;

  if p_disposition = 'Restock'
     and (
       not exists (
         select 1
           from public.items i
          where i.sku = v_line_sku
            and (i.category = 'Beverage' or i.sku = '1017')
       )
       or exists (
         select 1
           from public.bom_lines b
          where b.parent_sku = v_line_sku
       )
     ) then
    raise exception 'Only direct-stock beverages and ranch cups can be restocked';
  end if;

  select coalesce(pg_catalog.sum(rl.quantity), 0)
    into v_already_returned
    from public.sales_return_lines rl
   where rl.original_sale_line_id = p_sale_line_id;

  if p_quantity > v_line_quantity - v_already_returned then
    raise exception 'Return quantity exceeds the remaining eligible quantity';
  end if;

  -- sales.discount is a dollar amount. Allocate it by the returned line's
  -- share of sale subtotal, then allocate stored tax over discounted sales.
  if v_sale_subtotal > 0 then
    v_return_subtotal :=
      (p_quantity * v_unit_price)
      - ((p_quantity * v_unit_price * v_sale_discount) / v_sale_subtotal);
  else
    v_return_subtotal := p_quantity * v_unit_price;
  end if;

  if v_sale_subtotal - v_sale_discount > 0 then
    v_return_tax :=
      (v_return_subtotal * v_sale_tax)
      / (v_sale_subtotal - v_sale_discount);
  else
    v_return_tax := 0;
  end if;

  if v_return_subtotal < 0 or v_return_tax < 0 then
    raise exception 'Original sale amounts cannot be allocated safely';
  end if;

  v_return_total := v_return_subtotal + v_return_tax;
  v_cost_amount := p_quantity * v_unit_cost;
  v_return_id := pg_catalog.gen_random_uuid();

  if p_kind = 'Exchange' then
    -- record_sale checks replacement item activity, prices, stock, and
    -- atomically posts the replacement sale and its inventory consumption.
    v_result := public.record_sale(
      v_location_id, p_replacement_lines, 0, v_customer_id
    );
    v_replacement_sale_id := (v_result ->> 'sale_id')::uuid;
    v_replacement_total := (v_result ->> 'total')::numeric;
  end if;

  -- Positive means amount due; negative means customer credit. This is a
  -- manual/simulated accounting record, not a payment-provider operation.
  v_settlement_net := v_replacement_total - v_return_total;

  insert into public.sales_returns (
    id, request_id, request_payload, transaction_type,
    original_sale_id, replacement_sale_id,
    refund_subtotal, refund_tax, refund_total,
    replacement_total, settlement_net, created_by
  )
  values (
    v_return_id, p_request_id, v_payload, p_kind,
    v_sale_id, v_replacement_sale_id,
    v_return_subtotal, v_return_tax, v_return_total,
    v_replacement_total, v_settlement_net, auth.uid()
  );

  insert into public.sales_return_lines (
    return_id, original_sale_id, original_sale_line_id, item_sku, quantity,
    reason_code, disposition, refund_subtotal, refund_tax, refund_total,
    original_unit_cost, cost_amount
  )
  values (
    v_return_id, v_sale_id, p_sale_line_id, v_line_sku, p_quantity,
    p_reason_code, p_disposition, v_return_subtotal, v_return_tax,
    v_return_total, v_unit_cost, v_cost_amount
  );

  -- Waste leaves stock and the original COGS unchanged. Restock adds stock;
  -- reports can reverse the stored original cost_amount for that disposition.
  if p_disposition = 'Restock' then
    insert into public.inventory_transactions (
      item_sku, location_id, quantity, unit_cost, transaction_type,
      reason_code, reference_document, user_id, metadata
    )
    values (
      v_line_sku, v_location_id, p_quantity, v_unit_cost, 'Return Restock',
      p_reason_code, 'RETURN-' || v_return_id::text, auth.uid(),
      pg_catalog.jsonb_build_object(
        'return_id', v_return_id,
        'sale_line_id', p_sale_line_id
      )
    );
  end if;

  v_result := pg_catalog.jsonb_build_object(
    'return_id', v_return_id,
    'transaction_type', p_kind,
    'refund_subtotal', v_return_subtotal,
    'refund_tax', v_return_tax,
    'refund_total', v_return_total,
    'replacement_sale_id', v_replacement_sale_id,
    'replacement_total', v_replacement_total,
    'settlement_net', v_settlement_net,
    'settlement_mode', 'Manual/Simulated'
  );

  update public.sales_returns
     set result = v_result
   where id = v_return_id;

  return v_result;
end
$$;

revoke all on function public._apply_return_exchange(
  text, uuid, uuid, numeric, text, text, jsonb
) from public, anon, authenticated;

create function public.process_return(
  p_request_id uuid,
  p_sale_line_id uuid,
  p_quantity numeric,
  p_reason_code text,
  p_disposition text
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public._apply_return_exchange(
    'Return', p_request_id, p_sale_line_id, p_quantity,
    p_reason_code, p_disposition, null::jsonb
  )
$$;

create function public.process_exchange(
  p_request_id uuid,
  p_sale_line_id uuid,
  p_quantity numeric,
  p_reason_code text,
  p_disposition text,
  p_replacement_lines jsonb
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public._apply_return_exchange(
    'Exchange', p_request_id, p_sale_line_id, p_quantity,
    p_reason_code, p_disposition, p_replacement_lines
  )
$$;

revoke all on function public.process_return(
  uuid, uuid, numeric, text, text
) from public, anon, authenticated;
revoke all on function public.process_exchange(
  uuid, uuid, numeric, text, text, jsonb
) from public, anon, authenticated;

grant execute on function public.process_return(
  uuid, uuid, numeric, text, text
) to authenticated;
grant execute on function public.process_exchange(
  uuid, uuid, numeric, text, text, jsonb
) to authenticated;
