-- Store the pickup time within pickup_at and preserve any customer welcome reward.
alter table public.sales_orders
  add column if not exists discount_pct numeric not null default 0
    check (discount_pct between 0 and 100),
  add column if not exists discount_amount numeric not null default 0
    check (discount_amount >= 0);
