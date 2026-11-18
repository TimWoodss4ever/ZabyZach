export type InventoryItem={sku:string;name:string;barcode:string;category:string;unit:'oz'|'each';active:boolean;made:boolean;supplier:string|null;supplierActive:boolean;leadDays:number|null};
export type InventoryLocation={id:string;name:string};
export type IncomingStock={lineId:string;poId:string;poNo:string;sku:string;locationId:string;quantity:number;expectedOn:string};
export type InventoryBackorder={id:string;reference:string;item_sku:string;location_id:string;quantity_requested:number;quantity_fulfilled:number;status:'Open'|'Fulfilled'|'Cancelled';notes:string;cancellation_reason:string|null;created_at:string;updated_at:string;created_by:string};
export type InventorySnapshot={version:1;userId:string;today:string;items:InventoryItem[];locations:InventoryLocation[];stock:{item_sku:string;location_id:string;on_hand:number}[];incoming:IncomingStock[];backorders:InventoryBackorder[]};
export type InventoryAction='transfer'|'adjustment'|'create_backorder'|'fulfill_backorder'|'cancel_backorder';
export type InventoryRequest={id:string;action:InventoryAction;payload:Record<string,unknown>};
export type InventoryResult={requestId:string;action:InventoryAction;resourceId:string;variance:number|null};
const actions:InventoryAction[]=['transfer','adjustment','create_backorder','fulfill_backorder','cancel_backorder'];
const finite=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n);
export function validInventoryDate(value:unknown):value is string{if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const d=new Date(value+'T12:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===value;}
export function validateInventorySnapshot(value:unknown):InventorySnapshot{
 const d=value as InventorySnapshot;
 if(!d||d.version!==1||typeof d.userId!=='string'||!d.userId||!validInventoryDate(d.today)||!['items','locations','stock','incoming','backorders'].every(k=>Array.isArray((d as unknown as Record<string,unknown>)[k])))throw Error('Inventory service returned an incomplete response.');
 const unique=(xs:string[])=>xs.every(x=>typeof x==='string'&&!!x)&&new Set(xs).size===xs.length;
 if(!unique(d.items.map(i=>i.sku))||!unique(d.locations.map(l=>l.id))||!unique(d.incoming.map(i=>i.lineId))||!unique(d.backorders.map(b=>b.id)))throw Error('Inventory service returned duplicate or missing identifiers.');
 const items=new Set(d.items.map(i=>i.sku)),locations=new Set(d.locations.map(l=>l.id));
 if(d.items.some(i=>!i.name||typeof i.barcode!=='string'||!['oz','each'].includes(i.unit)||typeof i.active!=='boolean'||typeof i.made!=='boolean'||typeof i.supplierActive!=='boolean'||!(i.supplier===null||typeof i.supplier==='string')||!(i.leadDays===null||(finite(i.leadDays)&&Number.isInteger(i.leadDays)&&i.leadDays>=0)))||d.locations.some(l=>!l.name))throw Error('Inventory catalog has invalid units or supplier lead times.');
 if(!unique(d.stock.map(s=>s.item_sku+'@'+s.location_id))||d.stock.some(s=>!items.has(s.item_sku)||!locations.has(s.location_id)||!finite(s.on_hand)))throw Error('Inventory stock response is invalid.');
 if(d.incoming.some(i=>!items.has(i.sku)||!locations.has(i.locationId)||!finite(i.quantity)||i.quantity<=0||!validInventoryDate(i.expectedOn)||!i.poNo||!i.poId))throw Error('Incoming inventory response is invalid.');
 if(d.backorders.some(b=>!items.has(b.item_sku)||!locations.has(b.location_id)||!b.reference||!['Open','Fulfilled','Cancelled'].includes(b.status)||!finite(b.quantity_requested)||b.quantity_requested<=0||!finite(b.quantity_fulfilled)||b.quantity_fulfilled<0||b.quantity_fulfilled>b.quantity_requested||(b.status==='Fulfilled'&&b.quantity_fulfilled!==b.quantity_requested)||!Number.isFinite(Date.parse(b.created_at))||typeof b.notes!=='string'))throw Error('Backorder response is invalid.');
 return d;
}
export function validateInventoryQuantity(quantity:number,unit:'oz'|'each',allowZero=false){if(!finite(quantity)||quantity<(allowZero?0:.000001)||quantity>1e9||(unit==='each'&&!Number.isInteger(quantity)))throw Error(unit==='each'?'Enter a valid whole quantity.':'Enter a valid quantity in ounces.');return quantity;}
export const inventoryOnHand=(d:InventorySnapshot,sku:string,locationId:string)=>d.stock.find(s=>s.item_sku===sku&&s.location_id===locationId)?.on_hand??0;
export const remainingBackorder=(b:InventoryBackorder)=>Math.max(0,b.quantity_requested-b.quantity_fulfilled);
export const backorderQueue=(d:InventorySnapshot,sku:string,locationId:string)=>d.backorders.filter(b=>b.status==='Open'&&b.item_sku===sku&&b.location_id===locationId).sort((a,b)=>Date.parse(a.created_at)-Date.parse(b.created_at)||(a.id<b.id?-1:a.id>b.id?1:0));
export type Availability={date:string|null;source:'stock'|'purchase-order'|'supplier-estimate'|'overdue'|'insufficient'|'production'|'unassigned'|'review';label:string;needed:number;onHand:number;onOrder:number;overdueQuantity:number;leadTimeEstimate:string|null;deliveries:IncomingStock[]};
export function estimateInventoryAvailability(today:string,item:InventoryItem,onHand:number,deliveries:IncomingStock[],needed:number):Availability{
 if(!validInventoryDate(today)||!finite(onHand)||!finite(needed)||needed<=0)throw Error('Invalid availability inputs.');
 const ordered=[...deliveries].sort((a,b)=>a.expectedOn.localeCompare(b.expectedOn)||a.lineId.localeCompare(b.lineId));
 const onOrder=ordered.reduce((n,i)=>n+i.quantity,0),overdueQuantity=ordered.filter(i=>i.expectedOn<today).reduce((n,i)=>n+i.quantity,0);
 const date=new Date(today+'T12:00:00Z');if(item.leadDays!==null)date.setUTCDate(date.getUTCDate()+item.leadDays);
 const leadTimeEstimate=!item.made&&item.supplierActive&&item.supplier&&item.leadDays!==null?date.toISOString().slice(0,10):null;
 const result={date:null as string|null,source:'unassigned' as Availability['source'],label:'Supplier assignment needed',needed,onHand,onOrder,overdueQuantity,leadTimeEstimate,deliveries:ordered};
 if(onHand<0)return{...result,source:'review',label:'Negative on-hand; reconcile the physical count',leadTimeEstimate:null};
 let balance=onHand;if(balance+1e-8>=needed)return{...result,date:today,source:'stock',label:'Available from stock'};
 for(const incoming of ordered){if(incoming.expectedOn<today)continue;balance+=incoming.quantity;if(balance+1e-8>=needed)return{...result,date:incoming.expectedOn,source:'purchase-order',label:'Expected from purchase orders'};}
 if(item.made)return{...result,source:'production',label:'Production required; confirm a completion date'};
 if(overdueQuantity>0)return{...result,source:'overdue',label:'Overdue delivery; supplier confirmation needed'};
 if(onOrder>0)return{...result,source:'insufficient',label:'Scheduled receipts do not cover the full quantity'};
 if(leadTimeEstimate)return{...result,date:leadTimeEstimate,source:'supplier-estimate',label:'Supplier estimate if ordered today'};
 return result;
}
export function inventoryAvailability(d:InventorySnapshot,sku:string,locationId:string,quantity?:number,backorderId?:string){
 const item=d.items.find(i=>i.sku===sku);if(!item)throw Error('Unknown inventory item.');
 const queue=backorderQueue(d,sku,locationId);let needed:number;
 if(backorderId){const index=queue.findIndex(b=>b.id===backorderId);if(index<0)throw Error('Backorder is no longer open.');needed=queue.slice(0,index+1).reduce((n,b)=>n+remainingBackorder(b),0);}
 else needed=quantity===undefined?Math.max(1,queue.reduce((n,b)=>n+remainingBackorder(b),0)):queue.reduce((n,b)=>n+remainingBackorder(b),0)+quantity;
 return estimateInventoryAvailability(d.today,item,inventoryOnHand(d,sku,locationId),d.incoming.filter(i=>i.sku===sku&&i.locationId===locationId),needed);
}
export function fulfillableBackorder(d:InventorySnapshot,b:InventoryBackorder){const queue=backorderQueue(d,b.item_sku,b.location_id),index=queue.findIndex(q=>q.id===b.id);if(index<0)return 0;const earlier=queue.slice(0,index).reduce((n,q)=>n+remainingBackorder(q),0);return Math.max(0,Math.min(remainingBackorder(b),inventoryOnHand(d,b.item_sku,b.location_id)-earlier));}
const canonical=(value:unknown):string=>JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
export interface InventoryRequestStorage{getItem(key:string):string|null;setItem(key:string,value:string):void;removeItem(key:string):void;}
export class InventoryWriter{
 pending:InventoryRequest|null=null;busy=false;storageError='';storage:InventoryRequestStorage;key:string;transport:(r:InventoryRequest)=>Promise<unknown>;
 constructor(storage:InventoryRequestStorage,userId:string,transport:(r:InventoryRequest)=>Promise<unknown>){this.storage=storage;this.key='erp-inventory-pending:'+userId;this.transport=transport;try{const raw=storage.getItem(this.key);if(raw){const p=JSON.parse(raw);if(!p.id||!actions.includes(p.action)||!p.payload||typeof p.payload!=='object'||Array.isArray(p.payload))throw Error();this.pending=p;}}catch{this.storageError='The previous inventory request could not be read. Restore browser storage before posting another action.';}}
 async execute(action:InventoryAction,payload:Record<string,unknown>):Promise<InventoryResult>{
  if(this.busy)throw Error('An inventory action is already running.');if(this.storageError)throw Error(this.storageError);
  if(this.pending&&(this.pending.action!==action||canonical(this.pending.payload)!==canonical(payload)))throw Error('An earlier inventory action is awaiting confirmation. Retry that action before starting another.');
  const request=this.pending??{id:crypto.randomUUID(),action,payload};this.busy=true;
  try{try{this.storage.setItem(this.key,JSON.stringify(request));}catch{throw Error('Browser storage is unavailable. Restore it before posting inventory changes.');}this.pending=request;
   const result=await this.transport(request) as InventoryResult;
   if(!result||result.requestId!==request.id||result.action!==request.action||typeof result.resourceId!=='string'||!result.resourceId||!(result.variance===null||finite(result.variance))||(action==='adjustment'&&!finite(result.variance)))throw Error('The server response could not be confirmed. Retry the saved action; it will not post twice.');
   this.storage.removeItem(this.key);this.pending=null;return result;
  }catch(error){if((error as {confirmedRejected?:boolean})?.confirmedRejected){try{this.storage.removeItem(this.key);this.pending=null;}catch{/* Keep the request until a safe retry clears storage. */}}throw error;}finally{this.busy=false;}
 }
 retry(){if(!this.pending)return Promise.reject(Error('No saved inventory action to retry.'));return this.execute(this.pending.action,this.pending.payload);}
}
