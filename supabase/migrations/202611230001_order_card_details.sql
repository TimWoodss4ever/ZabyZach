-- Save ONLY the card brand and last 4 digits for POS sales and online orders
-- (never the full number, expiry, security code, cardholder name or ZIP).
--
-- How it works without touching the order/sale functions other teammates own:
--   1. The app calls erp_save_order_card(<request id>, brand, last4) just before
--      it sends the sale/order with that SAME request id.
--   2. Triggers copy the card onto the new sales_orders row (online/pickup/delivery
--      orders), onto the sale when an order is prepared, and onto the sale for
--      POS checkouts (matched through erp_pos_requests).
-- Safe to re-run.
begin;

alter table public.sales
  add column if not exists card_brand text,
  add column if not exists card_last4 text;
alter table public.sales_orders
  add column if not exists card_brand text,
  add column if not exists card_last4 text;

alter table public.sales drop constraint if exists sales_card_check;
alter table public.sales add constraint sales_card_check check(
  (card_brand is null and card_last4 is null) or
  (card_brand in('Visa','Mastercard','American Express','Discover','Other') and card_last4 ~ '^[0-9]{4}$'));
alter table public.sales_orders drop constraint if exists sales_orders_card_check;
alter table public.sales_orders add constraint sales_orders_card_check check(
  (card_brand is null and card_last4 is null) or
  (card_brand in('Visa','Mastercard','American Express','Discover','Other') and card_last4 ~ '^[0-9]{4}$'));

-- Staging table: only the functions below read or write it.
create table if not exists public.erp_order_cards(
  order_id uuid primary key,
  card_brand text not null check(card_brand in('Visa','Mastercard','American Express','Discover','Other')),
  card_last4 text not null check(card_last4 ~ '^[0-9]{4}$'),
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now());
alter table public.erp_order_cards enable row level security;
revoke all on public.erp_order_cards from public, anon, authenticated;

create or replace function public.erp_save_order_card(p_order uuid,p_brand text,p_last4 text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if auth.uid() is null or coalesce(public.current_role(),'') not in('Manager','Cashier','Customer') then
  raise exception 'Sign in required' using errcode='42501'; end if;
 if p_order is null then raise exception 'An order request ID is required'; end if;
 if p_brand is null or p_brand not in('Visa','Mastercard','American Express','Discover','Other') then raise exception 'Unknown card brand'; end if;
 if p_last4 is null or p_last4 !~ '^[0-9]{4}$' then raise exception 'Card last 4 must be exactly 4 digits'; end if;
 insert into public.erp_order_cards(order_id,card_brand,card_last4,created_by) values(p_order,p_brand,p_last4,auth.uid())
 on conflict(order_id) do update set card_brand=excluded.card_brand,card_last4=excluded.card_last4
  where public.erp_order_cards.created_by=auth.uid();
 return jsonb_build_object('saved',true);
end $$;
revoke all on function public.erp_save_order_card(uuid,text,text) from public,anon;
grant execute on function public.erp_save_order_card(uuid,text,text) to authenticated;

-- New online/pickup/delivery order: pick up the card saved under its request id.
create or replace function public.erp_order_card_on_insert() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.erp_order_cards%rowtype;
begin
 select * into c from public.erp_order_cards where order_id=new.id;
 if found then new.card_brand:=c.card_brand; new.card_last4:=c.card_last4; end if;
 return new;
end $$;
drop trigger if exists erp_order_card_on_insert on public.sales_orders;
create trigger erp_order_card_on_insert before insert on public.sales_orders
 for each row execute function public.erp_order_card_on_insert();

-- When an order is prepared its sale is linked: copy the card onto that sale too.
create or replace function public.erp_order_card_to_sale() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if new.erp_sale_id is not null and new.card_last4 is not null then
  update public.sales set card_brand=new.card_brand,card_last4=new.card_last4
   where id=new.erp_sale_id and card_last4 is null;
 end if;
 return null;
end $$;
drop trigger if exists erp_order_card_to_sale on public.sales_orders;
create trigger erp_order_card_to_sale after insert or update of erp_sale_id on public.sales_orders
 for each row execute function public.erp_order_card_to_sale();

-- POS checkout: the sale function saves its request row last; use it to find the sale.
create or replace function public.erp_pos_card_on_request() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.erp_order_cards%rowtype; sid uuid;
begin
 select * into c from public.erp_order_cards where order_id=new.request_id;
 if found then
  begin sid:=(new.result->>'sale_id')::uuid;
  exception when invalid_text_representation then sid:=null; end;
  if sid is not null then
   update public.sales set card_brand=c.card_brand,card_last4=c.card_last4 where id=sid;
  end if;
 end if;
 return null;
end $$;
drop trigger if exists erp_pos_card_on_request on public.erp_pos_requests;
create trigger erp_pos_card_on_request after insert on public.erp_pos_requests
 for each row execute function public.erp_pos_card_on_request();

commit;
