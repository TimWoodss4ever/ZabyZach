-- Shared POS loyalty. Existing sales and browser demo balances are not backfilled.
begin;
create or replace function public.erp_rewards_phone(p_phone text) returns text
language sql immutable set search_path=pg_catalog as $$
 select case when length(d)=10 then '+1'||d when length(d)=11 and left(d,1)='1' then '+'||d else null end
 from (select regexp_replace(coalesce(p_phone,''),'[^0-9]','','g') d) x
$$;
create table public.erp_rewards_members (
 customer_id uuid primary key references public.customers(id),
 phone text not null unique check(phone=public.erp_rewards_phone(phone)),
 joined_at timestamptz not null default now()
);
alter table public.sales add column rewards_earned integer not null default 0 check(rewards_earned>=0),
 add column rewards_redeemed integer not null default 0 check(rewards_redeemed in (0,100)),
 add column rewards_discount numeric not null default 0 check(rewards_discount in (0,5)),
 add column pickup_name text;
create index erp_pos_sales_customer on public.sales(customer_id) where customer_id is not null;
create index erp_pos_return_sale on public.sales_return_lines(original_sale_id);
create index erp_pos_normalized_customer_phone on public.customers(public.erp_rewards_phone(phone));
create table public.erp_pos_requests (
 request_id uuid primary key, user_id uuid not null references auth.users(id),
 payload jsonb not null, result jsonb not null
);
alter table public.erp_rewards_members enable row level security;
alter table public.erp_pos_requests enable row level security;
revoke all on public.erp_rewards_members,public.erp_pos_requests from anon,authenticated;

-- Calculate from shared sales and cumulative refunds, so repeated/partial returns
-- reverse earned points and restore spent points exactly once.
create function public.erp_rewards_balance(p_customer uuid) returns integer
language sql security definer set search_path=pg_catalog,public as $$
 select coalesce(sum(s.rewards_earned-s.rewards_redeemed
  -least(s.rewards_earned,ceil(s.rewards_earned*r.fraction))
  +least(s.rewards_redeemed,floor(s.rewards_redeemed*r.fraction))),0)::integer
 from public.sales s cross join lateral (
  select least(1,coalesce(sum(sr.quantity*sl.unit_price)/nullif(s.subtotal,0),0)) fraction
  from public.sales_return_lines sr join public.sale_lines sl on sl.id=sr.original_sale_line_id where sr.original_sale_id=s.id
 ) r where s.customer_id=p_customer
$$;
create function public.erp_pos_customer(p_phone text,p_name text default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_phone text:=public.erp_rewards_phone(p_phone); v_id uuid; v_count integer; v_name text;
begin
 if auth.uid() is null or coalesce(public.current_role(),'') not in ('Manager','Cashier') then raise exception 'Manager or Cashier role required' using errcode='42501'; end if;
 if v_phone is null then raise exception 'Enter a 10-digit US phone number'; end if;
 perform pg_advisory_xact_lock(hashtextextended(v_phone,713));
 select customer_id into v_id from public.erp_rewards_members where phone=v_phone;
 if v_id is null then
  select count(*),(array_agg(id))[1] into v_count,v_id from public.customers where public.erp_rewards_phone(phone)=v_phone;
  if v_count>1 then raise exception 'Multiple customers share this phone. Ask a manager to resolve the duplicate records'; end if;
 end if;
 if p_name is not null then
  v_name:=btrim(p_name);
  if length(v_name) not between 1 and 60 then raise exception 'Enter a customer name of 1 to 60 characters'; end if;
  if v_id is null then insert into public.customers(name,phone) values(v_name,v_phone) returning id into v_id;
  else update public.customers set name=v_name where id=v_id; end if;
  insert into public.erp_rewards_members(customer_id,phone) values(v_id,v_phone) on conflict(customer_id) do nothing;
 end if;
 if v_id is null then return null; end if;
 return (select jsonb_build_object('id',c.id,'name',c.name,'phone',v_phone,
  'enrolled',exists(select 1 from public.erp_rewards_members m where m.customer_id=c.id),
  'points',public.erp_rewards_balance(c.id)) from public.customers c where c.id=v_id);
end $$;

create function public.erp_pos_sale(p_request uuid,p_location uuid,p_lines jsonb,
 p_discount_percent numeric default 0,p_phone text default null,p_name text default null,p_redeem boolean default false)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_payload jsonb:=jsonb_build_object('location',p_location,'lines',p_lines,'discount',p_discount_percent,'phone',p_phone,'name',p_name,'redeem',p_redeem);
 v_prior public.erp_pos_requests%rowtype; v_customer jsonb; v_id uuid; v_result jsonb; v_sale uuid;
 v_subtotal numeric; v_percent numeric:=p_discount_percent; v_credit numeric:=0; v_earned integer:=0;
begin
 if auth.uid() is null or coalesce(public.current_role(),'') not in ('Manager','Cashier') then raise exception 'Manager or Cashier role required' using errcode='42501'; end if;
 if p_request is null then raise exception 'A checkout request ID is required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request::text,714));
 select * into v_prior from public.erp_pos_requests where request_id=p_request;
 if found then
  if v_prior.user_id<>auth.uid() or v_prior.payload<>v_payload then raise exception 'Checkout request does not match the saved sale'; end if;
  return v_prior.result;
 end if;
 if p_discount_percent is null or p_discount_percent::text in ('NaN','Infinity','-Infinity') or p_discount_percent not between 0 and 100 then raise exception 'Discount must be between 0 and 100'; end if;
 if p_lines is null or jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)=0 then raise exception 'Add at least one item'; end if;
 if exists(select 1 from jsonb_to_recordset(p_lines) x(sku text,qty numeric) where qty is null or qty::text in ('NaN','Infinity','-Infinity') or qty<=0 or qty<>trunc(qty) or sku is null) then raise exception 'Enter positive whole item quantities'; end if;
 if not exists(select 1 from public.locations where id=p_location and can_sell) then raise exception 'Select a selling location'; end if;
 if nullif(btrim(p_phone),'') is not null then
  v_customer:=public.erp_pos_customer(p_phone,coalesce(nullif(btrim(p_name),''),(public.erp_pos_customer(p_phone)->>'name')));
  if v_customer is null or not (v_customer->>'enrolled')::boolean then raise exception 'Enter a name to enroll this rewards customer'; end if;
  v_id:=(v_customer->>'id')::uuid;
 elsif p_redeem then raise exception 'Select a rewards customer before redeeming'; end if;
 -- Lock prices before computing the fixed reward as a percentage accepted by
 -- the existing stock-posting function. Its stock checks remain authoritative.
 perform 1 from public.items where sku in(select x.sku from jsonb_to_recordset(p_lines) x(sku text)) order by sku for update;
 select sum(i.selling_price*x.qty) into v_subtotal from jsonb_to_recordset(p_lines) x(sku text,qty numeric) join public.items i on i.sku=x.sku;
 if p_redeem then
  if public.erp_rewards_balance(v_id)<100 then raise exception 'This customer needs 100 points to redeem'; end if;
  if coalesce(v_subtotal*(1-p_discount_percent/100),0)<5 then raise exception 'At least $5 after other discounts is required'; end if;
  v_credit:=5; v_percent:=p_discount_percent+500/v_subtotal;
 end if;
 v_result:=public.record_sale(p_location,p_lines,v_percent,v_id);
 v_sale:=(v_result->>'sale_id')::uuid;
 if v_id is not null then v_earned:=floor(greatest(0,(v_result->>'subtotal')::numeric-(v_result->>'discount')::numeric)+0.00000001)::integer; end if;
 update public.sales set rewards_earned=v_earned,rewards_redeemed=case when p_redeem then 100 else 0 end,
  rewards_discount=v_credit,pickup_name=nullif(btrim(p_name),'') where id=v_sale;
 v_result:=v_result||jsonb_build_object('rewards_earned',v_earned,'rewards_redeemed',case when p_redeem then 100 else 0 end,
  'rewards_balance',case when v_id is not null then public.erp_rewards_balance(v_id) else null end);
 insert into public.erp_pos_requests values(p_request,auth.uid(),v_payload,v_result);
 return v_result;
end $$;
revoke all on function public.erp_rewards_balance(uuid),public.erp_pos_customer(text,text),public.erp_pos_sale(uuid,uuid,jsonb,numeric,text,text,boolean) from public,anon;
grant execute on function public.erp_pos_customer(text,text),public.erp_pos_sale(uuid,uuid,jsonb,numeric,text,text,boolean) to authenticated;
commit;
