-- DISPOSABLE CI DATABASE ONLY. Never run this file in Supabase.
\set ON_ERROR_STOP on
do $$begin if current_database()<>'erp_test' then raise exception 'Disposable erp_test database only';end if;end $$;
create temporary table rewards_preserved_rows as
 select 'sales' kind,md5(coalesce(string_agg(to_jsonb(t)::text,'' order by id),'')) digest from public.sales t
 union all select 'orders',md5(coalesce(string_agg(to_jsonb(t)::text,'' order by id),'')) from public.sales_orders t
 union all select 'stock',md5(coalesce(string_agg(to_jsonb(t)::text,'' order by id),'')) from public.inventory_transactions t
 union all select 'returns',md5(coalesce(string_agg(to_jsonb(t)::text,'' order by id),'')) from public.sales_returns t
 union all select 'customers',md5(coalesce(string_agg(to_jsonb(t)::text,'' order by id),'')) from public.customers t
 union all select 'members',md5(coalesce(string_agg(to_jsonb(t)::text,'' order by customer_id),'')) from public.erp_rewards_members t;
create temporary table rewards_preserved_functions as
 select oid::regprocedure::text signature,pg_get_functiondef(oid) definition from pg_proc where pronamespace='public'::regnamespace
 and proname in ('erp_pos_sale','erp_pos_customer','erp_plan_post_sale','erp_checkout_post_sale','record_sale','process_return','process_exchange','erp_create_pickup_order','erp_checkout_order');
\ir ../../supabase/migrations/202611210002_customer_rewards.sql
select public.ci_assert(not exists(select * from rewards_preserved_functions p where p.definition is distinct from pg_get_functiondef(p.signature::regprocedure)),
 'customer rewards changed POS, pricing, inventory, returns or quote engine');
select public.ci_assert(not exists(select * from rewards_preserved_rows except(
 select 'sales',md5(coalesce(string_agg(to_jsonb(t)::text,'' order by id),'')) from public.sales t
 union all select 'orders',md5(coalesce(string_agg(to_jsonb(t)::text,'' order by id),'')) from public.sales_orders t
 union all select 'stock',md5(coalesce(string_agg(to_jsonb(t)::text,'' order by id),'')) from public.inventory_transactions t
 union all select 'returns',md5(coalesce(string_agg(to_jsonb(t)::text,'' order by id),'')) from public.sales_returns t
 union all select 'customers',md5(coalesce(string_agg(to_jsonb(t)::text,'' order by id),'')) from public.customers t
 union all select 'members',md5(coalesce(string_agg(to_jsonb(t)::text,'' order by customer_id),'')) from public.erp_rewards_members t)),
 'installation changed historical business records');
select public.ci_assert(not has_function_privilege('authenticated','public.erp_rewards_balance(uuid)','EXECUTE'),'raw balance helper exposed');
select public.ci_assert(not has_function_privilege('authenticated','public.erp_rewards_posted_balance(uuid)','EXECUTE'),'posted helper exposed');
select public.ci_assert(not has_function_privilege('anon','public.erp_customer_rewards_snapshot()','EXECUTE'),'anonymous rewards access');
select public.ci_assert(not has_table_privilege('authenticated','public.erp_customer_rewards_orders','SELECT'),'raw reservations exposed');

begin;
do $$declare
 manager uuid:='00000000-0000-0000-0000-000000000001';
 ua uuid:='f4000000-0000-0000-0000-000000000001';ub uuid:='f4000000-0000-0000-0000-000000000002';
 ca uuid:=gen_random_uuid();cb uuid:=gen_random_uuid();loc uuid:=gen_random_uuid();
 request uuid:=gen_random_uuid();cancel_request uuid:=gen_random_uuid();failed_request uuid:=gen_random_uuid();
 legacy_request uuid:=gen_random_uuid();stock_failure uuid:=gen_random_uuid();free_request uuid:=gen_random_uuid();a_receipt text;payload jsonb;answer jsonb;retry jsonb;snapshot jsonb;
 original_sale uuid;line uuid;return_request uuid:=gen_random_uuid();before_stock integer;before_sales integer;rejected boolean;
begin
 perform set_config('request.jwt.claim.sub',manager::text,true);
 insert into auth.users(id)values(ua),(ub);
 insert into public.customers(id,name,phone)values(ca,'CI Rewards A','8015550291'),(cb,'CI Rewards B','8015550292');
 insert into public.profiles(user_id,role,customer_id)values(ua,'Customer',ca),(ub,'Customer',cb);
 insert into public.locations(id,name,can_sell)values(loc,'CI Rewards Store',true);
 insert into public.items(sku,name,category,barcode,base_unit,purchase_unit,unit_cost,selling_price)
 values('CI-REWARDS','CI rewards drink','Beverage','CI-REWARDS','each','case',1,10),
 ('CI-REWARDS-FREE','CI reward free drink','Beverage','CI-REWARDS-FREE','each','case',1,5);
 insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type)
 values('CI-REWARDS',loc,100,1,'Receipt'),('CI-REWARDS-FREE',loc,100,1,'Receipt');
 perform set_config('request.jwt.claim.sub',ua::text,true);
 perform public.ci_assert(public.erp_customer_rewards_snapshot()->>'status'='not_enrolled','absent membership auto-enrolled');
 payload:=jsonb_build_object('rewardsVersion',1,'redeemRewards',true,'name','CI pickup','phone','8015550292','customerId',cb,
  'location','CI Rewards Store','pickup',(now()+interval '1 day')::text,'discountPct',0,'discountAmount',0,
  'lines','[{"sku":"CI-REWARDS","qty":1}]'::jsonb);
 rejected:=false;begin perform public.erp_customer_rewards_checkout(failed_request,payload);exception when others then rejected:=true;end;
 perform public.ci_assert(rejected and not exists(select 1 from public.sales_orders where id=failed_request),'unenrolled redemption saved an order');
 perform public.ci_assert(not exists(select 1 from public.erp_rewards_members where customer_id=ca),'checkout enrolled by typed phone');
 perform set_config('request.jwt.claim.sub',manager::text,true);
 perform public.erp_pos_customer('8015550291','CI Rewards A');
 answer:=public.erp_pos_sale(gen_random_uuid(),loc,'[{"sku":"CI-REWARDS","qty":12}]',0,'8015550291','CI Rewards A',false,'Cash');
 perform public.ci_assert((answer->>'rewards_earned')::integer=120,'existing POS earning changed');
 a_receipt:=answer->>'receipt_no';
 perform public.erp_pos_customer('8015550292','CI Rewards B');
 perform public.erp_pos_sale(gen_random_uuid(),loc,'[{"sku":"CI-REWARDS","qty":1}]',0,'8015550292','CI Rewards B',false,'Cash');
 perform set_config('request.jwt.claim.sub',ub::text,true);
 snapshot:=public.erp_customer_rewards_snapshot();
 perform public.ci_assert(snapshot->>'status'='ready' and (snapshot->>'available')::integer=10,'customer B saw A balance');
 perform public.ci_assert(not exists(select 1 from jsonb_array_elements(snapshot->'activity')e where e->>'reference'=a_receipt),'customer B saw A activity');
 perform set_config('request.jwt.claim.sub',ua::text,true);
 select count(*) into before_sales from public.sales;select count(*) into before_stock from public.inventory_transactions;
 answer:=public.erp_customer_rewards_checkout(request,payload);
 retry:=public.erp_customer_rewards_checkout(request,payload);
 perform public.ci_assert(answer=retry,'idempotent order reply changed');
 perform public.ci_assert((select customer_id=ca from public.sales_orders where id=request),'payload customerId or pickup phone changed rewards owner');
 perform public.ci_assert((select count(*) from public.sales)=before_sales and (select count(*) from public.inventory_transactions)=before_stock,'confirmation posted stock or revenue');
 perform public.ci_assert((answer->>'discount')::numeric=5 and (answer->>'total')::numeric=5+(answer->>'tax')::numeric,'reward quote or tax changed');
 snapshot:=public.erp_customer_rewards_snapshot();
 perform public.ci_assert((snapshot->>'available')::integer=20 and (snapshot->>'posted')::integer=120 and (snapshot->>'reserved')::integer=100,'reservation or premature earning');
 rejected:=false;begin perform public.erp_customer_rewards_checkout(request,payload||'{"redeemRewards":false}');exception when others then rejected:=true;end;
 perform public.ci_assert(rejected,'changed redemption reused a request');
 perform set_config('request.jwt.claim.sub',manager::text,true);
 rejected:=false;begin perform public.erp_pos_sale(gen_random_uuid(),loc,'[{"sku":"CI-REWARDS","qty":1}]',0,'8015550291','CI Rewards A',true,'Cash');exception when others then rejected:=true;end;
 perform public.ci_assert(rejected,'POS spent reserved online points');
 perform public.erp_pickup_action(request,'prepare');
 select erp_sale_id into original_sale from public.sales_orders where id=request;
 perform public.ci_assert((select subtotal=10 and discount=5 and total=5+tax and cogs=1 and rewards_earned=5 and rewards_redeemed=100 and customer_id=ca from public.sales where id=original_sale),'sale totals, costs or points do not match quote');
 perform public.ci_assert((select count(*) from public.inventory_transactions)=before_stock+1,'sale stock posted more than once');
 perform public.erp_pickup_progress(request,'prepare');perform public.erp_pickup_progress(request,'fulfill');perform public.erp_pickup_progress(request,'fulfill');
 perform public.ci_assert((select count(*) from public.sales)=before_sales+1 and public.erp_rewards_balance(ca)=25,'repeated preparation/fulfillment duplicated sale or points');
 select id into line from public.sale_lines where sale_id=original_sale;
 perform public.process_return(return_request,line,.5,'Wrong order','Restock');
 perform public.ci_assert(public.erp_rewards_balance(ca)=72,'partial-return rounding differs from POS policy');
 perform public.process_return(return_request,line,.5,'Wrong order','Restock');
 perform public.ci_assert(public.erp_rewards_balance(ca)=72,'return retry changed points twice');
 perform public.process_return(gen_random_uuid(),line,.5,'Wrong order','Restock');
 perform public.ci_assert(public.erp_rewards_balance(ca)=120,'full return did not restore spent points/reverse earnings');
 perform set_config('request.jwt.claim.sub',ua::text,true);
 snapshot:=public.erp_customer_rewards_snapshot();
 perform public.ci_assert((select sum((e->>'points')::integer) from jsonb_array_elements(snapshot->'activity')e)=120,'activity does not reconcile to posted balance');
 perform public.erp_customer_rewards_checkout(cancel_request,payload);
 perform set_config('request.jwt.claim.sub',manager::text,true);
 perform public.erp_pickup_progress(cancel_request,'cancel');perform public.erp_pickup_action(cancel_request,'cancel');
 perform public.ci_assert(public.erp_rewards_balance(ca)=120,'cancel lost points or released twice');
 perform set_config('request.jwt.claim.sub',ua::text,true);
 retry:=public.erp_customer_rewards_checkout(cancel_request,payload);
 perform public.ci_assert(retry->>'status'='Cancelled','recovery reopened cancelled order');
 -- Definite validation failure must roll back all reservation/order writes.
 rejected:=false;begin perform public.erp_customer_rewards_checkout(failed_request,jsonb_set(payload,'{lines}','[{"sku":"NO-SUCH-ITEM","qty":1}]'));exception when others then rejected:=true;end;
 perform public.ci_assert(rejected and not exists(select 1 from public.erp_customer_rewards_orders where order_id=failed_request),'failed order held points');
 -- A failed preparation holds a reversible reservation, never a point debit.
 perform public.erp_customer_rewards_checkout(stock_failure,jsonb_set(payload,'{lines}','[{"sku":"CI-REWARDS","qty":99999}]'));
 perform set_config('request.jwt.claim.sub',manager::text,true);
 rejected:=false;begin perform public.erp_pickup_progress(stock_failure,'prepare');exception when others then rejected:=true;end;
 perform public.ci_assert(rejected and (select state='Pending' and sale_id is null from public.erp_customer_rewards_orders where order_id=stock_failure),'failed stock posting consumed reward');
 perform public.erp_pickup_progress(stock_failure,'cancel');
 perform public.ci_assert(public.erp_rewards_balance(ca)=120,'failed preparation/cancel lost points');
 -- A $5 eligible order may become free. It earns zero; a full return restores
 -- the 100 spent points under the unchanged existing POS return policy.
 perform set_config('request.jwt.claim.sub',ua::text,true);
 answer:=public.erp_customer_rewards_checkout(free_request,jsonb_set(payload,'{lines}','[{"sku":"CI-REWARDS-FREE","qty":1}]'));
 perform public.ci_assert((answer->>'total')::numeric=0 and (answer->>'tax')::numeric=0,'free reward order charged tax');
 perform set_config('request.jwt.claim.sub',manager::text,true);
 perform public.erp_pickup_progress(free_request,'fulfill');
 perform public.ci_assert(public.erp_rewards_balance(ca)=20,'free reward sale points');
 select sl.id into line from public.sale_lines sl join public.sales_orders so on so.erp_sale_id=sl.sale_id where so.id=free_request;
 perform public.process_return(gen_random_uuid(),line,1,'Wrong order','Restock');
 perform public.ci_assert(public.erp_rewards_balance(ca)=120,'free reward return lost points');
 perform set_config('request.jwt.claim.sub',ua::text,true);
 -- Existing-client orders remain recoverable through their original endpoint,
 -- and are never retroactively opted into this rewards integration.
 perform public.erp_checkout_order(legacy_request,payload-'rewardsVersion'-'redeemRewards');
 rejected:=false;begin perform public.erp_customer_rewards_checkout(legacy_request,payload);exception when others then rejected:=true;end;
 perform public.ci_assert(rejected,'old order was backfilled into rewards');
 perform set_config('request.jwt.claim.sub',manager::text,true);
 perform public.erp_pickup_progress(legacy_request,'fulfill');
 perform public.ci_assert((select s.rewards_earned=0 and s.rewards_redeemed=0 from public.sales s join public.sales_orders o on o.erp_sale_id=s.id where o.id=legacy_request),'legacy order received backfilled points');
 -- Reassigned/ambiguous profile links fail closed; staff-only APIs stay closed.
 update public.profiles set customer_id=ca where user_id=ub;
 perform set_config('request.jwt.claim.sub',ua::text,true);
 perform public.ci_assert(public.erp_customer_rewards_snapshot()->>'status'='link_review','duplicate account link exposed activity');
 rejected:=false;begin perform public.erp_pickup_progress(request,'close');exception when insufficient_privilege then rejected:=true;end;
 perform public.ci_assert(rejected,'customer could progress staff orders');
 perform set_config('request.jwt.claim.sub','',true);
 rejected:=false;begin perform public.erp_customer_rewards_snapshot();exception when insufficient_privilege then rejected:=true;end;
 perform public.ci_assert(rejected,'missing authentication exposed rewards');
end $$;
rollback;
-- Reuse the original POS assertions unchanged AFTER integration is installed.
\ir pos-loyalty.sql
select 'PASS: customer isolation, reservation/earning lifecycle, retries, cancellation, returns, original POS regression, and unchanged historical/financial/inventory engines' as result;
