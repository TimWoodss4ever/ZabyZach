import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {normalizePurchasingQuery,purchaseOrderBarcode,resolveReceivingScan,purchaseOrderLabelSheet} from '../src/purchaseOrderScanning.ts';
import {searchSharedOrders} from '../src/sharedPurchasing.ts';
import {code128Svg} from '../src/barcode.ts';
import {decodeCode128Image} from '../src/scanCode128.ts';
const item={sku:'1003',barcode:'ZBZ-1003',name:'Mozzarella',purchase_unit:'5 lb bag'};
const po={id:'a0186598-bf73-4d89-86d2-a43e41d9555a',po_no:'PO-2026-123',supplier_id:'s',ship_to_location_id:'loc',status:'Order Sent',expected_at:'2026-11-20'};
const line={id:'line',purchase_order_id:po.id,item_sku:'1003',quantity_purchase:5,quantity_received_purchase:2};
const d={orders:[po],lines:[line],items:[item],suppliers:[{id:'s',name:'Dairy supplier'}]};
for(const q of ['1003','SKU 1003','sku:1003','SKU # 1003','SKU-1003',' sku 1003\r\n','ZBZ-1003','zbz-1003']){
 assert.equal(searchSharedOrders(d,q).orders[0].id,po.id,q);
 assert.equal(resolveReceivingScan(d,q).kind,'receive',q);
 assert.equal(resolveReceivingScan(d,q).lineId,line.id,q);
}
assert.equal(normalizePurchasingQuery('SKU Trading'),'SKU Trading');
assert.equal(normalizePurchasingQuery('ZBZ–1003'),'ZBZ-1003');
const misleading={...d,orders:[po,{...po,id:'unrelated',po_no:'PO-1003'}]};assert.equal(searchSharedOrders(misleading,'SKU 1003').orders.length,1,'SKU prefix was treated as an unrelated PO number');
const value=purchaseOrderBarcode(po);assert.notEqual(value,purchaseOrderBarcode({...po,id:'e0186598-bf73-4d89-86d2-a43e41d9555a'}));
for(const q of [value,value.toUpperCase(),po.po_no,po.id])assert.equal(resolveReceivingScan(d,q).order.id,po.id);
assert.equal(searchSharedOrders(d,value).orders.length,1);assert.equal(resolveReceivingScan(d,'ZPO:unknown').kind,'none');
for(const status of ['Draft','Received','Closed','Cancelled'])assert.equal(resolveReceivingScan({...d,orders:[{...po,status}]},value).kind,'detail');
assert.equal(resolveReceivingScan({...d,lines:[{...line,quantity_received_purchase:5}]},value).kind,'detail');
assert.equal(resolveReceivingScan({...d,lines:[{...line,quantity_received_purchase:5}]},item.barcode).kind,'none');
assert.equal(resolveReceivingScan({...d,orders:[]},item.barcode).kind,'none');
const second={...po,id:'other',po_no:'PO-SECOND',expected_at:'2026-11-18',status:'Partially Received'};
const multiple={...d,orders:[po,second,{...po,id:'closed',status:'Closed'}],lines:[line,{...line,id:'line2',purchase_order_id:'other'},{...line,id:'line3',purchase_order_id:'closed'}]};
const before=JSON.stringify(multiple),chosen=resolveReceivingScan(multiple,item.barcode);assert.equal(chosen.kind,'choose');assert.deepEqual(chosen.orders.map(p=>p.id),['other',po.id]);assert.equal(JSON.stringify(multiple),before,'a scan mutated receipt data');
let touches=0;const many={...d,orders:Array.from({length:1000},(_,n)=>({...po,id:'po-'+n})),lines:Array.from({length:10000},(_,n)=>({...line,id:'line-'+n,get purchase_order_id(){touches++;return 'po-'+Math.floor(n/10);}}))};assert.equal(resolveReceivingScan(many,item.barcode).kind,'choose');assert.ok(touches<40000,'item scan repeatedly traversed the entire PO-line history');
const html=purchaseOrderLabelSheet({...po,po_no:'<script>alert(1)</script>'},'A & B','<Store>');assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;Store&gt;'));assert.ok(html.includes(value));assert.ok(html.includes('100% / Actual size'));
assert.ok(purchaseOrderLabelSheet({...po,expected_at:'2026-11-20T02:00:00Z'},'Dairy','Store').includes('Expected: 2026-11-19'),'PO label used UTC instead of the Denver delivery date');
// Decode the exact long PO barcode with the camera's Code 128 fallback.
const svg=code128Svg(value),width=Number(svg.match(/viewBox="0 0 (\d+)/)[1]);const bars=[...svg.matchAll(/<rect x="(\d+)" y="0" width="(\d+)"/g)].map(m=>({x:+m[1],w:+m[2]}));const height=100,data=new Uint8ClampedArray(width*height*4);
for(let y=0;y<height;y++)for(let x=0;x<width;x++){const n=(y*width+x)*4,v=bars.some(b=>x>=b.x&&x<b.x+b.w)?10:245;data[n]=data[n+1]=data[n+2]=v;data[n+3]=255;}
assert.equal(decodeCode128Image({width,height,data}),value);
const ui=await readFile('src/SharedPurchasingScreens.tsx','utf8');assert.ok(ui.includes("if(request.action==='receive_order')window.dispatchEvent(new Event('erp-inventory-updated'))"));
assert.ok(ui.includes('Scan PO or item'));assert.ok(ui.includes('focusLineId'));assert.ok(ui.includes('purchaseOrderLabelMarkup(po,'));assert.ok(ui.includes('resolveReceivingScan(snapshot,value)'));
console.log('PASS: SKU-prefixed search, stable distinct PO barcodes, exact PO routes, item-to-open-PO selection, partial/closed/draft/zero cases, zero scan mutations, escaped print labels, long barcode camera decoder, fresh snapshot routing and inventory refresh notification. No physical camera tested.');
