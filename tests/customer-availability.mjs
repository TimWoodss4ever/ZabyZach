import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {customerCartCapacityIssue,isCustomerAvailability} from '../src/customerAvailability.ts';

const product=(sku,finished,components=[])=>({sku,name:sku,category:'Pizza',unit:'each',status:'Available',available_units:finished,finished_units:finished,makeable_units:0,components});
const part=(sku,quantity,stock)=>({sku,name:sku,category:'Ingredient',unit:'oz',quantity_per_item:quantity,available_units:stock,status:'Available'});
const items=[product('P1',1,[part('CHEESE',2,6),part('SAUCE',1,2)]),product('P2',0,[part('CHEESE',3,6)])];
assert.equal(customerCartCapacityIssue([{sku:'P1',qty:2}],items,'Provo'),null,'finished stock is used before recipe stock');
assert.equal(customerCartCapacityIssue([{sku:'P1',qty:2},{sku:'P2',qty:1}],items,'Provo'),null,'shared component demand is combined across cart lines');
assert.match(customerCartCapacityIssue([{sku:'P1',qty:2},{sku:'P2',qty:2}],items,'Provo')??'',/CHEESE/,'shared component shortage blocks the combined cart');
assert.match(customerCartCapacityIssue([{sku:'UNKNOWN',qty:1}],items,'Orem',()=> 'Pizza')??'',/Orem/,'missing location data is not treated as available');
assert.match(customerCartCapacityIssue([{sku:'P1',qty:0}],items,'Provo')??'',/quantities/,'invalid quantities are rejected');

const valid={location:'Provo',as_of:new Date().toISOString(),refresh_seconds:15,products:items,ingredients:[],low_rule:'rule'};
assert.equal(isCustomerAvailability(valid),true,'valid payload is accepted');
assert.equal(isCustomerAvailability({...valid,products:[{...items[0],finished_units:undefined}]}),false,'missing stock data is rejected');

const migration=await readFile('supabase/migrations/202611210001_customer_availability.sql','utf8');
assert.match(migration,/auth\.uid\(\) is null or public\.current_role\(\) is distinct from 'Customer'/,'availability RPC validates authenticated customer role');
assert.match(migration,/where t\.location_id=loc\.id and t\.occurred_at<=statement_timestamp\(\)/,'current stock is location-scoped and excludes future transactions');
assert.match(migration,/greatest\(0,coalesce\(sum\(t\.quantity\),0\)\)/,'negative ledger balances are unavailable');
assert.match(migration,/erp_history_usage\(today-179,today,loc\.id\)/,'low stock uses location-specific usage');
assert.match(migration,/revoke all on function public\.erp_customer_availability\(text\)/,'RPC defaults are explicitly revoked');
assert.match(migration,/grant execute on function public\.erp_customer_availability\(text\)/,'only authenticated callers receive RPC execution');
assert.match(migration,/regexp_matches\(original,staff_pattern,'gi'\)/,'existing checkout hotfix is reapplied with formatting-tolerant matching');
assert.match(migration,/o\.created_by is distinct from auth\.uid\(\)/,'legacy checkout wrapper validation remains guarded');
assert.match(migration,/existing\.created_by is distinct from auth\.uid\(\)/,'current checkout creator validation checks order ownership');
assert.match(migration,/name<>'Central Commissary'/,'commissary is excluded from customer pickup choices');
assert.doesNotMatch(migration,/create\s+or\s+replace\s+function\s+public\.erp_checkout_order/i,'migration does not replace or rewrite checkout');

const app=await readFile('src/App.tsx','utf8');
assert.match(app,/setInterval\(refreshWhenVisible,15000\)/,'visibility polling is bounded to fifteen seconds');
assert.match(app,/request!==availabilityRequest\.current/,'late responses are ignored');
assert.match(app,/erp_customer_pickup_locations/,'pickup choices come from can-sell locations');
assert.match(app,/Stock is checked again when you place the order/,'customer copy explains server checkout revalidation');

console.log('PASS: shared cart component demand, finished-stock priority, missing-data blocking, role/location-safe RPC shape, polling and checkout revalidation.');
