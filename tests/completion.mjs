import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {code128Svg} from '../src/barcode.ts';
import {decodeCode128Line,decodeCode128Image} from '../src/scanCode128.ts';
import {items} from '../src/domain.ts';
import {calculateMrp} from '../src/sharedMrp.ts';
import {poLines,invoicePaidShared} from '../src/sharedPurchasing.ts';
import {sendPlanningRequest} from '../src/planningRequests.ts';
function imageFor(code,rotation=false,noise=false){const svg=code128Svg(code),width=Number(svg.match(/viewBox="0 0 (\d+)/)[1]);const bars=[...svg.matchAll(/<rect x="(\d+)" y="0" width="(\d+)"/g)].map(m=>({x:+m[1],w:+m[2]}));const w=rotation?100:width,h=rotation?width:100,data=new Uint8ClampedArray(w*h*4);for(let y=0;y<h;y++)for(let x=0;x<w;x++){const n=rotation?y:x;let v=bars.some(b=>n>=b.x&&n<b.x+b.w)?20:240;if(noise)v+=((x*13+y*17)%25)-12;const i=(y*w+x)*4;data[i]=data[i+1]=data[i+2]=v;data[i+3]=255;}return{width:w,height:h,data};}
for(const item of items.filter(i=>i.price>0))for(const rotated of [false,true])assert.equal(decodeCode128Image(imageFor(item.barcode,rotated,true)),item.barcode,'printed menu decode '+item.sku);
const image=imageFor('ZBZ-1005');const gray=Array.from({length:image.width},(_,x)=>image.data[x*4]);assert.equal(decodeCode128Line(gray),'ZBZ-1005');assert.equal(decodeCode128Line(new Array(300).fill(128)),null);assert.equal(decodeCode128Line(gray.map(v=>128+v/20)),null,'low contrast must not invent a barcode');
const reversed={...image,data:image.data.slice()};for(let y=0;y<image.height;y++)for(let x=0;x<image.width;x++)reversed.data.set(image.data.slice((y*image.width+x)*4,(y*image.width+x+1)*4),(y*image.width+image.width-1-x)*4);assert.equal(decodeCode128Image(reversed),'ZBZ-1005');
// Large PO histories must not repeatedly scan all lines during table rendering.
let touches=0;const lines=Array.from({length:10000},(_,n)=>({id:String(n),get purchase_order_id(){touches++;return 'po-'+Math.floor(n/10);},item_sku:'sku',quantity_purchase:1,quantity_received_purchase:1,unit_price_purchase:1}));const snapshot={lines};
for(let n=0;n<1000;n++)assert.equal(poLines(snapshot,'po-'+n).length,10);assert.ok(touches<30000,'PO rendering still repeatedly scans the entire line history');
let paymentTouches=0;const payments=Array.from({length:10000},(_,n)=>({get invoice_id(){paymentTouches++;return 'invoice-'+Math.floor(n/10);},amount:2}));
for(let n=0;n<1000;n++)assert.equal(invoicePaidShared({payments},{id:'invoice-'+n,amount:100,paid_at:null}),20);assert.ok(paymentTouches<30000,'invoice balances repeatedly scan all payment history');
// Change one encoded data character while retaining the original checksum.
const originalSvg=code128Svg('ZBZ-1005'),wrongSvg=code128Svg('YBZ-1005');
function encodedBars(svg){return[...svg.matchAll(/<rect x="(\d+)" y="0" width="(\d+)"/g)].map(m=>({x:+m[1],w:+m[2]}));}
const originalBars=encodedBars(originalSvg),wrongBars=encodedBars(wrongSvg);const damaged=Array.from({length:image.width},(_,x)=>(x>=42&&x<64?wrongBars:originalBars).some(b=>x>=b.x&&x<b.x+b.w)?20:240);
assert.equal(decodeCode128Line(damaged),null,'mismatched checksum must be rejected');
const plan=calculateMrp({today:'2026-11-17',items:[{sku:'drink',name:'Drink',category:'Beverage',base_unit:'each',purchase_unit:'case',conversion_factor:12,lead_days:1,supplier_id:'s',active:true,selling_price:3,unit_cost:1}],bom:[],locations:[{id:'store',name:'Store',can_sell:true}],suppliers:[{id:'s',name:'Supplier',quoted_lead_days:1,erp_active:true}],orders:[{id:'paid',location_id:'store',pickup_at:'2026-11-18',status:'Order Placed',erp_prepared_at:null,erp_sale_id:'sale'},{id:'unpaid',location_id:'store',pickup_at:'2026-11-18',status:'Order Placed',erp_prepared_at:null,erp_sale_id:null}],lines:[{order_id:'paid',item_sku:'drink',quantity:5},{order_id:'unpaid',item_sku:'drink',quantity:2}],stock:[],receipts:[],production:[]});
assert.equal(plan.rows.find(r=>r.item.sku==='drink').gross.reduce((a,b)=>a+b,0),2,'MRP must not plan already consumed paid checkout stock again');
const memory=new Map();globalThis.localStorage={getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k)};
let call;await sendPlanningRequest('u','pickup','erp_checkout_order',{name:'Customer'},async(name,args)=>{call={name,args};return{data:{id:args.p_request,total:6,posted:true},error:null};});assert.equal(call.name,'erp_checkout_order');assert.equal(call.args.p_action,undefined);assert.deepEqual(call.args.p_payload,{name:'Customer'});assert.equal(memory.size,0);
const app=await readFile('src/App.tsx','utf8'),purchasing=await readFile('src/SharedPurchasingScreens.tsx','utf8'),report=await readFile('src/SharedReporting.tsx','utf8'),inventory=await readFile('src/ExistingDatabaseScreens.tsx','utf8');
assert.ok(app.includes('<SharedDashboard role={role}'));assert.ok(app.includes("'erp_checkout_order'"));assert.ok(inventory.includes("supabase.rpc('erp_barcode_catalog')"));assert.ok(purchasing.includes('Scan with phone camera'));assert.ok(purchasing.includes('Prepare supplier email'));assert.ok(purchasing.includes('Nothing due'));assert.ok(!/AI-generated|AI sample/.test(purchasing+report));
const label=await readFile('src/BarcodeLabels.tsx','utf8');assert.ok(label.includes('!i.recipe||i.price>0'));
console.log('PASS: all printed menu codes decode horizontally/vertically/reversed with noise; flat/low-contrast images rejected; 1,000 PO lookups use a linear index; completed phone checkout uses correct durable RPC arguments; shared dashboard, camera receiving, email, neutral labels and all menu labels remain connected. Physical phone camera permission/focus must still be checked on-device.');
