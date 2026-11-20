-- Customer access to the existing POS rewards program. No enrollment, history
-- backfill, data import, stock/pricing engine changes, or changes to POS rules.
begin;
select pg_advisory_xact_lock(1179468369,210002);
do $$declare body text;begin
 if to_regclass('public.erp_customer_rewards_orders') is not null then
  raise exception 'Customer rewards is already installed; do not replay this migration';
 end if;
 if to_regprocedure('public.erp_customer_availability(text)') is null or to_regprocedure('public.erp_customer_pickup_locations()') is null then
  raise exception 'Install the reviewed customer availability rollout before customer rewards';
 end if;
 if to_regprocedure('public.erp_rewards_posted_balance(uuid)') is not null or to_regprocedure('public.erp_pickup_progress_before_rewards(uuid,text)') is not null then
  raise exception 'Customer rewards helper names are already in use; no functions changed';
 end if;
 if to_regprocedure('public.erp_rewards_balance(uuid)') is null
  or to_regprocedure('public.erp_pickup_progress(uuid,text)') is null then
  raise exception 'Install the existing shared POS rewards and current pickup lifecycle first';
 end if;
 if exists(select 1 from pg_proc p where p.oid in ('public.erp_rewards_balance(uuid)'::regprocedure,'public.erp_pickup_progress(uuid,text)'::regprocedure) and p.proowner<>current_user::regrole) then
  raise exception 'Run this migration as the owner of the existing rewards and pickup functions';
 end if;
 -- The account/customer FK is trusted only while clients cannot edit it.
 -- Do not change unexpected policies here; require a read-only review instead.
 if not (select relrowsecurity from pg_class where oid='public.profiles'::regclass)
  or exists(select 1 from pg_policy where polrelid='public.profiles'::regclass and polcmd in ('a','w','*'))
  or exists(select 1 from pg_roles where rolname='authenticated' and (rolsuper or rolbypassrls)) then
  raise exception 'Profile link security differs from the reviewed read-only policy; inspect it before installing rewards';
 end if;
 body:=pg_get_functiondef('public.erp_create_pickup_order(uuid,jsonb)'::regprocedure);
 if position('quoteFrozen' in body)=0 or position('erp_quote_tax_rate' in body)=0
  or position('erp_checkout_post_sale(' in body)>0 then
  raise exception 'Expected frozen quotes and deferred sale posting; review the installed order lifecycle';
 end if;
 body:=pg_get_functiondef('public.erp_pickup_progress(uuid,text)'::regprocedure);
 if position('public.erp_plan_post_sale(' in body)=0 or position('erp_quote_total' in body)=0
  or position('Only an unprepared order can be cancelled' in body)=0 then
  raise exception 'Unexpected pickup lifecycle; no functions changed';
 end if;
end $$;

-- The installer retains the exact installed functions for review/recovery.
create table public.erp_customer_rewards_installation (
 signature text primary key, definition text not null, installed_at timestamptz not null default now()
);
create table public.erp_customer_rewards_orders (
 order_id uuid primary key references public.sales_orders(id),
 user_id uuid not null references auth.users(id),customer_id uuid references public.customers(id),
 payload jsonb not null,eligible boolean not null,
 reserved_points integer not null check(reserved_points in (0,100)),
 reward_discount numeric(14,2) not null check(reward_discount in (0,5)),
 state text not null default 'Pending' check(state in ('Pending','Posted','Cancelled')),
 sale_id uuid unique references public.sales(id),
 created_at timestamptz not null default now(),posted_at timestamptz,cancelled_at timestamptz,
 check((reserved_points=100 and reward_discount=5 and eligible) or (reserved_points=0 and reward_discount=0)),
 check(not eligible or customer_id is not null)
);
create index erp_customer_rewards_pending on public.erp_customer_rewards_orders(customer_id) where state='Pending';
alter table public.erp_customer_rewards_installation enable row level security;
alter table public.erp_customer_rewards_orders enable row level security;
revoke all on public.erp_customer_rewards_installation,public.erp_customer_rewards_orders from public,anon,authenticated;

insert into public.erp_customer_rewards_installation(signature,definition)
 select p::text,pg_get_functiondef(p) from unnest(array[
 'public.erp_rewards_balance(uuid)'::regprocedure,
 'public.erp_pickup_progress(uuid,text)'::regprocedure
 ]) p;
do $$declare body text;begin
 body:=pg_get_functiondef('public.erp_rewards_balance(uuid)'::regprocedure);
 execute replace(body,'FUNCTION public.erp_rewards_balance(','FUNCTION public.erp_rewards_posted_balance(');
 body:=pg_get_functiondef('public.erp_pickup_progress(uuid,text)'::regprocedure);
 execute replace(body,'FUNCTION public.erp_pickup_progress(','FUNCTION public.erp_pickup_progress_before_rewards(');
end $$;
revoke all on function public.erp_rewards_posted_balance(uuid),public.erp_pickup_progress_before_rewards(uuid,text) from public,anon,authenticated;

-- Trust only the existing administrator-controlled profile FK, never form data,
-- email matching, or a typed phone. Ambiguous links fail closed.
create function public.erp_customer_rewards_identity() returns uuid
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare customer uuid;begin
 if auth.uid() is null or public.current_role() is distinct from 'Customer' then
  raise exception 'Customer sign-in required' using errcode='42501';
 end if;
 select p.customer_id into customer from public.profiles p join public.customers c on c.id=p.customer_id
 where p.user_id=auth.uid() and p.role='Customer';
 if customer is null or (select count(*) from public.profiles p where p.customer_id=customer)<>1 then return null;end if;
 return customer;
end $$;
create function public.erp_customer_rewards_member() returns uuid
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare customer uuid:=public.erp_customer_rewards_identity();v_phone text;begin
 if customer is null then return null;end if;
 select m.phone into v_phone from public.erp_rewards_members m join public.customers c on c.id=m.customer_id
 where m.customer_id=customer and public.erp_rewards_phone(c.phone)=m.phone;
 if v_phone is null or (select count(*) from public.customers c where public.erp_rewards_phone(c.phone)=v_phone)<>1 then return null;end if;
 return customer;
end $$;

-- Preserve the installed POS/return arithmetic. Reservations reduce only the
-- spendable balance, using the SAME phone advisory lock already held by POS.
create or replace function public.erp_rewards_balance(p_customer uuid) returns integer
language sql security definer set search_path=pg_catalog,public as $$
 select public.erp_rewards_posted_balance(p_customer)-coalesce((
  select sum(r.reserved_points) from public.erp_customer_rewards_orders r
  where r.customer_id=p_customer and r.state='Pending'),0)::integer
$$;
-- No arbitrary-customer balance RPC is exposed to browser clients. POS retains
-- access through its existing staff-checked SECURITY DEFINER endpoints.
revoke all on function public.erp_rewards_balance(uuid) from public,anon,authenticated;

create function public.erp_customer_rewards_snapshot() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare customer uuid:=public.erp_customer_rewards_identity();member uuid;activity jsonb;pending integer;begin
 if customer is null then return jsonb_build_object('status','link_review');end if;
 if not exists(select 1 from public.erp_rewards_members m where m.customer_id=customer) then
  return jsonb_build_object('status','not_enrolled');
 end if;
 member:=public.erp_customer_rewards_member();
 if member is null then return jsonb_build_object('status','link_review');end if;
 select coalesce(sum(reserved_points),0)::integer into pending from public.erp_customer_rewards_orders
 where customer_id=member and state='Pending';
 -- Return activity uses differences in the existing cumulative ceil/floor
 -- reversal calculation, not independently rounded per-return estimates.
 with sales as (
  select s.* from public.sales s where s.customer_id=member
   and (s.rewards_earned<>0 or s.rewards_redeemed<>0 or exists(
    select 1 from public.erp_customer_rewards_orders o where o.sale_id=s.id and o.eligible))
 ), returned as (
  select r.id,r.created_at,s.id sale_id,s.receipt_no,s.subtotal,s.rewards_earned,s.rewards_redeemed,
   sum(l.quantity*sl.unit_price) gross
  from public.sales_returns r join public.sales_return_lines l on l.return_id=r.id
  join public.sale_lines sl on sl.id=l.original_sale_line_id join sales s on s.id=l.original_sale_id
  group by r.id,r.created_at,s.id,s.receipt_no,s.subtotal,s.rewards_earned,s.rewards_redeemed
 ), cumulative as (
  select *,coalesce(sum(gross) over(partition by sale_id order by created_at,id rows between unbounded preceding and 1 preceding),0) before_gross,
   sum(gross) over(partition by sale_id order by created_at,id rows unbounded preceding) after_gross from returned
 ), events as (
  select 'sale:'||s.id::text id,s.created_at occurred_at,(s.status||' sale: '||s.rewards_earned||' earned, '||s.rewards_redeemed||' redeemed') label,s.receipt_no reference,
   s.rewards_earned-s.rewards_redeemed points,0 reserved_points from sales s
  union all
  select 'return:'||r.id::text,r.created_at,'Return adjustment',r.receipt_no,
   (-least(r.rewards_earned,ceil(r.rewards_earned*least(1,coalesce(r.after_gross/nullif(r.subtotal,0),0))))
    +least(r.rewards_redeemed,floor(r.rewards_redeemed*least(1,coalesce(r.after_gross/nullif(r.subtotal,0),0))))
    +least(r.rewards_earned,ceil(r.rewards_earned*least(1,coalesce(r.before_gross/nullif(r.subtotal,0),0))))
    -least(r.rewards_redeemed,floor(r.rewards_redeemed*least(1,coalesce(r.before_gross/nullif(r.subtotal,0),0)))))::integer,0 from cumulative r
  union all
  select 'order:'||o.order_id::text,coalesce(o.cancelled_at,o.created_at),
   case when o.state='Cancelled' then 'Order cancelled; reservation released' else 'Order awaiting sale posting' end,
   'Order '||s.erp_order_number,0,case when o.state='Pending' then o.reserved_points else 0 end
  from public.erp_customer_rewards_orders o join public.sales_orders s on s.id=o.order_id
  where o.customer_id=member and o.eligible and o.state in ('Pending','Cancelled')
 ) select coalesce(jsonb_agg(to_jsonb(e) order by e.occurred_at desc,e.id),'[]'::jsonb) into activity
 from (select * from events order by occurred_at desc,id limit 50)e;
 return jsonb_build_object('status','ready','available',public.erp_rewards_balance(member),
  'posted',public.erp_rewards_posted_balance(member),'reserved',pending,'activity',activity);
end $$;

create function public.erp_customer_rewards_checkout(p_request uuid,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare customer uuid:=public.erp_customer_rewards_identity();member uuid;phone text;
 prior public.erp_customer_rewards_orders%rowtype;o public.sales_orders%rowtype;
 answer jsonb;redeem boolean;discount numeric;tax numeric;begin
 if p_request is null or p_payload is null or jsonb_typeof(p_payload)<>'object'
  or p_payload->>'rewardsVersion' is distinct from '1' or jsonb_typeof(p_payload->'redeemRewards') is distinct from 'boolean' then
  raise exception 'A versioned rewards checkout request is required';
 end if;
 redeem:=(p_payload->>'redeemRewards')::boolean;
 perform pg_advisory_xact_lock(hashtextextended(p_request::text,0));
 -- Recovery and staff progress both take the order row before the manifest.
 -- Holding the manifest first could deadlock against the posting trigger.
 perform 1 from public.sales_orders where id=p_request and created_by=auth.uid() for update;
 select * into prior from public.erp_customer_rewards_orders where order_id=p_request for update;
 if found then
  if prior.user_id is distinct from auth.uid() or prior.payload is distinct from p_payload then
   raise exception 'Checkout request does not match the saved order' using errcode='42501';
  end if;
  -- Recovery returns the persisted quote/status; it never re-reserves points.
  answer:=public.erp_checkout_order(p_request,p_payload-'rewardsVersion'-'redeemRewards');
  return answer||jsonb_build_object('rewardsEligible',prior.eligible,'rewardDiscount',prior.reward_discount);
 end if;
 if exists(select 1 from public.sales_orders where id=p_request) then
  raise exception 'Use the original checkout endpoint to recover this pre-existing order';
 end if;
 member:=public.erp_customer_rewards_member();
 if member is not null then
  select m.phone into phone from public.erp_rewards_members m where m.customer_id=member;
  perform pg_advisory_xact_lock(hashtextextended(phone,713));
 end if;
 if redeem and member is null then raise exception 'Staff must verify and enroll your linked customer account before redemption';end if;
 if redeem and public.erp_rewards_balance(member)<100 then raise exception 'You need 100 available points to redeem';end if;
 answer:=public.erp_checkout_order(p_request,p_payload-'rewardsVersion'-'redeemRewards');
 select * into o from public.sales_orders where id=p_request for update;
 if o.erp_sale_id is not null or o.erp_prepared_at is not null or o.status<>'Order Placed' or o.erp_quote_total is null then
  raise exception 'Rewards require a newly quoted, unprepared order';
 end if;
 if member is not null and o.customer_id is distinct from member then raise exception 'Customer link changed; retry checkout';end if;
 if redeem then
  if o.erp_quote_subtotal-o.erp_quote_discount<5 then raise exception 'At least $5 after other discounts is required';end if;
  discount:=o.erp_quote_discount+5;
  tax:=round((o.erp_quote_subtotal-discount)*o.erp_quote_tax_rate,2);
  update public.sales_orders set discount_amount=discount_amount+5,
   erp_quote_discount=discount,erp_quote_tax=tax,erp_quote_total=erp_quote_subtotal-discount+tax where id=p_request;
  answer:=answer||jsonb_build_object('discount',discount,'tax',tax,'total',o.erp_quote_subtotal-discount+tax);
 end if;
 insert into public.erp_customer_rewards_orders(order_id,user_id,customer_id,payload,eligible,reserved_points,reward_discount)
 values(p_request,auth.uid(),o.customer_id,p_payload,member is not null,case when redeem then 100 else 0 end,case when redeem then 5 else 0 end);
 return answer||jsonb_build_object('rewardsEligible',member is not null,'rewardDiscount',case when redeem then 5 else 0 end);
end $$;

-- Acquire the POS-compatible member lock BEFORE the unchanged posting engine
-- takes stock locks. Order-row -> member-phone -> stock is the shared order.
create or replace function public.erp_pickup_progress(p_order uuid,p_action text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare phone text;answer jsonb;begin
 perform public.require_staff();
 perform 1 from public.sales_orders where id=p_order for update;
 select m.phone into phone from public.erp_customer_rewards_orders r
 join public.erp_rewards_members m on m.customer_id=r.customer_id where r.order_id=p_order and r.eligible;
 if phone is not null then perform pg_advisory_xact_lock(hashtextextended(phone,713));end if;
 answer:=public.erp_pickup_progress_before_rewards(p_order,p_action);
 return answer;
end $$;

create function public.erp_customer_rewards_order_event() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.erp_customer_rewards_orders%rowtype;s public.sales%rowtype;phone text;begin
 select * into r from public.erp_customer_rewards_orders where order_id=new.id for update;
 if not found or r.state<>'Pending' then return new;end if;
 if new.status='Cancelled' then
  update public.erp_customer_rewards_orders set state='Cancelled',cancelled_at=now() where order_id=new.id;
 elsif new.erp_sale_id is not null then
  if r.eligible then
   select m.phone into phone from public.erp_rewards_members m where m.customer_id=r.customer_id;
   if phone is null then raise exception 'Rewards membership needs review before posting this order';end if;
   perform pg_advisory_xact_lock(hashtextextended(phone,713));
   select * into s from public.sales where id=new.erp_sale_id for update;
   if s.customer_id is distinct from r.customer_id or s.status<>'Completed' then raise exception 'Rewards sale does not match this order';end if;
   update public.sales set rewards_earned=floor(greatest(0,s.subtotal-s.discount)+.00000001)::integer,
    rewards_redeemed=r.reserved_points,rewards_discount=r.reward_discount where id=s.id;
  end if;
  update public.erp_customer_rewards_orders set state='Posted',sale_id=new.erp_sale_id,posted_at=now() where order_id=new.id;
 end if;
 return new;
end $$;
create trigger erp_customer_rewards_lifecycle after update of erp_sale_id,status on public.sales_orders
 for each row execute function public.erp_customer_rewards_order_event();

revoke all on function public.erp_customer_rewards_identity(),public.erp_customer_rewards_member(),
 public.erp_customer_rewards_order_event(),public.erp_customer_rewards_snapshot(),public.erp_customer_rewards_checkout(uuid,jsonb),
 public.erp_pickup_progress(uuid,text) from public,anon,authenticated;
grant execute on function public.erp_customer_rewards_snapshot(),public.erp_customer_rewards_checkout(uuid,jsonb),
 public.erp_pickup_progress(uuid,text) to authenticated;
commit;
