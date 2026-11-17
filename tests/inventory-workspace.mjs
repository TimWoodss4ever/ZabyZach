import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {canMake,itemNeedsAttention,reorderLevel,stockedItem,summarizeUsage,usageStart} from '../src/inventoryWorkspaceLogic.ts';
import {validateInventorySnapshot} from '../src/inventoryManagement.ts';
const item=(sku,category='Ingredient',recipe={})=>({sku,name:sku,barcode:sku,category,unit:'each',active:true,made:Object.keys(recipe).length>0,supplier:'Supplier',supplierActive:true,leadDays:5,cost:1,recipe});
const items=[item('FLOUR'),item('DOUGH','Ingredient',{FLOUR:2}),item('SAUCE'),item('DIP','Sides',{SAUCE:2}),item('PIZZA','Pizza',{DOUGH:1,SAUCE:1,DIP:1})];
const snapshot={version:1,userId:'manager',today:'2026-11-16',items,locations:[{id:'a',name:'Store A'},{id:'b',name:'Store B'},{id:'c',name:'Commissary'}],stock:[{item_sku:'DOUGH',location_id:'a',on_hand:10},{item_sku:'FLOUR',location_id:'a',on_hand:1000},{item_sku:'SAUCE',location_id:'a',on_hand:8},{item_sku:'DOUGH',location_id:'b',on_hand:2},{item_sku:'SAUCE',location_id:'b',on_hand:30}],incoming:[],backorders:[]};
assert.equal(stockedItem(items[1]),true);assert.equal(stockedItem(items.at(-1)),false);
assert.equal(canMake(snapshot,items,'PIZZA','a'),2,'shared sauce in nested recipes must be combined');
assert.equal(canMake(snapshot,items,'PIZZA','b'),2,'one store cannot use another store’s dough');
assert.equal(canMake({...snapshot,stock:snapshot.stock.filter(s=>s.item_sku!=='DOUGH')},items,'PIZZA','a'),0,'flour cannot stand in for unproduced dough');
assert.equal(canMake(snapshot,[...items.filter(i=>i.sku!=='PIZZA'),item('PIZZA','Pizza',{PIZZA:1})],'PIZZA','a'),null);
const usage=summarizeUsage([{item_sku:'SAUCE',location_id:'a',quantity:-180,transaction_type:'Sale'},{item_sku:'SAUCE',location_id:'b',quantity:-360,transaction_type:'Production Issue'},{item_sku:'SAUCE',location_id:'a',quantity:-18,transaction_type:'Backorder Fulfillment'},{item_sku:'SAUCE',location_id:'a',quantity:-500,transaction_type:'Waste'},{item_sku:'SAUCE',location_id:'a',quantity:-500,transaction_type:'Transfer Out'},{item_sku:'SAUCE',location_id:'a',quantity:500,transaction_type:'Receipt'}]);
assert.equal(usage.SAUCE.a,198);assert.equal(usage.SAUCE.b,360);assert.equal(reorderLevel(items[2],usage,'a',2),8);assert.equal(reorderLevel(items[2],usage,'b',2),14);assert(Math.abs(reorderLevel({...items[2],unit:'oz'},usage,'a',2)-7.7)<1e-9);
assert.equal(reorderLevel(items[2],{},'a',2),null,'no invented daily usage');assert.equal(reorderLevel({...items[2],supplierActive:false},usage,'a',2),null);assert.equal(reorderLevel(items.at(-1),usage,'a',2),null);
assert.equal(itemNeedsAttention(snapshot,items[2],usage,['a'],2),false);assert.equal(itemNeedsAttention(snapshot,items[2],usage,['a','c'],2),true,'another store’s healthy stock must not conceal a shortage');assert.equal(itemNeedsAttention(snapshot,items.at(-1),{},['c'],2),false,'unprepared menu items are not empty ingredient bins');
assert.equal(usageStart('2026-11-16'),'2026-05-20T00:00:00.000Z');

const source=await readFile('src/InventoryWorkspaceData.ts','utf8');
const functionsEnd=source.indexOf('// One refresh owner');
const timingCode=stripTypeScriptTypes(source.slice(source.indexOf('const timed='),source.indexOf('export async function readInventoryWorkspace')));
const loaderCode=stripTypeScriptTypes(source.slice(source.indexOf('export async function readInventoryWorkspace'),source.indexOf('export async function readInventoryWorkspaceUsage'))).replace('export ','');
const usageLoaderCode=stripTypeScriptTypes(source.slice(source.indexOf('export async function readInventoryWorkspaceUsage'),functionsEnd)).replace('export ','');
const calls=[],rpcCalls=[],aggregate=[{item_sku:'SAUCE',location_id:'a',quantity:-25001,transaction_type:'Sale'}],sample=[{item_sku:'SAUCE',location_id:'a',quantity:-9,transaction_type:'Sale'}];
const client={rpc:async(name,args)=>{calls.push(name);rpcCalls.push([name,args]);return{data:name==='erp_inventory_snapshot'?snapshot:name==='erp_inventory_recorded_usage'?aggregate:sample,error:null};},from(table){const q={select(){return table==='items'?Promise.resolve({data:items.map(i=>({sku:i.sku,unit_cost:i.cost})),error:null}):Promise.resolve({data:items.flatMap(i=>Object.entries(i.recipe).map(([component_sku,quantity])=>({parent_sku:i.sku,component_sku,quantity}))),error:null});}};return q;}};
const makeLoader=client=>new Function('supabase','validateInventorySnapshot','summarizeUsage','usageStart',timingCode+loaderCode+';return readInventoryWorkspace;')(client,validateInventorySnapshot,summarizeUsage,usageStart);
const makeUsageLoader=client=>new Function('supabase','summarizeUsage','usageStart',timingCode+usageLoaderCode+';return readInventoryWorkspaceUsage;')(client,summarizeUsage,usageStart);
const stageLogs=[],originalDebug=console.debug;console.debug=(...args)=>{if(String(args[0]).includes(' stage timings (ms)'))stageLogs.push(args[1]);};
let essential,loaded;try{essential=await makeLoader(client)('manager');loaded=await makeUsageLoader(client)(snapshot.today);}finally{console.debug=originalDebug;}
assert.equal(essential.snapshot,snapshot);assert.equal(essential.usage,null);assert.equal(essential.usageLoading,true,'essential stock is published before usage');assert.match(essential.usageError,/loading/);
assert.equal(loaded.usage.SAUCE.a,25010,'the server aggregate must include large real-ledger totals and sample usage');assert.equal(essential.items.at(-1).recipe.DOUGH,1);
assert.deepEqual(calls,['erp_inventory_snapshot','erp_inventory_recorded_usage','erp_inventory_sample_usage']);assert.deepEqual(rpcCalls.find(([name])=>name==='erp_inventory_recorded_usage')[1],{p_since:usageStart(snapshot.today)});assert(!calls.includes('inventory_transactions'));
assert.equal(stageLogs.length,2);for(const stage of ['erp_inventory_snapshot','items_costs','bom_lines','total'])assert(Number.isFinite(stageLogs[0][stage]),`essential timing missing for ${stage}`);for(const stage of ['erp_inventory_recorded_usage','erp_inventory_sample_usage','total'])assert(Number.isFinite(stageLogs[1][stage]),`usage timing missing for ${stage}`);
const sampleFailure=await makeUsageLoader({...client,rpc:async(name)=>name==='erp_inventory_sample_usage'?{data:null,error:{message:'statement timeout'}}:{data:aggregate,error:null}})(snapshot.today);
assert.equal(sampleFailure.usage,null);assert.match(sampleFailure.usageError,/Sample usage unavailable.*statement timeout/);
const ledgerFailure=await makeUsageLoader({...client,rpc:async(name)=>name==='erp_inventory_recorded_usage'?{data:null,error:{message:'statement timeout'}}:{data:sample,error:null}})(snapshot.today);
assert.equal(ledgerFailure.usage,null);assert.match(ledgerFailure.usageError,/Recorded usage unavailable.*statement timeout/);
await assert.rejects(makeLoader({...client,rpc:async()=>({data:null,error:{message:'Offline'}})})('manager'),/Offline/);await assert.rejects(makeLoader(client)('other-account'),/account changed/);

// Exercise the actual refresh hook without timers or a browser: one owner, queued writes,
// hidden-tab pause, account ownership, errors preserving old data, and unmount cleanup.
const hookCode=stripTypeScriptTypes(source.slice(source.indexOf('export function useInventoryWorkspace'))).replace('export ','');
let cleanup,timer,cleared=false,visible='visible',requests=[],states=[],cursor=0;const winEvents={},docEvents={};
const win={setInterval(fn){timer=fn;return 1;},clearInterval(){cleared=true;},addEventListener(k,fn){winEvents[k]=fn;},removeEventListener(k){delete winEvents[k];}};
const doc={get visibilityState(){return visible;},addEventListener(k,fn){docEvents[k]=fn;},removeEventListener(k){delete docEvents[k];}};
const useState=initial=>{const index=cursor++;states[index]=initial;return[initial,value=>{states[index]=typeof value==='function'?value(states[index]):value;}];};
const usageRequests=[];
const hook=new Function('useEffect','useRef','useState','readInventoryWorkspace','readInventoryWorkspaceUsage','window','document',hookCode+';return useInventoryWorkspace;')(fn=>{cleanup=fn();},value=>({current:value}),useState,userId=>new Promise((resolve,reject)=>requests.push({userId,resolve,reject})),today=>new Promise((resolve,reject)=>usageRequests.push({today,resolve,reject})),win,doc);
const api=hook('manager');assert.equal(requests.length,1);api.refresh();winEvents['erp-inventory-updated']();requests[0].resolve(essential);await new Promise(setImmediate);assert.equal(states[0],essential,'the hook publishes stock before waiting on usage');assert.equal(usageRequests.length,1);
usageRequests[0].resolve(loaded);await new Promise(setImmediate);assert.equal(states[0].usage.SAUCE.a,25010);assert.equal(requests.length,2,'writes during a read queue a new read');requests[1].resolve(essential);await new Promise(setImmediate);assert.equal(usageRequests.length,2);
usageRequests[1].resolve({usage:null,usageError:'Sample usage unavailable: statement timeout',usageLoading:false});await new Promise(setImmediate);assert.equal(states[0].snapshot,essential.snapshot);assert.equal(states[0].usage,null);assert.equal(states[0].usageLoading,false);assert.equal(states[0].usageError,'Sample usage unavailable: statement timeout');assert.equal(states[1],false);
visible='hidden';timer();assert.equal(requests.length,2);visible='visible';docEvents.visibilitychange();assert.equal(requests.length,3);requests[2].reject(Error('Disconnected'));await new Promise(setImmediate);assert.equal(states[0].snapshot,essential.snapshot);assert.equal(states[2],'Disconnected');
winEvents.focus();assert.equal(requests.length,4);cleanup();requests[3].resolve({snapshot:'must not appear'});await new Promise(setImmediate);assert.equal(states[0].snapshot,essential.snapshot);assert(cleared);assert.deepEqual(winEvents,{});assert.deepEqual(docEvents,{});
console.log('PASS: per-location recorded usage and supplier reorder levels, unavailable-usage guards, nested ingredient capacity with produced dough, large server-side aggregates, split timing, stock-first rendering, supplementary-failure preservation, shared Stock/Backorders refresh, queued-write refresh, hidden-tab behavior, and cleanup. Mocked transport; no live writes.');
