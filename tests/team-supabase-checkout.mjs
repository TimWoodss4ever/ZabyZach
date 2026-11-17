import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {customizedItem,normalizeCustomerPhone,today} from '../src/domain.ts';
// Exercise the preserved team's actual handler with mocked transport, not a reimplementation.
const source=await readFile('src/App.tsx','utf8');const pos=source.slice(source.indexOf('function POS('),source.indexOf('\nfunction Orders(',source.indexOf('function POS(')));
const handler=pos.slice(pos.indexOf(' const finish=async()=>{'),pos.indexOf(' const editLine='));
const validators=source.slice(source.indexOf('type RecordSaleResult='),source.indexOf('function App(){'));
const guards=new Function(stripTypeScriptTypes(validators)+';return {isRecordSaleResult,isReturnRpcResult};')();
assert.ok(guards.isRecordSaleResult({sale_id:'s',receipt_no:'r',subtotal:10,discount:0,tax:1,total:11,cogs:4}));assert.ok(!guards.isRecordSaleResult({sale_id:'s',receipt_no:'r',total:'11'}));
assert.ok(guards.isReturnRpcResult({return_id:'r',transaction_type:'Return',refund_total:10,replacement_total:0,settlement_net:-10,settlement_mode:'Manual/Simulated'}));assert.ok(!guards.isReturnRpcResult({return_id:'r',transaction_type:'Return',refund_total:NaN,replacement_total:0,settlement_net:-10,settlement_mode:'Manual/Simulated'}));
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
function setup(overrides={}){
 const events={rpc:[],messages:[],receipts:[],cleared:0,uncertain:false,localWrites:0};
 const response={sale_id:'sale-db-1',receipt_no:'DB-001',subtotal:13.99,discount:0,tax:1.01,total:15,cogs:4.50};
 const context={checkoutBusy:false,checkoutLock:{current:false},checkoutUncertain:false,cart:[{id:'line1',sku:'2001',qty:1}],discount:0,redeemReward:false,rewardsPhone:'',location:'Provo Campus Store',customizedItem,normalizeCustomerPhone,today,isRecordSaleResult:guards.isRecordSaleResult,
  flash:m=>events.messages.push(m),setCheckoutBusy:()=>{},setCheckoutUncertain:v=>events.uncertain=v,setLastSale:v=>events.receipts.push(v),setCart:()=>events.cleared++,setDiscount:()=>{},setPickupName:()=>{},setRewardsPhone:()=>{},setRedeemReward:()=>{},setProfileOpen:()=>{},onCommit:()=>events.localWrites++,applySale:()=>{throw Error('Must not fall back to browser-only sale');},
  supabase:{from:table=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:table==='locations'?{id:'location-db-1'}:{id:'customer-db-1'},error:null})})})}),rpc:async(name,args)=>{events.rpc.push({name,args});return {data:response,error:null};}},...overrides};
 const fn=new AsyncFunction(...Object.keys(context),stripTypeScriptTypes(handler)+';return finish();');
 return {context,events,run:()=>fn(...Object.values(context))};
}
let test=setup();await Promise.all([test.run(),test.run()]);assert.equal(test.events.rpc.length,1);assert.equal(test.events.rpc[0].name,'record_sale');assert.equal(test.events.rpc[0].args.p_location,'location-db-1');assert.deepEqual(test.events.rpc[0].args.p_lines,[{sku:'2001',qty:1}]);assert.equal(test.events.receipts[0].saleId,'sale-db-1');assert.equal(test.events.receipts[0].total,15);assert.equal(test.events.localWrites,0);assert.equal(test.events.cleared,1);
test=setup({redeemReward:true});await test.run();assert.equal(test.events.rpc.length,0);assert.ok(test.events.messages.some(m=>m.includes('not supported')));
test=setup({cart:[{id:'line1',sku:'2001',qty:1,adjustments:{1003:2}}]});await test.run();assert.equal(test.events.rpc.length,0);
test=setup({discount:101});await test.run();assert.equal(test.events.rpc.length,0);
test=setup();test.context.supabase.rpc=async()=>{throw Error('connection lost');};await test.run();assert.ok(test.events.uncertain);assert.equal(test.context.checkoutLock.current,true);assert.equal(test.events.cleared,0);assert.equal(test.events.receipts.length,0);
test=setup();test.context.supabase.rpc=async()=>({data:{unexpected:true},error:null});await test.run();assert.ok(test.events.uncertain);assert.equal(test.events.cleared,0);
test=setup();test.context.supabase.rpc=async()=>({data:null,error:{message:'Stock rejected'}});await test.run();assert.equal(test.context.checkoutLock.current,false);assert.equal(test.events.cleared,0);assert.ok(test.events.messages.some(m=>m.includes('Stock rejected')));
test=setup({rewardsPhone:'8015550123'});await test.run();assert.equal(test.events.rpc[0].args.p_customer,'customer-db-1');assert.equal(test.events.localWrites,0);
console.log('PASS: latest team POS handler posts record_sale; uses server receipt; avoids local sale/double-submit; preserves unsupported-feature guards, mapped customer, rejection handling and uncertain-confirmation lock; validates receipt formats. Mock transport only, not live Supabase.');
