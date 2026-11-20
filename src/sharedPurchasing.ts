export {purchasePackPrice} from './replenishmentPolicy.ts';
import {replenishmentPolicy,matchingDrafts} from './replenishmentPolicy.ts';
import {matchesItemQuery} from './itemSearch.ts';
import {parsePurchasingQuery,purchaseOrderBarcode} from './purchaseOrderScanning.ts';
import type {AppState,Location,PurchaseOrder} from './domain.ts';
import {businessDate} from './domain.ts';
import {supplierMetrics} from './purchasing.ts';

export type SharedSupplier={id:string;name:string;contact_name:string|null;email:string|null;phone:string|null;address:string|null;quoted_lead_days:number;payment_terms_days:number;erp_active:boolean;erp_notes:string;erp_revision:number};
export type SharedItem={sku:string;name:string;barcode:string;category:string;base_unit:string;purchase_unit:string;conversion_factor:number;unit_cost:number;shelf_life_days:number|null;supplier_id:string|null;active:boolean;made:boolean};
export type SharedPO={id:string;po_no:string;supplier_id:string;ship_to_location_id:string;ordered_at:string;expected_at:string;received_at:string|null;status:string;erp_notes:string;erp_revision:number;erp_quoted_lead_days:number|null;erp_payment_terms_days:number|null;erp_legacy_received_at:string|null;erp_mrp_required_on?:string|null;erp_mrp_order_by?:string|null};
export type SharedLine={id:string;purchase_order_id:string;item_sku:string;quantity_purchase:number;quantity_received_purchase:number;unit_price_purchase:number};
export type SharedReceipt={id:string;purchase_order_id:string;received_on:string;location_id:string;final_delivery:boolean;tax_amount:number;created_at:string};
export type SharedReceiptLine={id:string;receipt_id:string;purchase_order_line_id:string;quantity_purchase:number;unit_price_purchase:number};
export type SharedInvoice={id:string;purchase_order_id:string;amount:number;due_at:string;paid_at:string|null;created_at:string;erp_invoice_date:string|null;erp_receipt_id:string|null;erp_revision:number};
export type SharedPayment={id:string;invoice_id:string;paid_on:string;amount:number;reference:string;created_by:string};
export type SharedReview={id:string;supplier_id:string;decision:'Keep'|'Watch'|'Replace';notes:string;created_by:string;created_at:string};
export type SharedAudit={id:string;action:string;resource_id:string|null;before_value:unknown;after_value:unknown;created_by:string;created_at:string};
export type SharedOptions={order_cost:number;holding_rate:number;safety_days:number;review_days:number;revision:number};
export type PurchasingSnapshot={version:1;userId:string;today:string;suppliers:SharedSupplier[];items:SharedItem[];locations:{id:string;name:string}[];orders:SharedPO[];lines:SharedLine[];receipts:SharedReceipt[];receiptLines:SharedReceiptLine[];invoices:SharedInvoice[];payments:SharedPayment[];reviews:SharedReview[];inventoryReviews:{id:string;notes:string;created_at:string;created_by:string}[];audit:SharedAudit[];options:SharedOptions;stock:Record<string,number>;dailyUsage:Record<string,number>};
export function readPurchasingSnapshot(value:unknown):PurchasingSnapshot{
 if(!value||typeof value!=='object')throw Error('Invalid purchasing response.');
 const data=value as PurchasingSnapshot;
 if(data.version!==1||typeof data.userId!=='string'||typeof data.today!=='string'||!data.options)throw Error('Purchasing schema is unavailable or has a different version.');
 for(const name of ['suppliers','items','locations','orders','lines','receipts','receiptLines','invoices','payments','reviews','inventoryReviews','audit'] as const)if(!Array.isArray(data[name]))throw Error('Incomplete purchasing response: '+name);
 return data;
}
const lineIndexes=new WeakMap<SharedLine[],{length:number;groups:Map<string,SharedLine[]>}>();
export function poLines(d:PurchasingSnapshot,id:string){let cached=lineIndexes.get(d.lines);if(!cached||cached.length!==d.lines.length){const groups=new Map<string,SharedLine[]>();for(const line of d.lines){const rows=groups.get(line.purchase_order_id)??[];rows.push(line);groups.set(line.purchase_order_id,rows);}cached={length:d.lines.length,groups};lineIndexes.set(d.lines,cached);}return cached.groups.get(id)??[];}
const paymentIndexes=new WeakMap<SharedPayment[],{length:number;totals:Map<string,number>}>();
export function invoicePaidShared(d:PurchasingSnapshot,i:SharedInvoice){if(i.paid_at)return Number(i.amount);let cached=paymentIndexes.get(d.payments);if(!cached||cached.length!==d.payments.length){const totals=new Map<string,number>();for(const p of d.payments)totals.set(p.invoice_id,(totals.get(p.invoice_id)??0)+Number(p.amount));cached={length:d.payments.length,totals};paymentIndexes.set(d.payments,cached);}return cached.totals.get(i.id)??0;}
export const invoiceOwedShared=(d:PurchasingSnapshot,i:SharedInvoice)=>Math.max(0,Math.round((Number(i.amount)-invoicePaidShared(d,i))*100)/100);
export const dateOnly=(v:string)=>/^\d{4}-\d{2}-\d{2}$/.test(v)?v:businessDate(new Date(v));
const difference=(a:string,b:string)=>(Date.parse(b+'T12:00:00Z')-Date.parse(a+'T12:00:00Z'))/86400000;
export function purchasingMetrics(d:PurchasingSnapshot,supplierId:string){
 const orderMap=new Map(d.orders.map(o=>[o.id,o]));
 const orders:PurchaseOrder[]=d.orders.map(o=>({id:o.id,supplierId:o.supplier_id,supplier:d.suppliers.find(s=>s.id===o.supplier_id)?.name??'Unknown supplier',
  date:dateOnly(o.ordered_at),expected:dateOnly(o.expected_at),received:o.received_at?dateOnly(o.received_at):undefined,status:o.status as PurchaseOrder['status'],
  quotedLead:o.erp_quoted_lead_days??Math.max(0,difference(dateOnly(o.ordered_at),dateOnly(o.expected_at))),terms:o.erp_payment_terms_days??d.suppliers.find(s=>s.id===o.supplier_id)?.payment_terms_days??0,
  lines:poLines(d,o.id).map(l=>({id:l.id,sku:l.item_sku,qty:Number(l.quantity_purchase),received:Number(l.quantity_received_purchase),unitPrice:Number(l.unit_price_purchase)}))}));
 const state={supplierRecords:d.suppliers.map(s=>({id:s.id,name:s.name,contact:s.contact_name??'',email:s.email??'',phone:s.phone??'',address:s.address??'',lead:s.quoted_lead_days,terms:s.payment_terms_days,active:s.erp_active,notes:s.erp_notes})),purchaseOrders:orders,
  purchaseReceipts:d.receipts.map(r=>({id:r.id,poId:r.purchase_order_id,date:r.received_on,location:'' as Location,final:r.final_delivery,lines:[]})),
  supplierInvoices:d.invoices.map(i=>({id:i.id,poId:i.purchase_order_id,receiptId:i.erp_receipt_id??'',supplierId:orderMap.get(i.purchase_order_id)?.supplier_id??'',date:i.erp_invoice_date??dateOnly(i.created_at),due:i.due_at,amount:Number(i.amount)})),
  supplierPayments:d.invoices.map(i=>({id:'balance-'+i.id,invoiceId:i.id,date:i.paid_at??d.today,amount:invoicePaidShared(d,i),reference:i.paid_at?'Recorded paid in Supabase':'Shared payment history'})),
  ledger:[],sales:[],salesOrders:[],returns:[],productionOrders:[],settings:{tax:0,orderCost:d.options.order_cost,holding:d.options.holding_rate,safetyDays:d.options.safety_days,reviewDays:d.options.review_days},customers:[],revision:0} satisfies AppState;
 return supplierMetrics(state,supplierId,d.today);
}
export function purchasingRule(d:PurchasingSnapshot,item:SharedItem){
 const supplier=d.suppliers.find(s=>s.id===item.supplier_id),daily=Number(d.dailyUsage[item.sku]??0),onHand=Number(d.stock[item.sku]??0),factor=Number(item.conversion_factor),cost=Number(item.unit_cost),o=d.options;
 const open=new Set(d.orders.filter(p=>['Order Sent','Partially Received'].includes(p.status)).map(p=>p.id));
 const onOrder=d.lines.filter(l=>l.item_sku===item.sku&&open.has(l.purchase_order_id)).reduce((n,l)=>n+Math.max(0,Number(l.quantity_purchase)-Number(l.quantity_received_purchase))*factor,0);
 return{supplier,...replenishmentPolicy({daily,onHand,onOrder,factor,cost,lead:supplier?.quoted_lead_days??0,shelfLife:item.shelf_life_days,options:o})};
}
export function searchSharedOrders(d:PurchasingSnapshot,query:string){
 const parsed=parsePurchasingQuery(query),q=parsed.query.toLowerCase();if(!q)return{orders:d.orders,items:[] as SharedItem[]};
 const matched=d.items.filter(i=>matchesItemQuery(i,query)),skus=new Set(matched.map(i=>i.sku));
 const orders=d.orders.filter(p=>(!parsed.skuOnly&&(p.id.toLowerCase()===q||purchaseOrderBarcode(p).toLowerCase()===q||(p.po_no+' '+(d.suppliers.find(s=>s.id===p.supplier_id)?.name??'')).toLowerCase().includes(q)))||poLines(d,p.id).some(l=>skus.has(l.item_sku)));
 return{orders,items:matched};
}

// mailto opens a draft only; the printable PO must be attached by the sender.
export function purchaseOrderEmail(d:PurchasingSnapshot,po:SharedPO){
 const supplier=d.suppliers.find(s=>s.id===po.supplier_id);
 const recipient=(supplier?.email??'').replace(/[\r\n]/g,'').trim();
 const destination=d.locations.find(l=>l.id===po.ship_to_location_id)?.name??'';
 const lines=poLines(d,po.id).map(l=>`${l.quantity_purchase} × ${d.items.find(i=>i.sku===l.item_sku)?.name??l.item_sku} (${l.item_sku})`);
 const body=`Hello ${supplier?.contact_name||supplier?.name||'Orders team'},\n\nPlease find purchase order ${po.po_no} attached.\nRequested delivery: ${dateOnly(po.expected_at)}\nDeliver to: ${destination}\n\n${lines.join('\n')}\n\nThank you,\nZa by Zach`;
 return `mailto:${encodeURIComponent(recipient)}?subject=${encodeURIComponent('Za by Zach purchase order '+po.po_no)}&body=${encodeURIComponent(body)}`;
}

export function purchasingDrafts(d:PurchasingSnapshot,location:string,sku:string){
 const refs=d.orders.filter(p=>p.status==='Draft').flatMap(p=>poLines(d,p.id).map(l=>({id:p.id,po_no:p.po_no,location_id:p.ship_to_location_id,item_sku:l.item_sku})));
 return matchingDrafts(refs,location,sku);
}
