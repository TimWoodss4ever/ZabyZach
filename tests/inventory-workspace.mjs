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
assert.equal(usage.SAUCE.a,198);assert.equal(usage.SAUCE.b,360);assert(Math.abs(reorderLevel(items[2],usage,'a',2)-7.7)<1e-9);assert.equal(reorderLevel(items[2],usage,'b',2),14);
assert.equal(reorderLevel(items[2],{},'a',2),null,'no invented daily usage');assert.equal(reorderLevel({...items[2],supplierActive:false},usage,'a',2),null);assert.equal(reorderLevel(items.at(-1),usage,'a',2),null);
assert.equal(itemNeedsAttention(snapshot,items[2],usage,['a'],2),false);assert.equal(itemNeedsAttention(snapshot,items[2],usage,['a','c'],2),true,'another store’s healthy stock must not conceal a shortage');assert.equal(itemNeedsAttention(snapshot,items.at(-1),{},['c'],2),false,'unprepared menu items are not empty ingredient bins');
assert.equal(usageStart('2026-11-16'),'2026-05-20T00:00:00.000Z');

const source=await readFile('src/InventoryWorkspaceData.ts','utf8');
const loaderCode=stripTypeScriptTypes(source.slice(source.indexOf('export async function readInventoryWorkspace'),source.indexOf('// One refresh owner'))).replace('export ','');
const calls=[];const rows=Array.from({length:1001},()=>({item_sku:'SAUCE',location_id:'a',quantity:-1,transaction_type:'Sale'}));
const client={rpc:async()=>({data:snapshot,error:null}),from(table){let start=0,end=999;const q={select(){return table==='items'?Promise.resolve({data:items.map(i=>({sku:i.sku,unit_cost:i.cost})),error:null}):table==='bom_lines'?Promise.resolve({data:items.flatMap(i=>Object.entries(i.recipe).map(([component_sku,quantity])=>({parent_sku:i.sku,component_sku,quantity}))),error:null}):q;},lt(k,v){calls.push(['lt',k,v]);return q;},gte(k,v){calls.push(['gte',k,v]);return q;},order(){return q;},range(a,b){start=a;end=b;calls.push(['range',a,b]);return Promise.resolve({data:rows.slice(start,end+1),error:null});}};return q;}};
const makeLoader=client=>new Function('supabase','validateInventorySnapshot','summarizeUsage','usageStart',loaderCode+';return readInventoryWorkspace;')(client,validateInventorySnapshot,summarizeUsage,usageStart);
const loaded=await makeLoader(client)('manager');assert.equal(loaded.usage.SAUCE.a,1001);assert.equal(loaded.items.at(-1).recipe.DOUGH,1);assert(calls.some(c=>c[0]==='range'&&c[1]===1000));assert(calls.some(c=>c[0]==='gte'&&c[2]===usageStart(snapshot.today)));
await assert.rejects(makeLoader({...client,rpc:async()=>({data:null,error:{message:'Offline'}})})('manager'),/Offline/);await assert.rejects(makeLoader(client)('other-account'),/account changed/);

// Exercise the actual refresh hook without timers or a browser: one owner, queued writes,
// hidden-tab pause, account ownership, errors preserving old data, and unmount cleanup.
const hookCode=stripTypeScriptTypes(source.slice(source.indexOf('export function useInventoryWorkspace'))).replace('export ','');
let cleanup,timer,cleared=false,visible='visible',requests=[],states=[],cursor=0;const winEvents={},docEvents={};
const win={setInterval(fn){timer=fn;return 1;},clearInterval(){cleared=true;},addEventListener(k,fn){winEvents[k]=fn;},removeEventListener(k){delete winEvents[k];}};
const doc={get visibilityState(){return visible;},addEventListener(k,fn){docEvents[k]=fn;},removeEventListener(k){delete docEvents[k];}};
const useState=initial=>{const index=cursor++;states[index]=initial;return[initial,value=>{states[index]=value;}];};
const hook=new Function('useEffect','useRef','useState','readInventoryWorkspace','window','document',hookCode+';return useInventoryWorkspace;')(fn=>{cleanup=fn();},value=>({current:value}),useState,userId=>new Promise((resolve,reject)=>requests.push({userId,resolve,reject})),win,doc);
const api=hook('manager');assert.equal(requests.length,1);api.refresh();winEvents['erp-inventory-updated']();requests[0].resolve({snapshot:'old'});await new Promise(setImmediate);assert.equal(requests.length,2,'writes during a read must queue a new read');requests[1].resolve(loaded);await new Promise(setImmediate);assert.equal(states[0],loaded);assert.equal(states[1],false);
visible='hidden';timer();assert.equal(requests.length,2);visible='visible';docEvents.visibilitychange();assert.equal(requests.length,3);requests[2].reject(Error('Disconnected'));await new Promise(setImmediate);assert.equal(states[0],loaded);assert.equal(states[2],'Disconnected');
winEvents.focus();assert.equal(requests.length,4);cleanup();requests[3].resolve({snapshot:'must not appear'});await new Promise(setImmediate);assert.equal(states[0],loaded);assert(cleared);assert.deepEqual(winEvents,{});assert.deepEqual(docEvents,{});
console.log('PASS: per-location recorded usage and supplier reorder levels, no usage fallbacks, nested ingredient capacity with produced dough, paginated reads, shared Stock/Backorders refresh, queued-write refresh, hidden-tab behavior, failure preservation and cleanup. Mocked transport; no live writes.');
