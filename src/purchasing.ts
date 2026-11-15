import type {AppState,Item,Location,PurchaseOrder} from './domain.ts';
import {items,locations,suppliers as openingSuppliers,today,inventory,avgDaily} from './domain.ts';
export type Supplier={id:string;name:string;contact:string;email:string;phone:string;address:string;lead:number;terms:number;active:boolean;notes:string};
export type PurchaseReceipt={id:string;poId:string;date:string;location:Location;final:boolean;lines:{lineId:string;sku:string;qty:number;unitPrice:number}[]};
export type SupplierInvoice={id:string;poId:string;receiptId:string;supplierId:string;date:string;due:string;amount:number};
export type SupplierPayment={id:string;invoiceId:string;date:string;amount:number;reference:string};
export type InventoryReview={id:string;date:string;notes:string;reviewer:string};
export type SupplierReview={id:string;supplierId:string;date:string;decision:'Keep'|'Watch'|'Replace';notes:string;reviewer:string};
export type PurchasingCorrection={id:string;poId:string;date:string;reason:string;before:unknown;after:unknown;reviewer:string};
export function saveSupplierReview(state:AppState,input:{supplierId:string;decision:SupplierReview['decision'];notes:string}){
 if(!getSuppliers(state).some(s=>s.id===input.supplierId))throw Error('Supplier not found.');
 if(!['Keep','Watch','Replace'].includes(input.decision)||!input.notes.trim())throw Error('Choose a decision and explain your assessment.');
 return {...state,supplierReviews:[{...input,id:uid('REVIEW'),date:today(),notes:input.notes.trim(),reviewer:'Manager'},...(state.supplierReviews??[])]};
}
export type PurchaseCorrectionInput={poId:string;date:string;quotedLead:number;ordered:{lineId:string;qty:number}[];receipts:{id:string;date:string}[];reason:string};
export function correctPurchaseHistory(state:AppState,input:PurchaseCorrectionInput){
 const next=structuredClone(state),po=next.purchaseOrders.find(p=>p.id===input.poId);
 if(!po||po.status==='Draft')throw Error('Choose an issued purchase order.');
 if(!input.reason.trim())throw Error('Enter a reason for this correction.');
 if(!validDate(input.date)||input.date>today()||!Number.isInteger(input.quotedLead)||input.quotedLead<0||input.quotedLead>365)throw Error('Enter a valid sent date and a quoted lead time from 0 to 365 days.');
 const receipts=(next.purchaseReceipts??[]).filter(r=>r.poId===po.id);
 if(input.ordered.length!==po.lines.length||new Set(input.ordered.map(l=>l.lineId)).size!==po.lines.length||input.receipts.length!==receipts.length||new Set(input.receipts.map(r=>r.id)).size!==receipts.length)throw Error('Include each order line and receipt exactly once.');
 for(const l of input.ordered){const line=po.lines.find(x=>x.id===l.lineId);if(!line||!Number.isFinite(l.qty)||l.qty<=0||l.qty<line.received-.000001)throw Error('Ordered quantity must be positive and cannot be less than the quantity already received.');}
 for(const r of input.receipts){if(!receipts.some(x=>x.id===r.id)||!validDate(r.date)||r.date<input.date||r.date>today())throw Error('Each receipt date must be between the sent date and today.');
  const invoices=(next.supplierInvoices??[]).filter(i=>i.receiptId===r.id);
  if(invoices.some(i=>(next.supplierPayments??[]).some(p=>p.invoiceId===i.id&&p.date<r.date)))throw Error('Receipt date cannot be later than a payment already recorded against its invoice.');
 }
 const snapshot=()=>({date:po.date,quotedLead:po.quotedLead,expected:po.expected,received:po.received,ordered:po.lines.map(l=>({lineId:l.id,qty:l.qty})),receipts:receipts.map(r=>({id:r.id,date:r.date}))});const before=snapshot();
 po.date=input.date;po.sentAt=input.date;po.quotedLead=input.quotedLead;po.expected=addDays(input.date,input.quotedLead);
 for(const l of input.ordered)po.lines.find(x=>x.id===l.lineId)!.qty=l.qty;
 // Update the source delivery and its invoice dates together. Inventory quantities and invoice amounts stay intact.
 for(const change of input.receipts){const receipt=receipts.find(r=>r.id===change.id)!,oldDate=receipt.date;receipt.date=change.date;
  for(const invoice of next.supplierInvoices??[])if(invoice.receiptId===receipt.id){invoice.date=change.date;invoice.due=addDays(change.date,po.terms);}
  for(const line of receipt.lines){const exact=next.ledger.find(t=>t.id===receipt.id+'-'+line.lineId||t.id===receipt.id.replace('RCV-LEGACY-',''));
   if(exact)exact.date=change.date;
   else {const tx=next.ledger.filter(t=>t.type==='Receipt'&&t.reference===po.id&&t.item===line.sku&&t.location===receipt.location&&t.date===oldDate);if(tx.length===1)tx[0].date=change.date;}
  }
 }
 po.received=receipts.length?receipts.map(r=>r.date).sort()[receipts.length-1]:po.received;
 if(po.closedAt&&po.received&&po.closedAt<po.received)po.closedAt=po.received;
 if(po.status==='Partially Received'&&po.lines.every(l=>l.received>=l.qty-.000001))po.status='Received';
 const after=snapshot();if(JSON.stringify(before)===JSON.stringify(after))throw Error('Change a value before saving a correction.');
 next.purchasingCorrections=[{id:uid('CORRECTION'),poId:po.id,date:today(),reason:input.reason.trim(),before,after,reviewer:'Manager'},...(next.purchasingCorrections??[])];return next;
}
// Historical scenarios are applied only to generated, completed orders, once per record.
// Received stock, receipts, invoices, payments, and user-created POs are preserved.
export function diversifySamplePurchases(state:AppState){
 let changed=false;const counters=new Map<string,number>();
 const history=state.purchaseOrders.filter(p=>/^PO-(?:\d{3}|SAMPLE-.+)$/.test(p.id)&&isDeliveredPO(p)&&p.received).sort((a,b)=>a.received!.localeCompare(b.received!)||a.id.localeCompare(b.id));
 for(const po of history){const index=counters.get(po.supplier)??0;counters.set(po.supplier,index+1);if(po.samplePerformanceVersion===1)continue;
  const quoted=po.quotedLead??getSuppliers(state).find(s=>s.id===po.supplierId)?.lead??1,bucket=index%10;
  const profile=po.supplier==='Beehive Packaging'?{on:2,extra:6,short:6}:po.supplier==='Valley Meats'?{on:5,extra:4,short:3}:po.supplier==='Mountain Produce'?{on:6,extra:3,short:4}:po.supplier==='Cascade Beverage & Sides'?{on:8,extra:2,short:1}:{on:po.supplier==='Provo Water Utility'?10:9,extra:1,short:0};
  const actual=bucket<profile.on?Math.max(0,quoted-(index%3===0?1:0)):quoted+profile.extra+index%3;
  po.date=addDays(po.received!,-actual);po.sentAt=po.date;po.expected=addDays(po.date,quoted);po.quotedLead=quoted;
  if(bucket<profile.short)for(const line of po.lines)if(line.received>0)line.qty=Math.max(line.qty,line.received+Math.max(1,Math.round(line.received*.25)));
  po.samplePerformanceVersion=1;changed=true;
 }
 return changed;
}
export const addDays=(date:string,days:number)=>{const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);};
const validDate=(date:string)=>/^\d{4}-\d{2}-\d{2}$/.test(date)&&!Number.isNaN(Date.parse(date+'T12:00:00Z'))&&new Date(date+'T12:00:00Z').toISOString().slice(0,10)===date;
const daysBetween=(a:string,b:string)=>(Date.parse(b+'T12:00:00Z')-Date.parse(a+'T12:00:00Z'))/86400000;
const uid=(prefix:string)=>prefix+'-'+crypto.randomUUID().slice(0,10).toUpperCase();
export const getSuppliers=(state:AppState):Supplier[]=>state.supplierRecords??openingSuppliers.map((s,index)=>({...s,id:'SUP-'+(index+1),contact:'Orders team',address:'Utah, USA',active:true,notes:''}));
export const supplierForItem=(state:AppState,item:Item)=>getSuppliers(state).find(s=>s.id===state.itemSupplierIds?.[item.sku])??getSuppliers(state).find(s=>s.name===item.supplier);
export const isOpenPO=(po:PurchaseOrder)=>po.status==='Order Sent'||po.status==='Partially Received';
export const isDeliveredPO=(po:PurchaseOrder)=>po.status==='Received'||po.status==='Closed';
export const invoicePaid=(state:AppState,id:string)=>(state.supplierPayments??[]).filter(p=>p.invoiceId===id).reduce((sum,p)=>sum+p.amount,0);
export const invoiceBalance=(state:AppState,invoice:SupplierInvoice)=>Math.max(0,Math.round((invoice.amount-invoicePaid(state,invoice.id))*100)/100);
export function poBalance(state:AppState,poId:string){return(state.supplierInvoices??[]).filter(i=>i.poId===poId).reduce((sum,i)=>sum+invoiceBalance(state,i),0);}
export function saveSupplierRecord(state:AppState,input:Supplier){
 const name=input.name.trim();if(!name||!input.contact.trim()||!input.email.trim()||!input.phone.trim())throw Error('Enter a supplier name, contact person, email, and phone.');
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email))throw Error('Enter a valid supplier email.');
 if(!Number.isInteger(input.lead)||input.lead<0||input.lead>365||!Number.isInteger(input.terms)||input.terms<0||input.terms>365)throw Error('Lead time and payment terms must be whole days from 0 to 365.');
 const next=structuredClone(state);next.supplierRecords??=getSuppliers(state);if(next.supplierRecords.some(s=>s.id!==input.id&&s.name.toLowerCase()===name.toLowerCase()))throw Error('A supplier already uses that name.');
 const supplier={...input,id:input.id||uid('SUP'),name,email:input.email.trim(),contact:input.contact.trim(),phone:input.phone.trim()};const index=next.supplierRecords.findIndex(s=>s.id===supplier.id);if(index>=0)next.supplierRecords[index]=supplier;else next.supplierRecords.push(supplier);return next;
}
export function assignItemSupplier(state:AppState,sku:string,supplierId:string){if(!getSuppliers(state).some(s=>s.id===supplierId&&s.active)||!items.some(i=>i.sku===sku&&!i.recipe))throw Error('Choose an active supplier and a purchased item.');return{...state,itemSupplierIds:{...state.itemSupplierIds,[sku]:supplierId}};}
export function createPurchaseOrder(state:AppState,input:{supplierId:string;location:Location;date:string;lines:{sku:string;qty:number;unitPrice:number}[];send:boolean;notes?:string}){
 const supplier=getSuppliers(state).find(s=>s.id===input.supplierId&&s.active);if(!supplier)throw Error('Choose an active supplier.');if(!locations.includes(input.location)||!validDate(input.date)||input.date>today())throw Error('Choose a destination and an order date no later than today.');if(!input.lines.length)throw Error('Add at least one item.');
 const seen=new Set<string>();for(const l of input.lines){const item=items.find(i=>i.sku===l.sku&&!i.recipe);if(!item||supplierForItem(state,item)?.id!==supplier.id)throw Error('Choose items supplied by this supplier.');if(seen.has(l.sku))throw Error('Combine duplicate items on one line.');seen.add(l.sku);if(!Number.isFinite(l.qty)||l.qty<=0||!Number.isFinite(l.unitPrice)||l.unitPrice<0)throw Error('Enter a positive quantity and a nonnegative pack price.');}
 const po:PurchaseOrder={id:uid('PO'),supplierId:supplier.id,supplier:supplier.name,location:input.location,date:input.date,expected:addDays(input.date,supplier.lead),quotedLead:supplier.lead,terms:supplier.terms,status:input.send?'Order Sent':'Draft',sentAt:input.send?input.date:undefined,notes:input.notes?.trim(),lines:input.lines.map(l=>({...l,id:uid('LINE'),received:0}))};
 return{...state,purchaseOrders:[po,...state.purchaseOrders]};
}
export function sendPurchaseOrder(state:AppState,id:string,date=today()){
 const next=structuredClone(state),po=next.purchaseOrders.find(p=>p.id===id);if(!po||po.status!=='Draft')throw Error('Only a draft can be sent.');const supplier=getSuppliers(next).find(s=>s.id===po.supplierId&&s.active);if(!supplier)throw Error('Choose an active supplier.');if(!validDate(date)||date<po.date||date>today())throw Error('Choose a valid sent date.');po.date=date;po.sentAt=date;po.expected=addDays(date,supplier.lead);po.quotedLead=supplier.lead;po.terms=supplier.terms;po.status='Order Sent';return next;
}
export function receivePurchaseOrder(state:AppState,input:{poId:string;date:string;location:Location;final:boolean;lines:{lineId:string;qty:number;unitPrice:number}[];id?:string}){
 const next=structuredClone(state),po=next.purchaseOrders.find(p=>p.id===input.poId);if(!po||!isOpenPO(po))throw Error('This purchase order is not awaiting a receipt.');if(!validDate(input.date)||input.date<po.date||input.date>today())throw Error('Receipt date must be between the order date and today.');if(!locations.includes(input.location))throw Error('Choose a receiving location.');if(input.id&&(next.purchaseReceipts??[]).some(r=>r.id===input.id))throw Error('This receipt has already been posted.');
 const lines=input.lines.filter(l=>l.qty!==0);if(!lines.length)throw Error('Enter a received quantity on at least one line.');const seen=new Set<string>();for(const l of lines){const line=po.lines.find(x=>x.id===l.lineId);if(!line||seen.has(l.lineId))throw Error('Choose each PO line once.');seen.add(l.lineId);if(!Number.isFinite(l.qty)||l.qty<=0||l.qty>line.qty-line.received+.000001||!Number.isFinite(l.unitPrice)||l.unitPrice<0)throw Error('Received quantity must be positive and cannot exceed the remaining order; prices cannot be negative.');}
 const receipt:PurchaseReceipt={id:input.id||uid('RCV'),poId:po.id,date:input.date,location:input.location,final:false,lines:[]};const costs=new Map<string,number>();
 for(const l of lines){const line=po.lines.find(x=>x.id===l.lineId)!,item=items.find(i=>i.sku===line.sku)!,base=l.qty*item.factor,oldQty=Math.max(0,inventory(next,item.sku)),oldCost=costs.get(item.sku)??item.cost;const newCost=(oldQty*oldCost+l.qty*l.unitPrice)/(oldQty+base);costs.set(item.sku,newCost);line.received=Math.min(line.qty,line.received+l.qty);next.ledger.push({id:receipt.id+'-'+line.id,date:input.date,item:item.sku,location:input.location,qty:base,unitCost:l.unitPrice/item.factor,type:'Receipt',reference:po.id});receipt.lines.push({lineId:line.id!,sku:line.sku,qty:l.qty,unitPrice:l.unitPrice});}
 const complete=input.final||po.lines.every(l=>l.received>=l.qty-.000001);receipt.final=complete;po.status=complete?'Received':'Partially Received';po.received=po.received&&po.received>input.date?po.received:input.date;
 next.purchaseReceipts??=[];next.purchaseReceipts.push(receipt);next.supplierInvoices??=[];const amount=Math.round(receipt.lines.reduce((sum,l)=>sum+l.qty*l.unitPrice,0)*100)/100;next.supplierInvoices.push({id:uid('INV'),poId:po.id,receiptId:receipt.id,supplierId:po.supplierId!,date:input.date,due:addDays(input.date,po.terms),amount});
 for(const [sku,cost]of costs)items.find(i=>i.sku===sku)!.cost=cost;return next;
}
export function recordSupplierPayment(state:AppState,input:{invoiceId:string;date:string;amount:number;reference:string}){
 const invoice=state.supplierInvoices?.find(i=>i.id===input.invoiceId);if(!invoice)throw Error('Invoice not found.');if(!Number.isFinite(input.amount)||Math.round(input.amount*100)/100<=0||Math.round(input.amount*100)/100>invoiceBalance(state,invoice)+.000001)throw Error('Payment must be positive and cannot exceed the amount owed.');if(!validDate(input.date)||input.date<invoice.date||input.date>today())throw Error('Choose a payment date between the invoice date and today.');if(!input.reference.trim())throw Error('Enter a payment reference.');if((state.supplierPayments??[]).some(p=>p.invoiceId===input.invoiceId&&p.reference===input.reference.trim()))throw Error('That payment reference is already recorded for this invoice.');return{...state,supplierPayments:[...(state.supplierPayments??[]),{...input,id:uid('PAY'),amount:Math.round(input.amount*100)/100,reference:input.reference.trim()}]};
}
export function finishShortDelivery(state:AppState,id:string,reason:string){const next=structuredClone(state),po=next.purchaseOrders.find(p=>p.id===id);if(!po||po.status!=='Partially Received')throw Error('Record a partial receipt first.');if(!reason.trim())throw Error('Enter why the remaining items will not arrive.');po.status='Received';po.notes=(po.notes?po.notes+' · ':'')+'Final short delivery: '+reason.trim();const receipt=[...(next.purchaseReceipts??[])].reverse().find(r=>r.poId===id);if(receipt)receipt.final=true;return next;}
export function closePurchaseOrder(state:AppState,id:string){const next=structuredClone(state),po=next.purchaseOrders.find(p=>p.id===id);if(!po||po.status!=='Received')throw Error('Finish receiving the order before closing it.');if(poBalance(next,id)>.005)throw Error('Record the remaining invoice payments before closing this order.');po.status='Closed';po.closedAt=today();return next;}
export function supplierMetrics(state:AppState,supplierId:string,asOf=today()){
 const supplier=getSuppliers(state).find(s=>s.id===supplierId)!;const orders=state.purchaseOrders.filter(p=>p.supplierId===supplierId&&p.status!=='Draft');const due=orders.filter(p=>isDeliveredPO(p)||p.expected<asOf);const onTime=due.length?due.filter(p=>isDeliveredPO(p)&&!!p.received&&p.received<=p.expected).length/due.length:null;
 const withReceipts=orders.filter(p=>p.received);const actualLead=withReceipts.length?withReceipts.reduce((sum,p)=>sum+daysBetween(p.date,p.received!),0)/withReceipts.length:null;const quotedLead=withReceipts.length?withReceipts.reduce((sum,p)=>sum+(p.quotedLead??supplier.lead),0)/withReceipts.length:supplier.lead;
 const evaluated=orders.filter(p=>p.received||p.expected<asOf||isDeliveredPO(p));const ordered=evaluated.reduce((sum,p)=>sum+p.lines.reduce((n,l)=>n+l.qty,0),0),received=evaluated.reduce((sum,p)=>sum+p.lines.reduce((n,l)=>n+l.received,0),0);const fillRate=ordered?Math.min(1,received/ordered):null;
 const components:{weight:number;value:number}[]=[];if(onTime!==null)components.push({weight:.5,value:onTime});if(fillRate!==null)components.push({weight:.3,value:fillRate});if(actualLead!==null)components.push({weight:.2,value:actualLead<=quotedLead?1:Math.max(0,quotedLead/Math.max(actualLead,1))});const score=components.length?components.reduce((n,x)=>n+x.weight*x.value,0)/components.reduce((n,x)=>n+x.weight,0)*100:null;
 const orderById=new Map(orders.map(po=>[po.id,po]));let lastReceipt:PurchaseReceipt|undefined;for(const receipt of state.purchaseReceipts??[])if(orderById.has(receipt.poId))lastReceipt=receipt;
 const lastPO=lastReceipt?orderById.get(lastReceipt.poId):undefined;
 const latestOrder=lastPO?{poId:lastPO.id,date:lastReceipt!.date,ordered:lastPO.lines.reduce((n,l)=>n+l.qty,0),received:lastPO.lines.reduce((n,l)=>n+l.received,0),final:isDeliveredPO(lastPO)}:null;
 const latestFillRate=latestOrder&&latestOrder.ordered>0?Math.min(1,latestOrder.received/latestOrder.ordered):null;
 const shortOrders=orders.filter(po=>isDeliveredPO(po)&&po.lines.some(l=>l.received<l.qty-.000001)).length;
 const invoices=(state.supplierInvoices??[]).filter(i=>i.supplierId===supplierId);const owed=invoices.reduce((n,i)=>n+invoiceBalance(state,i),0),overdue=invoices.filter(i=>i.due<asOf).reduce((n,i)=>n+invoiceBalance(state,i),0);const nextDue=invoices.filter(i=>invoiceBalance(state,i)>.005).sort((a,b)=>a.due.localeCompare(b.due))[0]?.due;return{orders,onTime,actualLead,quotedLead,fillRate,score,latestOrder,latestFillRate,shortOrders,rating:score===null?'New':score>=80?'Keep':score>=60?'Watch':'Replace',owed,overdue,nextDue,ordered,received};
}
export function orderingRule(state:AppState,item:Item){
 const daily=avgDaily(state,item.sku),supplier=supplierForItem(state,item),lead=supplier?.lead??item.lead,rop=daily*(lead+state.settings.safetyDays),holding=item.cost*state.settings.holding,rawEOQ=holding>0?Math.sqrt(2*daily*365*state.settings.orderCost/holding):0,cappedEOQ=item.shelf?Math.min(rawEOQ,daily*item.shelf):rawEOQ;
 const onHand=inventory(state,item.sku),onOrder=state.purchaseOrders.filter(isOpenPO).reduce((sum,p)=>sum+p.lines.filter(l=>l.sku===item.sku).reduce((n,l)=>n+Math.max(0,l.qty-l.received)*item.factor,0),0),position=onHand+onOrder,reviewDays=state.settings.reviewDays??7,target=daily*(lead+state.settings.safetyDays+reviewDays),need=Math.max(0,target-position);let suggested=need>0?Math.max(cappedEOQ,need):0;const shelfCap=item.shelf?daily*item.shelf:Infinity;suggested=Math.min(suggested,shelfCap);let packs=Math.ceil(suggested/item.factor);if(Number.isFinite(shelfCap)&&shelfCap>=item.factor)packs=Math.min(packs,Math.floor(shelfCap/item.factor));return{daily,supplier,lead,rop,rawEOQ,cappedEOQ,onHand,onOrder,position,reviewDays,target,need,packs,baseQty:packs*item.factor,packExceedsShelf:packs>0&&packs*item.factor>shelfCap,belowROP:position<rop};
}
export function recordInventoryReview(state:AppState,notes:string){return{...state,inventoryReviews:[{id:uid('REVIEW'),date:today(),notes:notes.trim(),reviewer:'Manager'},...(state.inventoryReviews??[])]};}
export function upgradePurchasing(state:AppState):boolean{
 let changed=false;state.supplierRecords??=getSuppliers(state);state.itemSupplierIds??={};state.purchaseReceipts??=[];state.supplierInvoices??=[];state.supplierPayments??=[];state.inventoryReviews??=[];
 for(const i of items.filter(i=>!i.recipe)){if(!state.itemSupplierIds[i.sku]){const supplier=state.supplierRecords.find(s=>s.name===i.supplier);if(supplier)state.itemSupplierIds[i.sku]=supplier.id;}}
 for(const po of state.purchaseOrders){if(po.supplierId)continue;changed=true;const supplier=state.supplierRecords.find(s=>s.name===po.supplier);if(!supplier)continue;po.supplierId=supplier.id;po.location??='Central Commissary';po.quotedLead??=supplier.lead;po.sentAt??=po.date;for(let n=0;n<po.lines.length;n++){const l=po.lines[n],i=items.find(i=>i.sku===l.sku)!;l.id=po.id+'-L'+n;
  if(/^PO-(?:\d{3}|OPEN-\d+)$/.test(po.id)){const actual=state.ledger.find(t=>t.reference===po.id&&t.type==='Receipt'&&t.item===l.sku&&t.id.startsWith('RCV-'));l.unitPrice=actual?actual.unitCost*i.factor:l.unitPrice*i.factor;}
 }
 if(po.received&&po.lines.some(l=>l.received>0)){
  const actual=state.ledger.filter(t=>t.reference===po.id&&t.type==='Receipt'&&t.qty>0).sort((a,b)=>a.date.localeCompare(b.date));
  const imported:PurchaseReceipt[]=[];const recorded=new Map<string,number>();
  for(const tx of actual){const line=po.lines.find(l=>l.sku===tx.item);if(!line)continue;const i=items.find(i=>i.sku===tx.item)!;const qty=tx.qty/i.factor;recorded.set(line.id!,(recorded.get(line.id!)??0)+qty);imported.push({id:'RCV-LEGACY-'+tx.id,poId:po.id,date:tx.date,location:tx.location,final:false,lines:[{lineId:line.id!,sku:line.sku,qty,unitPrice:tx.unitCost*i.factor}]});}
  const remaining=po.lines.map(l=>({lineId:l.id!,sku:l.sku,qty:Math.max(0,l.received-(recorded.get(l.id!)??0)),unitPrice:l.unitPrice})).filter(l=>l.qty>.000001);
  if(remaining.length)imported.push({id:'RCV-LEGACY-'+po.id,poId:po.id,date:po.received,location:po.location,final:false,lines:remaining});
  imported.sort((a,b)=>a.date.localeCompare(b.date));if(imported.length){po.received=imported[imported.length-1].date;imported[imported.length-1].final=isDeliveredPO(po);}
  for(const receipt of imported){state.purchaseReceipts.push(receipt);const amount=Math.round(receipt.lines.reduce((n,l)=>n+l.qty*l.unitPrice,0)*100)/100;const invoice:SupplierInvoice={id:'INV-'+receipt.id,poId:po.id,receiptId:receipt.id,supplierId:supplier.id,date:receipt.date,due:addDays(receipt.date,po.terms),amount};state.supplierInvoices.push(invoice);
   const index=state.supplierInvoices.length,knownSample=/^PO-(?:\d{3}|SAMPLE-)/.test(po.id);if(knownSample&&po.date<addDays(today(),-14)&&index%4!==0)state.supplierPayments.push({id:'PAY-'+receipt.id,invoiceId:invoice.id,date:invoice.due<today()?invoice.due:today(),amount,reference:'Historical supplier payment'});
  }
 }

 }
 if(diversifySamplePurchases(state))changed=true;
 if(state.purchasingVersion!==1){state.purchasingVersion=1;state.settings.reviewDays??=7;changed=true;}return changed;
}

export function purchaseOrderSearch(state:AppState,query:string,status='All'){
 const normalized=query.trim().toLowerCase();
 const matchedItem=normalized?items.find(i=>i.sku.toLowerCase()===normalized||i.barcode.toLowerCase()===normalized):undefined;
 const matchingOrders=state.purchaseOrders.filter(po=>`${po.id} ${po.supplier} ${po.lines.map(l=>{const i=items.find(i=>i.sku===l.sku);return `${l.sku} ${i?.barcode??''} ${i?.name??''}`;}).join(' ')}`.toLowerCase().includes(normalized));
 const orders=matchingOrders.filter(po=>status==='All'||po.status===status);
 // A scanned item puts receivable orders ahead of historical deliveries without selecting a PO for the user.
 if(matchedItem)orders.sort((a,b)=>Number(isOpenPO(b))-Number(isOpenPO(a))||b.date.localeCompare(a.date));
 return {matchedItem,matchingOrders,orders,openOrders:matchedItem?matchingOrders.filter(isOpenPO):[],hiddenCount:matchingOrders.length-orders.length};
}

// Preserve small changes without presenting an imperfect record as 100%.
export function formatSupplierScore(value:number|null){
 if(value===null)return '—';if(value>99.99&&value<100)return '>99.99';if(value>0&&value<.01)return '<0.01';return value.toFixed(2);
}
export function formatSupplierPercent(value:number|null){return value===null?'—':formatSupplierScore(value*100)+'%';}
