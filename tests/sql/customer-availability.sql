-- DISPOSABLE CI DATABASE ONLY. Never run this fixture in Supabase.
\set ON_ERROR_STOP on
begin;
do $$
declare
 loc_a uuid:=gen_random_uuid();loc_b uuid:=gen_random_uuid();request_id uuid:=gen_random_uuid();
 answer jsonb;other jsonb;after_checkout jsonb;checkout_payload jsonb;checkout_answer jsonb;checkout_again jsonb;bad boolean;
begin
 insert into public.locations(id,name,can_sell) values(loc_a,'Availability test A',true),(loc_b,'Availability test B',true);
 insert into public.items(sku,name,category,barcode,base_unit,purchase_unit,conversion_factor,unit_cost,selling_price,lead_days,active) values
  ('CA-DOUGH','Availability test prepared dough','Ingredient','CA-DOUGH','each','each',1,0,0,0,true),
  ('CA-FLOUR','Availability test flour','Ingredient','CA-FLOUR','oz','bag',800,.01,0,7,true),
  ('CA-CHEESE','Availability test cheese','Ingredient','CA-CHEESE','oz','bag',80,.1,0,3,true),
  ('CA-TOP','Availability test topping','Ingredient','CA-TOP','oz','bag',80,.1,0,3,true),
  ('CA-PIE1','Availability test pie one','Pizza','CA-PIE1','each','each',1,1,12,0,true),
  ('CA-PIE2','Availability test pie two','Pizza','CA-PIE2','each','each',1,1,14,0,true),
  ('CA-PIE3','Availability test pie topping','Pizza','CA-PIE3','each','each',1,1,13,0,true),
  ('CA-DRINK','Availability test drink','Beverage','CA-DRINK','each','case',24,.2,2,2,true),
  ('CA-FINISHED','Availability test finished pie','Pizza','CA-FINISHED','each','each',1,1,12,0,true);
 insert into public.bom_lines(parent_sku,component_sku,quantity) values
  ('CA-DOUGH','CA-FLOUR',9),('CA-PIE1','CA-DOUGH',1),('CA-PIE1','CA-CHEESE',2),
  ('CA-PIE2','CA-DOUGH',1),('CA-PIE2','CA-CHEESE',3),
  ('CA-PIE3','CA-DOUGH',1),('CA-PIE3','CA-TOP',1);
 insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type,occurred_at) values
  ('CA-DOUGH',loc_a,3,0,'Receipt',now()-interval '1 day'),('CA-CHEESE',loc_a,6,0,'Receipt',now()-interval '1 day'),
  ('CA-TOP',loc_a,2,0,'Receipt',now()-interval '1 day'),('CA-TOP',loc_a,-3,0,'Adjustment',now()-interval '1 hour'),
  ('CA-FLOUR',loc_a,100,0,'Receipt',now()-interval '1 day'),('CA-FINISHED',loc_a,1,1,'Production Receipt',now()-interval '1 day'),
  ('CA-CHEESE',loc_b,10,0,'Receipt',now()-interval '1 day'),('CA-FLOUR',loc_b,100,0,'Receipt',now()-interval '1 day'),
  ('CA-TOP',loc_b,2,0,'Receipt',now()-interval '1 day'),('CA-DRINK',loc_b,2,.2,'Receipt',now()-interval '1 day'),
  ('CA-DRINK',loc_a,20,.2,'Receipt',now()+interval '1 day');

 perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
 execute 'set local role authenticated';
 perform public.erp_customer_availability_options_save(1,2,1);
 execute 'reset role';

 -- Exercise the real RPC as an authenticated Customer, not as the database owner.
 perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000003',true);
 execute 'set local role authenticated';
 answer:=public.erp_customer_availability('Availability test A');
 other:=public.erp_customer_availability('Availability test B');
 perform public.ci_assert(answer->>'location'='Availability test A','wrong selected location returned');
 perform public.ci_assert((answer->>'as_of') is not null,'freshness timestamp missing');
 perform public.ci_assert((select x->>'status'='Available' and (x->>'makeable_units')::int=3 and (x->>'finished_units')::int=0
   from jsonb_array_elements(answer->'products') x where x->>'sku'='CA-PIE1'),'recipe capacity did not use the direct prepared dough and component quantities');
 perform public.ci_assert((select x->>'status'='Unavailable' and (x->>'available_units')::int=0
   from jsonb_array_elements(answer->'products') x where x->>'sku'='CA-PIE3'),'negative topping stock was not unavailable');
 perform public.ci_assert((select x->>'status'='Unavailable'
   from jsonb_array_elements(answer->'products') x where x->>'sku'='CA-DRINK'),'future receipt counted as current stock');
 perform public.ci_assert((select x->>'status'='Low stock'
   from jsonb_array_elements(answer->'ingredients') x where x->>'sku'='CA-CHEESE'),'configured recipe-serving fallback did not produce Low stock');
 perform public.ci_assert((select x->>'status'='Unavailable' and (x->>'available_units')::int=0
   from jsonb_array_elements(other->'products') x where x->>'sku'='CA-PIE1'),'raw flour was incorrectly counted as prepared dough or inventory was pooled across stores');
 perform public.ci_assert((select x->>'status'='Available'
   from jsonb_array_elements(other->'products') x where x->>'sku'='CA-DRINK'),'second store stock not reflected');
 checkout_payload:=jsonb_build_object('name','Availability checkout','phone','8015550199',
  'location','Availability test B','pickup',to_char((now() at time zone 'America/Denver')::date+2,'YYYY-MM-DD')||'T17:00:00 America/Denver',
  'lines',jsonb_build_array(jsonb_build_object('sku','CA-DRINK','qty',1)));
 checkout_answer:=public.erp_checkout_order(request_id,checkout_payload);
 checkout_again:=public.erp_checkout_order(request_id,checkout_payload);
 perform public.ci_assert(checkout_answer->>'orderNo'=checkout_again->>'orderNo'
  and checkout_answer->>'total'=checkout_again->>'total'
  and checkout_answer->>'sale_id' is null and checkout_again->>'sale_id' is null,
  'customer checkout retry changed its unprepared order');
 perform public.ci_assert(jsonb_array_length(coalesce(checkout_again->'lines','[]'::jsonb))=1,
  'customer checkout retry duplicated its order lines');
 after_checkout:=public.erp_customer_availability('Availability test B');
 perform public.ci_assert((select (x->>'available_units')::int=1 from jsonb_array_elements(after_checkout->'products') x where x->>'sku'='CA-DRINK'),
  'confirmed customer order was not reserved from available stock exactly once');
 bad:=false;begin perform public.erp_customer_availability_options_read();exception when insufficient_privilege then bad:=true;end;
 perform public.ci_assert(bad,'Customer could read manager availability settings');
 bad:=false;begin perform public.post_adjustment('CA-CHEESE',loc_a,10,'customer permission probe');exception when insufficient_privilege then bad:=true;end;
 perform public.ci_assert(bad,'Customer accessed a staff inventory write endpoint');
 bad:=false;begin perform public.erp_customer_availability('Central Commissary');exception when invalid_parameter_value then bad:=true;end;
 perform public.ci_assert(bad,'non-pickup location accepted');
 bad:=false;begin perform public.erp_checkout_post_sale(null,'[]'::jsonb,0,0,null);exception when insufficient_privilege then bad:=true;end;
 perform public.ci_assert(bad,'Customer directly executed private checkout posting helper');
 execute 'reset role';

 perform public.ci_assert(not has_function_privilege('anon','public.erp_customer_availability(text)','execute'),'anonymous availability RPC execution granted');
 perform public.ci_assert(not has_function_privilege('authenticated','public.erp_checkout_post_sale(uuid,jsonb,numeric,numeric,uuid)','execute'),'private checkout helper execution granted');
end $$;
rollback;
\echo 'PASS: authenticated customer RPC, configured low rule, location isolation, negative/future stock, prepared dough, product capacity, manager-only options and private checkout helper.'
