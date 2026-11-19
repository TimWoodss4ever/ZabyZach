-- Additive receiving timestamp safeguard. Existing rows/functions are unchanged.
-- Today's morning deliveries must be visible to stock queries immediately;
-- older receipt dates retain their original accounting timestamp.
begin;
create or replace function public.erp_receipt_visibility_time(p_occurred_at timestamptz,p_now timestamptz)
returns timestamptz language sql immutable set search_path=pg_catalog as $$
 select case when (p_occurred_at at time zone 'America/Denver')::date=(p_now at time zone 'America/Denver')::date
  and p_occurred_at>p_now then p_now else p_occurred_at end
$$;
create or replace function public.erp_visible_purchase_receipt() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if new.transaction_type='Receipt' and new.metadata ? 'erp_receipt_id' then
  new.occurred_at:=public.erp_receipt_visibility_time(new.occurred_at,now());
 end if;
 return new;
end $$;
revoke all on function public.erp_receipt_visibility_time(timestamptz,timestamptz),public.erp_visible_purchase_receipt() from public,anon,authenticated;
drop trigger if exists erp_visible_purchase_receipt on public.inventory_transactions;
create trigger erp_visible_purchase_receipt before insert on public.inventory_transactions
 for each row execute function public.erp_visible_purchase_receipt();
commit;
select 'Receiving timestamp safeguard installed. Existing inventory, orders, invoices and payments were not changed.' as result;
