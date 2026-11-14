-- Add staff access and secure production-order creation.
do $$
declare
  v_conflicting_policies pg_catalog.text;
  v_intended_policy_exists boolean;
  v_intended_policy record;
begin
  select exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'production_orders'
      and policyname = 'staff read production orders'
  )
  into v_intended_policy_exists;

  if v_intended_policy_exists then
    select permissive, roles, cmd, qual, with_check
    into v_intended_policy
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'production_orders'
      and policyname = 'staff read production orders';

    if v_intended_policy.permissive is distinct from 'PERMISSIVE'
      or v_intended_policy.roles is distinct from array['authenticated'::pg_catalog.name]
      or v_intended_policy.cmd is distinct from 'SELECT'
      or v_intended_policy.qual is null
      or pg_catalog.regexp_replace(
        v_intended_policy.qual,
        '[[:space:]()]|public\.|::text',
        '',
        'g'
      ) is distinct from 'current_role=ANYARRAY[''Manager'',''Cashier'']'
      or v_intended_policy.with_check is not null then
      raise exception 'Existing policy "staff read production orders" does not match the intended definition. Existing definition: permissive=%, roles=%, command=%, using=%, with_check=%',
        v_intended_policy.permissive,
        v_intended_policy.roles,
        v_intended_policy.cmd,
        v_intended_policy.qual,
        v_intended_policy.with_check;
    end if;
  end if;

  select pg_catalog.string_agg(policyname::pg_catalog.text, ', ' order by policyname)
  into v_conflicting_policies
  from pg_catalog.pg_policies
  where schemaname = 'public'
    and tablename = 'production_orders'
    and cmd in ('SELECT', 'ALL')
    and not (
      policyname = 'staff read production orders'
      and cmd = 'SELECT'
    );

  if v_conflicting_policies is not null then
    raise exception 'Cannot add staff read production orders policy: conflicting SELECT or ALL policy(ies) already exist on public.production_orders: %',
      v_conflicting_policies;
  end if;

  if not v_intended_policy_exists then
    create policy "staff read production orders"
      on public.production_orders
      for select to authenticated
      using (public.current_role() in ('Manager', 'Cashier'));
  end if;
end
$$;

create or replace function public.create_production_order(
  p_parent_sku pg_catalog.text,
  p_location pg_catalog.uuid,
  p_quantity pg_catalog.numeric
)
returns pg_catalog.uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id pg_catalog.uuid := pg_catalog.gen_random_uuid();
  v_order_no pg_catalog.text;
begin
  perform public.require_staff();

  if p_quantity is null
    or p_quantity::pg_catalog.text in ('NaN', 'Infinity', '-Infinity')
    or p_quantity <= 0 then
    raise exception 'Production quantity must be positive';
  end if;

  if not exists (
    select 1
    from public.items
    where sku = p_parent_sku
      and active
  ) then
    raise exception 'Production item is not available';
  end if;

  if not exists (
    select 1
    from public.bom_lines
    where parent_sku = p_parent_sku
  ) then
    raise exception 'Production item must have a bill of materials';
  end if;

  if not exists (
    select 1
    from public.locations
    where id = p_location
  ) then
    raise exception 'Production location does not exist';
  end if;

  v_order_no := 'PR-'
    || pg_catalog.right((pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::pg_catalog.bigint)::pg_catalog.text, 6)
    || '-'
    || v_id::pg_catalog.text;

  insert into public.production_orders (
    id,
    order_no,
    parent_sku,
    location_id,
    quantity_started,
    created_by
  )
  values (
    v_id,
    v_order_no,
    p_parent_sku,
    p_location,
    p_quantity,
    auth.uid()
  );

  return v_id;
end
$$;

revoke all on function public.create_production_order(
  pg_catalog.text,
  pg_catalog.uuid,
  pg_catalog.numeric
)
  from public, anon, authenticated;
grant execute on function public.create_production_order(
  pg_catalog.text,
  pg_catalog.uuid,
  pg_catalog.numeric
)
  to authenticated;
