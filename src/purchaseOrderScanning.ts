import {parseItemQuery as parsePurchasingQuery,matchingItems} from './itemSearch.ts';
import type {PurchasingSnapshot,SharedPO,SharedLine} from './sharedPurchasing.ts';
import {poLines} from './sharedPurchasing.ts';
import {code128Svg} from './barcode.ts';
import {businessDate} from './domain.ts';

export {parseItemQuery as parsePurchasingQuery} from './itemSearch.ts';
export const normalizePurchasingQuery=(value:string)=>parsePurchasingQuery(value).query;
// A PO barcode names the immutable record, not an item or editable display name.
export const purchaseOrderBarcode=(po:Pick<SharedPO,'id'>)=>'ZPO:'+po.id.toLowerCase();
export const outstandingQuantity=(line:SharedLine)=>Math.max(0,Number(line.quantity_purchase)-Number(line.quantity_received_purchase));
const receivingIndexes=new WeakMap<SharedLine[],{length:number;groups:Map<string,SharedLine[]>}>();
export function receivingLines(d:PurchasingSnapshot,po:SharedPO,sku?:string){
 let index=receivingIndexes.get(d.lines);
 if(!index||index.length!==d.lines.length){const groups=new Map<string,SharedLine[]>();for(const line of d.lines){const rows=groups.get(line.purchase_order_id)??[];rows.push(line);groups.set(line.purchase_order_id,rows);}index={length:d.lines.length,groups};receivingIndexes.set(d.lines,index);}
 return(index.groups.get(po.id)??[]).filter(l=>(!sku||l.item_sku===sku)&&outstandingQuantity(l)>0);
}
export type ReceivingScanResult=
 |{kind:'receive';order:SharedPO;lineId?:string}
 |{kind:'choose';orders:SharedPO[];sku?:string}
 |{kind:'detail';order:SharedPO;message:string}
 |{kind:'none';message:string};
export function resolveReceivingScan(d:PurchasingSnapshot,value:string):ReceivingScanResult{
 const parsed=parsePurchasingQuery(value),q=parsed.query.toLowerCase();
 if(!q)return{kind:'none',message:'Scan a PO or item barcode, or enter its number.'};
 const exact=parsed.skuOnly?[]:d.orders.filter(p=>purchaseOrderBarcode(p).toLowerCase()===q||p.po_no.toLowerCase()===q||p.id.toLowerCase()===q);
 if(exact.length){
  const order=exact[0];
  if(exact.length>1)return{kind:'none',message:'More than one purchase order has this identifier. Choose the order from the list.'};
  if(['Order Sent','Partially Received'].includes(order.status)&&receivingLines(d,order).length)return{kind:'receive',order};
  return{kind:'detail',order,message:order.status==='Draft'?'This PO is a draft. Issue it before receiving.':'This PO has no outstanding delivery to receive. Its record is shown below.'};
 }
 if(q.startsWith('zpo:'))return{kind:'none',message:'No shared purchase order matches this PO barcode.'};
 const items=matchingItems(d.items,value);
 if(items.length!==1)return{kind:'none',message:items.length?'Several items match this name. Choose an item from the search results below, then find its delivery.':'No item or PO matches. Try part of the item name, its SKU, or its stored barcode.'};
 if(items[0].made)return{kind:'none',message:items[0].name+' is made in house. Use Production to make it; its barcode is available in Barcode Labels.'};
 const sku=items[0].sku;
 const orders=d.orders.filter(p=>['Order Sent','Partially Received'].includes(p.status)&&receivingLines(d,p,sku).length)
  .sort((a,b)=>a.expected_at.localeCompare(b.expected_at)||a.po_no.localeCompare(b.po_no)||a.id.localeCompare(b.id));
 if(orders.length===1)return{kind:'receive',order:orders[0],lineId:receivingLines(d,orders[0],sku)[0].id};
 if(orders.length>1)return{kind:'choose',orders,sku};
 return{kind:'none',message:'No open purchase order has '+items[0].name+' still outstanding. Create and issue a PO first, or review the existing deliveries.'};
}
const escapeHtml=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function purchaseOrderLabelMarkup(po:SharedPO,supplier:string,location:string){
 const expected=/^\d{4}-\d{2}-\d{2}$/.test(po.expected_at)?po.expected_at:businessDate(new Date(po.expected_at));
 return '<section class="po-barcode-label" style="break-inside:avoid;border:1px dashed #777;padding:16px;margin:16px 0;text-align:center"><b>Za by Zach · PURCHASE ORDER</b><h2 style="overflow-wrap:anywhere">'+escapeHtml(po.po_no)+'</h2><p>'+escapeHtml(supplier)+' · '+escapeHtml(location)+'</p><p>Expected: '+escapeHtml(expected)+' · '+escapeHtml(po.status)+'</p><div style="max-width:180mm;margin:auto">'+code128Svg(purchaseOrderBarcode(po)).replace('<svg ','<svg style="display:block;width:100%;height:100px" ')+'</div><p style="font:13px monospace;overflow-wrap:anywhere">'+escapeHtml(purchaseOrderBarcode(po))+'</p><p>Scan in Purchase Orders to open receiving. Confirm quantities, then post the delivery.</p></section>';
}
export function purchaseOrderLabelSheet(po:SharedPO,supplier:string,location:string){
 return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+escapeHtml(po.po_no)+' · PO barcode</title><style>@page{size:letter;margin:.4in}*{box-sizing:border-box}body{font:16px Arial,sans-serif;color:#111;background:#fff;margin:16px}.instructions{line-height:1.5}.po-barcode-label{max-width:7.5in;margin:20px auto!important}@media print{.instructions{display:none}body{margin:0}}</style></head><body><div class="instructions"><h1>Purchase order barcode</h1><p>Print at 100% / Actual size. Keep the white margins beside the bars clear.</p><button onclick="window.print()">Print PO barcode / Save as PDF</button></div>'+purchaseOrderLabelMarkup(po,supplier,location)+'</body></html>';
}

export function expectedArrival(orderDate:string,leadDays:number){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(orderDate)||!Number.isInteger(leadDays)||leadDays<0)return '';
 const date=new Date(orderDate+'T12:00:00Z');if(!Number.isFinite(date.getTime()))return '';
 date.setUTCDate(date.getUTCDate()+leadDays);return date.toISOString().slice(0,10);
}
export function purchaseOrderContents(d:PurchasingSnapshot,po:SharedPO){
 const names=[...new Set(poLines(d,po.id).map(l=>d.items.find(i=>i.sku===l.item_sku)?.name??('SKU '+l.item_sku)))];
 return names.slice(0,2).join(' + ')+(names.length>2?' + '+(names.length-2)+' more '+(names.length===3?'item':'items'):'')||'Purchase order';
}