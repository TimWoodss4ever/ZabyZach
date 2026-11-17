import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {customizedItem,normalizeCustomerPhone} from '../src/domain.ts';
const source=await readFile('src/App.tsx','utf8');
const pos=source.slice(source.indexOf('function POS('),source.indexOf('function CameraScanner('));
const handler=pos.slice(pos.indexOf(' const finish=async()=>{'),pos.indexOf(' const editLine='));
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
function setup(overrides={}){
 const events={sent:[],accepted:[],messages:[]};
 const context={checkoutBusy:false,checkoutLock:{current:false},checkoutUncertain:false,pending:null,cart:[{id:'1',sku:'2001',qty:1}],discount:0,rewardsPhone:'',phoneValid:false,customerLoading:false,customerError:'',pickupName:'',redeemReward:false,canRedeem:false,customizedItem,normalizeCustomerPhone,location:'Provo Campus Store',
 flash:m=>events.messages.push(m),setRedeemReward:()=>{},setCheckoutBusy:()=>{},setCheckoutUncertain:()=>{},setPending:()=>{},readPendingPosSale:()=>null,
 postPosSale:async payload=>{events.sent.push(payload);return {receipt_no:'DB-1'};},acceptReceipt:(r,t)=>events.accepted.push({r,t}),...overrides};
 const fn=new AsyncFunction(...Object.keys(context),stripTypeScriptTypes(handler)+';return finish();');return {context,events,run:()=>fn(...Object.values(context))};
}
let test=setup();await Promise.all([test.run(),test.run()]);assert.equal(test.events.sent.length,1);assert.equal(test.events.accepted[0].r.receipt_no,'DB-1');
for(const overrides of [{pending:{}},{checkoutUncertain:true},{discount:101},{rewardsPhone:'123'},{rewardsPhone:'8015550123',phoneValid:true,customerLoading:true},{rewardsPhone:'8015550123',phoneValid:true,pickupName:''},{redeemReward:true,canRedeem:false},{cart:[{sku:'2001',qty:1,adjustments:{1003:2}}]}]){test=setup(overrides);await test.run();assert.equal(test.events.sent.length,0,JSON.stringify(overrides));}
test=setup({rewardsPhone:'8015550123',phoneValid:true,pickupName:'Andrew',redeemReward:true,canRedeem:true});await test.run();assert.equal(test.events.sent[0].redeem,true);assert.equal(test.events.sent[0].name,'Andrew');
test=setup({postPosSale:async()=>{throw Error('Stock rejected');}});await test.run();assert.equal(test.events.accepted.length,0);assert.ok(test.events.messages.some(m=>m.includes('Stock rejected')));assert.equal(test.context.checkoutLock.current,false);
console.log('PASS: actual POS handler prevents duplicate clicks, blocks pending/invalid orders and unsupported customization, submits shared rewards and uses the server receipt.');
