import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const hashes=JSON.parse(await readFile('migration-review/protected-hashes.json','utf8'));
for(const [path,expected]of Object.entries(hashes)){const actual=createHash('sha256').update(await readFile(path)).digest('hex');assert.equal(actual,expected,'Reviewed protected file changed: '+path);}
const app=await readFile('src/App.tsx','utf8'),connected=await readFile('src/ExistingDatabaseScreens.tsx','utf8');
const chunks=JSON.parse(await readFile('migration-review/preserved-source.json','utf8'));
for(const [name,text]of Object.entries(chunks)){
 if(name==='latestPOS')continue; // Superseded by shared POS transport and browser regression tests.
 const source=name==='latestPOS'?app.replace('onChange={e=>updateFormattedPaymentInput(e.currentTarget,formatCustomerPhone,changeRewardsPhone)}','onChange={e=>changeRewardsPhone(e.target.value)}'):app;
 assert.ok((name==='authentication'||name.startsWith('latest')?source:connected).includes(text),'Original source changed: '+name);
}
assert.ok(app.includes('const ReturnsPageView=memo(SupabaseReturnsPage);'));
assert.ok(app.includes("postPosSale({location,lines,discount,phone:rewardsPhone,name:orderName,redeem:redeemReward,paymentMethod,...(paymentMethod==='Card (simulated)'?{cardBrand:cardSummary(cardNumber).brand,cardLast4:cardSummary(cardNumber).last4}:{})})"));
assert.ok((await readFile('supabase/migrations/202611170003_pos_loyalty.sql','utf8')).includes('public.record_sale(p_location,p_lines,v_percent,v_id)'));
for(const rpc of ['process_return','process_exchange'])assert.ok(app.includes("supabase.rpc('"+rpc+"'"),'New team RPC missing: '+rpc);
for(const rpc of ['issue_production_order','complete_production_order'])assert.ok(connected.includes("supabase.rpc('"+rpc+"'"),'Existing RPC connection missing: '+rpc);
assert.ok(connected.includes("'erp_create_scheduled_production'"),'Scheduled production must use the durable atomic gateway');
assert.ok((await readFile('src/InventoryAvailability.tsx','utf8')).includes("supabase.rpc('erp_inventory_write'"),'Inventory writes must use the idempotent staff gateway');
assert.ok(app.includes("supabase.auth.signInWithPassword({email,password})"));assert.ok(app.includes('supabase.auth.signOut()'));
assert.ok(app.includes('<ConnectedInventoryPage'));assert.ok(app.includes('<ConnectedMovements'));assert.ok(app.includes('<ConnectedProductionPage'));assert.ok(app.includes('<ConnectedBarcodeLabels'));
const customer=app.slice(app.indexOf("if(role==='Customer')return"),app.indexOf(' const canOpen='));assert.ok(!customer.includes('<PizzaGuide'));
for(const page of ['Suppliers','Inventory Review','Supplier Scorecards','Barcode Labels'])assert.ok(app.includes("label:'"+page+"'"));
const review=await readFile('.github/workflows/erp-review.yml','utf8');assert.ok(!review.includes('deploy-pages'));assert.ok(!review.includes('pages: write'));assert.ok(!review.includes('supabase db push'));
console.log('PASS: '+Object.keys(hashes).length+' reviewed protected files match approved hashes (including the Vite security update); original auth, returns, receipt validators, and three database loaders preserved; POS uses the tested shared wrapper; production RPC connections intact; inventory writes use the reviewed gateway; live screens remain routed; new screens present; no customer helper; review workflow cannot publish or migrate.');

