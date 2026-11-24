import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import {keepIfSame,sameJson} from '../src/silentRefresh.ts';

assert.equal(sameJson({a:[1,2]},{a:[1,2]}),true);
const old={x:1};assert.equal(keepIfSame(old,{x:1}),old,'unchanged data keeps the same object so React does not re-render');
assert.deepEqual(keepIfSame(old,{x:2}),{x:2});assert.deepEqual(keepIfSame(null,{x:3}),{x:3});

// ---- run the real useSharedPlan hook against a fake database ----
const src=await readFile('src/SharedPlanningData.ts','utf8');
const js=ts.transpileModule(src.slice(src.indexOf('export function useSharedPlan')),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText;
const names=['data','error','loading','busy','stale','updatedAt'];let slot=0;const log=[];
const useState=init=>{const name=names[slot++];return [init,v=>log.push([name,v])];};
const refs=[];let refIndex=0;const useRef=init=>refs[refIndex]??(refs[refIndex++]={current:init}) ;
let interval,focus;const win={addEventListener:(n,f)=>{if(n==='focus')focus=f;},removeEventListener(){},setInterval:f=>{interval=f;return 1;},clearInterval(){}};
let payload={orders:[1],today:'2026-11-23'},fail=false;
const supabase={rpc:async()=>fail?{data:null,error:{message:'offline'}}:{data:payload,error:null},channel:()=>({on(){return this;},subscribe(){return this;}}),removeChannel(){}};
let effect;const useEffect=fn=>{effect=fn;};
const useSharedPlan=new Function('supabase','readPlanSnapshot','useCallback','useEffect','useRef','useState','window','document','crypto','exports',js+';return exports.useSharedPlan;')(supabase,x=>x,fn=>fn,useEffect,useRef,useState,win,{visibilityState:'visible'},{randomUUID:()=>'id'},{});
useSharedPlan();effect();
await new Promise(r=>setTimeout(r,5));
assert.ok(log.some(([n,v])=>n==='loading'&&v===true),'the first load shows loading');
assert.ok(log.some(([n])=>n==='data'));
log.length=0;

interval();await new Promise(r=>setTimeout(r,5));
assert.ok(log.every(([n,v])=>(n==='stale'&&v===false)||(n==='error'&&v==='')),'only harmless resets');
assert.ok(!log.some(([n])=>n==='loading'),'a 15-second refresh never flips the loading flag (no "Refreshing…" flicker)');
assert.ok(!log.some(([n])=>n==='data'||n==='updatedAt'),'unchanged data does not re-render the screen');
log.length=0;

focus();await new Promise(r=>setTimeout(r,5));
assert.ok(!log.some(([n])=>n==='loading'||n==='data'),'tab focus refresh is silent too');
log.length=0;

payload={orders:[1,2],today:'2026-11-23'};interval();await new Promise(r=>setTimeout(r,5));
assert.ok(log.some(([n])=>n==='data'),'a real change still updates the screen');
assert.ok(!log.some(([n])=>n==='loading'),'...without any loading flicker');
log.length=0;

fail=true;interval();await new Promise(r=>setTimeout(r,5));interval();await new Promise(r=>setTimeout(r,5));
assert.ok(!log.some(([n])=>n==='error'||n==='stale'),'one or two blips while in the background stay invisible');
interval();await new Promise(r=>setTimeout(r,5));
assert.ok(log.some(([n,v])=>n==='error'&&v==='offline')&&log.some(([n,v])=>n==='stale'&&v===true),'a lasting failure is still reported');

// ---- every background trigger in the app uses the quiet path ----
const read=f=>readFile(f,'utf8');
const inv=await read('src/InventoryWorkspaceData.ts'),rep=await read('src/SharedReporting.tsx'),app=await read('src/App.tsx'),rew=await read('src/CustomerRewards.tsx');
assert.ok(inv.includes("void load(true);\n  };")&&inv.includes("void load(true);\n  }, 15000)"),'inventory: focus, live changes and the 15s timer are quiet');
assert.ok(rep.includes("void load(true);};\n  const timer=window.setInterval(refresh,15000)"),'reports: background refresh is quiet');
assert.ok(app.includes("refreshAvailability(location,true)"),'customer availability: background refresh is quiet');
assert.ok(rew.includes("void refresh(true)"),'customer rewards: background refresh is quiet');

// ---- receipts carry every important detail, inside the part that prints ----
const hist=await read('src/OrderHistory.tsx');
const paper=hist.slice(hist.indexOf('<div className="receipt-paper">'),hist.indexOf('</div>\n          <button className="button secondary full" onClick={() => window.print()}'));
for(const needle of ['{open.label}','Placed','Location','Name','Phone','Email','Deliver to','@ {money(l.price)}','Paid with','Status','Tax','Total'])assert.ok(paper.includes(needle),'order receipt includes '+needle);
const pos=app.slice(app.indexOf('<div className="receipt-paper"><div className="receipt-brand">Za by Zach'));
for(const needle of ['lastSale.receiptNo','receiptTime(lastSale.createdAt)','lastSale.location','lastSale.customerName','lastSale.customerPhone','lastSale.paymentLabel','@ {usd(itm(l.sku).price)}'])assert.ok(pos.slice(0,2200).includes(needle),'POS receipt includes '+needle);
assert.ok(app.includes("acceptReceipt(data,{location,lines,name:pickupName,phone:rewardsPhone,paymentMethod,"),'normal POS sales pass name, phone and card to the receipt');
assert.ok(app.includes('className="checkout-card print-receipt"')&&app.includes('onClick={()=>window.print()}>Print receipt'),'customer confirmation prints too');
const css=await read('src/style.css');assert.ok(css.includes('.print-receipt,.print-receipt *{visibility:visible!important}'),'print styles show the receipt');

console.log('PASS: background refreshes never flip loading flags, unchanged data never re-renders, real changes still appear, lasting failures still report, every 15-second/focus/live trigger uses the quiet path, and POS, order-history and customer receipts include name, contact, card, order number, items, time and location.');
