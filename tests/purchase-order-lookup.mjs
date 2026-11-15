import assert from 'node:assert/strict';
import {purchaseOrderSearch} from '../src/purchasing.ts';
const po=(id,supplier,sku,status,date)=>({id,supplier,supplierId:'SUP-6',date,expected:date,status,terms:30,location:'Central Commissary',lines:[{id:id+'-L0',sku,qty:10,received:status==='Received'?10:0,unitPrice:24}]});
const state={purchaseOrders:[po('PO-OLD','Cascade Beverage & Sides','1054','Received','2026-05-01'),po('PO-NEW','Cascade Beverage & Sides','1054','Order Sent','2026-11-14'),po('PO-OTHER','Valley Meats','1005','Order Sent','2026-11-14'),po('PO-PARTIAL','Cascade Beverage & Sides','1054','Partially Received','2026-11-10')]};
const before=JSON.stringify(state);
let result=purchaseOrderSearch(state,'  zbz-1054\r\n');assert.equal(result.matchedItem.name,'Sprite (12 oz can)');assert.deepEqual(result.orders.map(p=>p.id),['PO-NEW','PO-PARTIAL','PO-OLD']);assert.equal(result.openOrders.length,2);assert.equal(result.hiddenCount,0);
assert.deepEqual(purchaseOrderSearch(state,'1054').orders,result.orders);assert.equal(purchaseOrderSearch(state,'Sprite').orders.length,3);assert.equal(purchaseOrderSearch(state,'cascade').orders.length,3);assert.equal(purchaseOrderSearch(state,'PO-OTHER').orders[0].id,'PO-OTHER');assert.equal(purchaseOrderSearch(state,'ZBZ-1005').matchedItem.name,'Pepperoni');
result=purchaseOrderSearch(state,'ZBZ-1054','Closed');assert.equal(result.orders.length,0);assert.equal(result.hiddenCount,3);assert.equal(result.matchedItem.sku,'1054');
// Valid item with no PO remains discoverable; unknown codes never invent an item or PO.
result=purchaseOrderSearch(state,'ZBZ-1055');assert.equal(result.matchedItem.sku,'1055');assert.equal(result.matchingOrders.length,0);assert.equal(result.openOrders.length,0);assert.equal(purchaseOrderSearch(state,'ZBZ-9999').matchedItem,undefined);assert.equal(purchaseOrderSearch(state,'ZBZ-9999').orders.length,0);
assert.equal(purchaseOrderSearch(state,'').orders.length,4);assert.equal(purchaseOrderSearch(state,'','Order Sent').orders.length,2);assert.equal(JSON.stringify(state),before);
// Historical POs continue to use their saved supplier even when today's item assignment changes.
const historic={purchaseOrders:[po('PO-HIST','Previous Beverage Partner','1054','Received','2026-05-01')]};assert.equal(purchaseOrderSearch(historic,'ZBZ-1054').orders[0].supplier,'Previous Beverage Partner');
console.log('PASS: scanned/typed barcode and SKU lookups; case/whitespace normalization; item/name/supplier/PO search; open-first ordering; status-filter visibility; valid item without POs; unknown codes; read-only lookup; historical supplier retained.');
