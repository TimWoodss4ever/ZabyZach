import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {dateOnly,invoiceOwedShared,invoicePaidShared,purchasingMetrics,purchasingRule,readPurchasingSnapshot,searchSharedOrders} from '../src/sharedPurchasing.ts';
const s={id:'supplier',name:'Actual supplier',contact_name:'Contact',email:'',phone:'',address:'',quoted_lead_days:3,payment_terms_days:15,erp_active:true,erp_notes:'',erp_revision:0};
const i={sku:'LIVE-SKU',name:'Database-only item',barcode:'ACTUAL-001',category:'Ingredient',base_unit:'oz',purchase_unit:'5 lb box',conversion_factor:80,unit_cost:1,shelf_life_days:null,supplier_id:s.id,active:true,made:false};
const po={id:'po',po_no:'PO-ACTUAL',supplier_id:s.id,ship_to_location_id:'loc',ordered_at:'2026-11-01T19:00:00Z',expected_at:'2026-11-04T19:00:00Z',received_at:'2026-11-06T19:00:00Z',status:'Received',erp_revision:1,erp_notes:'',erp_quoted_lead_days:3,erp_payment_terms_days:15,erp_legacy_received_at:null};
const d={version:1,userId:'manager',today:'2026-11-15',suppliers:[s],items:[i],locations:[{id:'loc',name:'Database warehouse'}],orders:[po],lines:[{id:'line',purchase_order_id:po.id,item_sku:i.sku,quantity_purchase:10,quantity_received_purchase:5,unit_price_purchase:80}],receipts:[],receiptLines:[],invoices:[{id:'invoice',purchase_order_id:po.id,amount:400,due_at:'2026-11-21',paid_at:null,created_at:'2026-11-06T19:00:00Z',erp_invoice_date:'2026-11-06',erp_receipt_id:null,erp_revision:0}],payments:[],reviews:[],inventoryReviews:[],audit:[],options:{order_cost:25,holding_rate:.25,safety_days:2,review_days:7,revision:0},stock:{'LIVE-SKU':400},dailyUsage:{'LIVE-SKU':20}};
assert.equal(readPurchasingSnapshot(d),d);assert.throws(()=>readPurchasingSnapshot({...d,version:2}));
let m=purchasingMetrics(d,s.id);assert.equal(m.fillRate,.5);assert.equal(m.onTime,0);assert.equal(m.actualLead,5);assert.equal(m.quotedLead,3);assert.equal(m.rating,'Replace');assert.equal(m.shortOrders,1);assert.equal(m.owed,400);
const perfect=structuredClone(d);perfect.lines[0].quantity_received_purchase=10;perfect.orders[0].received_at='2026-11-04T19:00:00Z';assert.equal(purchasingMetrics(perfect,s.id).score,100);
const half=structuredClone(perfect);half.lines[0].quantity_received_purchase=5;assert.ok(purchasingMetrics(half,s.id).score<100);assert.equal(purchasingMetrics(half,s.id).fillRate,.5);
const overdue=structuredClone(d);overdue.orders[0].status='Order Sent';overdue.orders[0].received_at=null;overdue.lines[0].quantity_received_purchase=0;assert.equal(purchasingMetrics(overdue,s.id).onTime,0);assert.equal(purchasingMetrics(overdue,s.id).fillRate,0);
const legacy=structuredClone(d);legacy.orders[0].erp_quoted_lead_days=null;legacy.suppliers[0].quoted_lead_days=99;assert.equal(purchasingMetrics(legacy,s.id).quotedLead,3);legacy.invoices[0].paid_at='2026-11-10';assert.equal(invoicePaidShared(legacy,legacy.invoices[0]),400);assert.equal(invoiceOwedShared(legacy,legacy.invoices[0]),0);
d.payments.push({id:'p',invoice_id:'invoice',paid_on:'2026-11-10',amount:125,reference:'partial',created_by:'manager'});assert.equal(invoiceOwedShared(d,d.invoices[0]),275);assert.equal(purchasingMetrics(d,s.id).owed,275);
assert.equal(searchSharedOrders(d,' actual-001 ').orders.length,1);assert.equal(searchSharedOrders(d,'LIVE-SKU').items[0].sku,i.sku);assert.equal(searchSharedOrders(d,'unknown').orders.length,0);
assert.equal(purchasingRule(d,i).daily,20);assert.equal(purchasingRule({...d,dailyUsage:{}},i).daily,0);assert.equal(purchasingRule({...d,dailyUsage:{}},i).packs,0);assert.equal(purchasingRule(d,i).onHand,400);
assert.equal(dateOnly('2026-11-15T02:00:00Z'),'2026-11-14');
const source=await readFile('src/SharedPurchasingScreens.tsx','utf8');
const handlers=source.slice(source.indexOf(' const execute=async'),source.indexOf(' return{data,error,busy,stale,pending,load,save'));
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
function setup(reply){const store=new Map(),events={calls:[],pending:null,errors:[],refresh:0,changed:0};const context={busyRef:{current:false},pendingRef:{current:null},mounted:{current:true},data:{userId:'manager'},stale:false,
 setBusy:()=>{},setError:x=>events.errors.push(x),setPending:x=>events.pending=x,pendingKey:id=>'test:'+id,crypto,
 localStorage:{getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)},
 supabase:{rpc:async(name,args)=>{events.calls.push({name,args});return reply();}},load:async()=>{events.refresh++;return true;},
 window:{dispatchEvent:()=>events.changed++},Event};
 const run=new Function(...Object.keys(context),stripTypeScriptTypes(handlers)+';return {save,execute};')(...Object.values(context));return{...run,context,store,events};}
let test=setup(()=>({data:{id:'receipt'},error:null}));await Promise.all([test.save('receive_order',{qty:5}),test.save('receive_order',{qty:5})]);assert.equal(test.events.calls.length,1);assert.equal(test.events.refresh,1);assert.equal(test.store.size,0);
test=setup(()=>{throw Error('Connection interrupted after server save');});assert.equal(await test.save('pay_invoice',{amount:125}),false);assert.equal(test.store.size,1);const request=JSON.parse([...test.store.values()][0]);assert.equal(await test.save('pay_invoice',{amount:125}),false);assert.equal(test.events.calls.length,1);
test.context.supabase.rpc=async(name,args)=>{test.events.calls.push({name,args});return{data:{id:'same-invoice'},error:null};};await test.execute(request);assert.equal(test.events.calls[0].args.p_request,test.events.calls[1].args.p_request);assert.deepEqual(test.events.calls[0].args.p_payload,test.events.calls[1].args.p_payload);assert.equal(test.store.size,0);
test=setup(()=>({data:null,error:{code:'P0001',message:'Over receipt rejected'}}));await test.save('receive_order',{qty:100});assert.equal(test.store.size,0);assert.ok(test.events.errors.includes('Over receipt rejected'));
test=setup(()=>({data:{id:'r'},error:null}));test.context.localStorage.setItem=()=>{throw Error('blocked');};await test.save('receive_order',{qty:5});assert.equal(test.events.calls.length,0);
const app=await readFile('src/App.tsx','utf8');for(const view of ['Suppliers','Purchase Orders','Supplier Scorecards','Inventory Review','Payables'])assert.ok(app.includes('SharedPurchasingScreen view="'+view+'"'));
assert.ok(source.includes("api.retry()"));assert.ok(!source.includes('loadState('));assert.ok(!source.includes('onCommit('));
console.log('PASS: shared-only suppliers/catalog/history; final-short, overdue and legacy metrics; partial and legacy payments; real ledger usage; scanned lookup; duplicate-submit lock; durable uncertain-request retry; storage failure blocks writes; all purchasing routes connected. Transport tests are mocked; SQL tests run separately.');
