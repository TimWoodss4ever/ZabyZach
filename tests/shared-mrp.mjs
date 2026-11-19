import assert from 'node:assert/strict';
import {calculateMrp,shiftDate,readPlanSnapshot,localDate} from '../src/sharedMrp.ts';
const item=(sku,extra={})=>({sku,name:sku,category:'Ingredient',base_unit:'each',purchase_unit:'case',conversion_factor:10,lead_days:3,supplier_id:'supplier',active:true,selling_price:0,unit_cost:1,...extra});
const base=()=>({version:1,userId:'manager',today:'2026-11-16',items:[item('pizza',{selling_price:10,lead_days:0}),item('dough',{lead_days:1}),item('flour'),item('cheese')],bom:[{parent_sku:'pizza',component_sku:'dough',quantity:1},{parent_sku:'pizza',component_sku:'cheese',quantity:2},{parent_sku:'dough',component_sku:'flour',quantity:4}],locations:[{id:'A',name:'Store A',can_sell:true},{id:'B',name:'Store B',can_sell:true}],suppliers:[{id:'supplier',name:'Supplier',quoted_lead_days:3,erp_active:true}],orders:[],lines:[],stock:[],receipts:[],production:[]});
const order=(d,id,date,qty,extra={})=>{d.orders.push({id,location_id:'A',pickup_at:date,status:'Order Placed',erp_prepared_at:null,...extra});d.lines.push({order_id:id,item_sku:'pizza',quantity:qty,unit_price:10});};
const row=(d,sku,location='A')=>calculateMrp(d).rows.find(r=>r.item.sku===sku&&r.location===location);
let d=base();order(d,'one','2026-11-18',5);d.stock.push({item_sku:'dough',location_id:'A',quantity:2});
assert.deepEqual(row(d,'dough').gross,[5,0,0,0]);assert.equal(row(d,'dough').actions[0].quantity,3);
assert.equal(row(d,'flour').gross[0],12,'only missing dough explodes into flour');assert.equal(row(d,'flour').actions[0].date,'2026-11-17','make lead offsets ingredient requirement');assert.equal(row(d,'flour').actions[0].orderBy,'2026-11-14','exact requirement minus supplier lead');
assert.equal(row(d,'flour').actions[0].quantity,20,'round purchase shortage to whole packs');assert.equal(row(d,'flour').actions[0].late,true);
assert.equal(row(d,'cheese').gross[0],10);assert.equal(row(d,'cheese').actions[0].orderBy,'2026-11-15');
d=base();order(d,'early','2026-11-17',5);order(d,'later','2026-11-25',3);
d.receipts.push({id:'late',item_sku:'cheese',location_id:'A',due:'2026-11-20',quantity:10,kind:'Purchase'});
assert.equal(row(d,'cheese').actions[0].quantity,10,'late receipt cannot cover early demand');assert.equal(row(d,'cheese').actions.length,1,'receipt carries into later demand');
d.receipts[0].due='2026-11-17';assert.equal(row(d,'cheese').actions[0].date,'2026-11-25','same-day receipts are usable');
d.receipts[0].due='2026-11-15';assert.equal(row(d,'cheese').actions.length,2);assert.ok(calculateMrp(d).warnings.some(w=>w.includes('Overdue purchase')));
d=base();order(d,'week4','2026-12-13',1);order(d,'outside','2026-12-14',100);order(d,'cancelled','2026-11-20',100,{status:'Cancelled'});order(d,'fulfilled','2026-11-20',100,{status:'Fulfilled'});order(d,'prepared','2026-11-20',100,{erp_prepared_at:'2026-11-19T18:00:00Z'});
assert.deepEqual(row(d,'cheese').gross,[0,0,0,2],'strict four-week cutoff; cancelled/fulfilled/prepared excluded');
order(d,'overdue','2026-11-15',1);assert.equal(row(d,'cheese').gross[0],2);assert.ok(calculateMrp(d).warnings.some(w=>w.includes('Overdue pickup')));
d=base();order(d,'one','2026-11-19',5);d.stock.push({item_sku:'cheese',location_id:'B',quantity:100});
assert.equal(row(d,'cheese').actions[0].net,10,'other location stock is not pooled');assert.deepEqual(row(d,'cheese').transfer,[{location:'B',quantity:10}]);
order(d,'B-own','2026-11-20',49,{location_id:'B'});assert.deepEqual(row(d,'cheese').transfer,[{location:'B',quantity:2}],'source keeps stock for its own confirmed orders');
d=base();order(d,'one','2026-11-19',5);order(d,'two','2026-11-26',2);assert.equal(row(d,'cheese').actions.reduce((n,a)=>n+a.packs,0),2,'prior suggestion and pack remainder carry forward');
d.production.push({id:'prod',order_no:'PR1',parent_sku:'dough',location_id:'A',quantity_started:5,status:'Planned',erp_due_date:'2026-11-18'});d.receipts.push({id:'prod',item_sku:'dough',location_id:'A',due:'2026-11-18',quantity:5,kind:'Production'});
assert.equal(row(d,'dough').actions.reduce((n,a)=>n+a.quantity,0),2);assert.equal(row(d,'flour').gross.reduce((n,a)=>n+a,0),28,'planned production plus remaining dough each explodes once');
d.production[0].status='In Progress';assert.equal(row(d,'flour').gross.reduce((n,a)=>n+a,0),8,'issued production ingredients are not counted twice');
d=base();order(d,'one','2026-11-19',5);d.stock.push({item_sku:'pizza',location_id:'A',quantity:3});assert.equal(row(d,'dough').gross[0],2,'prepared parent inventory reduces component requirements');
// Shared intermediate has multiple parents. All parents must accumulate before netting it.
d.items.push(item('bread',{selling_price:5,lead_days:0}));d.bom.push({parent_sku:'bread',component_sku:'dough',quantity:1});d.orders.push({id:'bread-order',location_id:'A',pickup_at:'2026-11-19',status:'Order Placed',erp_prepared_at:null});d.lines.push({order_id:'bread-order',item_sku:'bread',quantity:3});assert.equal(row(d,'dough').gross[0],5);
d.bom.push({parent_sku:'flour',component_sku:'pizza',quantity:1});assert.throws(()=>calculateMrp(d),/cycle/);
d=base();d.items[0].lead_days=-1;assert.throws(()=>calculateMrp(d),/lead/);assert.throws(()=>readPlanSnapshot({}),/migration/);
assert.equal(shiftDate('2026-12-31',1),'2027-01-01');assert.equal(localDate('2026-11-17T01:00:00Z'),'2026-11-16');
console.log('PASS: location-specific BOM explosion, prepared and open dough supply, exact dates, late receipts, pack carryover, four-week boundary, order statuses, overdue demand, transfer surplus, shared subassemblies, invalid BOMs, Mountain dates.');

// Legacy posted orders remain visible as exceptions without purchasing their
// already consumed ingredients again; overdue pickups cannot silently disappear.
d=base();order(d,'legacy','2026-11-15',5,{erp_order_number:12,erp_sale_id:'old-sale'});
assert.equal(row(d,'cheese').gross.reduce((a,b)=>a+b,0),0);
assert.ok(calculateMrp(d).alerts.some(a=>a.kind==='legacy'&&a.reference==='legacy'));
assert.ok(calculateMrp(d).alerts.some(a=>a.kind==='order'&&a.reference==='legacy'));
d.receipts.push(...['cheese','flour'].map(item_sku=>({id:'one-late-po',item_sku,location_id:'A',due:'2026-11-15',quantity:10,kind:'Purchase'})));
assert.equal(calculateMrp(d).alerts.filter(a=>a.kind==='receipt').length,1,'one alert per overdue PO, not one per component line');
// Simulated payment does not exclude an unprepared order that has no stock sale.
d=base();order(d,'simulated-paid','2026-11-20',5,{erp_simulated_paid:true,erp_sale_id:null});
assert.equal(row(d,'cheese').gross[0],10);
console.log('PASS: simulated-paid demand, legacy once-only consumption exceptions, overdue legacy pickup warnings and deduplicated multi-line PO alerts.');
