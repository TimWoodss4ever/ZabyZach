import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {items} from '../src/domain.ts';
import {expectedArrival,purchaseOrderContents} from '../src/purchaseOrderScanning.ts';
import {barcodeLabelSheet} from '../src/barcodeLabels.ts';
assert.equal(expectedArrival('2026-11-19',3),'2026-11-22');
assert.equal(expectedArrival('2026-12-30',3),'2027-01-02');
assert.equal(expectedArrival('2028-02-28',1),'2028-02-29');
assert.equal(expectedArrival('2026-03-07',2),'2026-03-09'); // calendar days across DST
assert.equal(expectedArrival('2026-11-19',0),'2026-11-19');
for(const date of ['', 'x'])assert.equal(expectedArrival(date,3),'');
for(const lead of [-1,NaN,Infinity,1.5])assert.equal(expectedArrival('2026-11-19',lead),'');
const d={items:[{sku:'1',name:'Ham'},{sku:'2',name:'Pepperoni'},{sku:'3',name:'Bacon'}],lines:[{purchase_order_id:'p',item_sku:'1'},{purchase_order_id:'p',item_sku:'2'},{purchase_order_id:'p',item_sku:'3'},{purchase_order_id:'other',item_sku:'1'}]};
assert.equal(purchaseOrderContents(d,{id:'p'}),'Ham + Pepperoni + 1 more item');
assert.equal(purchaseOrderContents(d,{id:'unknown'}),'Purchase order');
const ham=items.find(i=>i.sku==='1007'),flour=items.find(i=>i.sku==='1001');
const sheet=barcodeLabelSheet([ham,flour],{'1007':3,'1001':2});
assert.equal((sheet.match(/class="label"/g)??[]).length,5);assert.ok(sheet.includes('5 labels'));
for(const i of items){const label=barcodeLabelSheet([i],1);assert.ok(label.includes(i.barcode),i.name);assert.ok(label.includes('SKU '+i.sku),i.name);}
const escaped=barcodeLabelSheet([{...ham,name:'<img src=x onerror=alert(1)>'}],1);assert.ok(!escaped.includes('<img'));assert.ok(escaped.includes('&lt;img'));
const scope=JSON.parse(await readFile('migration-review/purchasing-scope.json','utf8'));
const {createHash}=await import('node:crypto');
for(const [path,hash]of Object.entries(scope.files))assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'),hash,'Unrelated uploaded-main source changed: '+path);
const connected=await readFile('src/ExistingDatabaseScreens.tsx','utf8');assert.equal(createHash('sha256').update(connected.slice(0,connected.indexOf('// The new printable catalog'))).digest('hex'),scope.connectedPrefix,'Unrelated inventory/production/returns loader changed');
console.log('PASS: calendar-day arrival previews across DST/year/leap boundaries; item-first PO labels; per-item physical-label counts, all catalog item labels and escaped content; unchanged uploaded-main source outside steps 3/7.');
