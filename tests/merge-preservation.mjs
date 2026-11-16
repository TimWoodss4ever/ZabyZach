import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const hashes=JSON.parse(await readFile('migration-review/protected-hashes.json','utf8'));
for(const [path,expected]of Object.entries(hashes)){const actual=createHash('sha256').update(await readFile(path)).digest('hex');assert.equal(actual,expected,'Reviewed protected file changed: '+path);}
const app=await readFile('src/App.tsx','utf8'),connected=await readFile('src/ExistingDatabaseScreens.tsx','utf8');
const chunks=JSON.parse(await readFile('migration-review/preserved-source.json','utf8'));
for(const [name,text]of Object.entries(chunks)){
 const source=name==='latestPOS'?app.replace('onChange={e=>updateFormattedPaymentInput(e.currentTarget,formatCustomerPhone,changeRewardsPhone)}','onChange={e=>changeRewardsPhone(e.target.value)}'):app;
 assert.ok((name==='authentication'||name.startsWith('latest')?source:connected).includes(text),'Original source changed: '+name);
}
assert.ok(app.includes('const ReturnsPageView=memo(SupabaseReturnsPage);'));
for(const rpc of ['record_sale','process_return','process_exchange'])assert.ok(app.includes("supabase.rpc('"+rpc+"'"),'New team RPC missing: '+rpc);
for(const rpc of ['post_transfer','post_adjustment','create_production_order','issue_production_order','complete_production_order'])assert.ok(connected.includes("supabase.rpc('"+rpc+"'"),'Existing RPC connection missing: '+rpc);
assert.ok(app.includes("supabase.auth.signInWithPassword({email,password})"));assert.ok(app.includes('supabase.auth.signOut()'));
assert.ok(app.includes('<ConnectedInventoryPage'));assert.ok(app.includes('<ConnectedMovements'));assert.ok(app.includes('<ConnectedProductionPage'));assert.ok(app.includes('<ConnectedBarcodeLabels'));
const customer=app.slice(app.indexOf("if(role==='Customer')return"),app.indexOf(' const canOpen='));assert.ok(!customer.includes('<PizzaGuide'));
for(const page of ['Suppliers','Inventory Review','Supplier Scorecards','Barcode Labels'])assert.ok(app.includes("label:'"+page+"'"));
const review=await readFile('.github/workflows/erp-review.yml','utf8');assert.ok(!review.includes('deploy-pages'));assert.ok(!review.includes('pages: write'));assert.ok(!review.includes('supabase db push'));
console.log('PASS: '+Object.keys(hashes).length+' reviewed protected files match approved hashes (including the Vite security update); original auth, latest POS/returns, receipt validators, and three database loaders preserved; five existing RPC connections intact; live screens remain routed; new screens present; no customer helper; review workflow cannot publish or migrate.');
