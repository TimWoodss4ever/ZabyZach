import type {SalesOrder,Location} from './domain.ts';
type Response={data:unknown;error:{message:string;code?:string}|null};
type Invoke=(name:string,args:Record<string,unknown>)=>PromiseLike<Response>;
const requestKey=(userId:string,scope:string)=>'zbyzack-shared-planning:'+userId+':'+scope;
export function hasPendingPlanningRequest(userId:string,scope:string){try{return !!localStorage.getItem(requestKey(userId,scope));}catch{return false;}}
export function pendingPlanningRequest(userId:string,scope:string){
 const saved=localStorage.getItem(requestKey(userId,scope));if(!saved)return null;
 const r=JSON.parse(saved) as {id:string;payload:Record<string,unknown>};
 if(typeof r.id!=='string'||!r.payload||typeof r.payload!=='object')throw Error('Pending save details are invalid. Keep the saved browser data and ask your project manager for help.');
 return r;
}
export async function retryPlanningRequest(userId:string,scope:string,name:string,invoke:Invoke){
 const request=pendingPlanningRequest(userId,scope);if(!request)throw Error('No pending save remains. Refresh shared records.');
 return sendPlanningRequest(userId,scope,name,request.payload,invoke);
}
export type SharedOrderConfirmation=SalesOrder&{quotedLines?:{sku:string;qty:number;price:number}[];quotedSubtotal?:number;quotedDiscount?:number;quotedTax?:number};
export function sharedPickupConfirmation(payload:Record<string,unknown>,result:Record<string,unknown>):SharedOrderConfirmation{
 if(typeof result.id!=='string'||typeof result.total!=='number'||typeof payload.name!=='string'||typeof payload.location!=='string'||typeof payload.pickup!=='string'||!Array.isArray(payload.lines))throw Error('Order confirmation was incomplete. Check shared Sales Orders before placing another order.');
 if(result.status==='Cancelled')throw Error('Order '+result.orderNo+' was cancelled. It has not been reopened. Review the order before placing a new one.');
 const status=result.status??'Order Placed';
 if(!['Order Placed','Fulfilled','Closed'].includes(String(status)))throw Error('The saved order status could not be read. Check Sales Orders before ordering again.');
 const quotedLines=Array.isArray(result.lines)?result.lines as {sku:string;qty:number;price:number}[]:undefined;
 if(quotedLines?.some(l=>typeof l.sku!=='string'||!Number.isFinite(l.qty)||!Number.isFinite(l.price)))throw Error('The saved order prices could not be read.');
 return{quotedLines,quotedSubtotal:typeof result.subtotal==='number'?result.subtotal:undefined,quotedDiscount:typeof result.discount==='number'?result.discount:undefined,quotedTax:typeof result.tax==='number'?result.tax:undefined,id:result.id,orderNumber:Number(result.orderNo),saleId:typeof result.sale_id==='string'?result.sale_id:undefined,customer:payload.name,orderName:payload.name,customerPhone:String(payload.phone??''),location:payload.location as Location,pickup:payload.pickup.slice(0,10),pickupTime:payload.pickup.slice(11,16),status:status as SalesOrder['status'],lines:payload.lines as {sku:string;qty:number}[],discountPct:Number(payload.discountPct??0),discountAmount:Number(payload.discountAmount??0),notes:'Shared online pickup order',payment:{status:'Simulated paid',amount:result.total,reference:'Order '+result.orderNo,paidAt:new Date().toISOString()}};
}
// A lost response must retry the SAME request ID and payload, including after a
// refresh. Both server endpoints are idempotent. Never silently replace a save.
export async function sendPlanningRequest(userId:string,scope:string,name:string,payload:Record<string,unknown>,invoke:Invoke){
 const key=requestKey(userId,scope);
 const request=pendingPlanningRequest(userId,scope)??{id:crypto.randomUUID(),payload};
 if(JSON.stringify(request.payload)!==JSON.stringify(payload))throw Error('An earlier save is awaiting confirmation. Retry it with the original order details before starting another.');
 localStorage.setItem(key,JSON.stringify(request));
 const result=await invoke(name,(name==='erp_create_pickup_order'||name==='erp_checkout_order'||name==='erp_create_scheduled_production')?{p_request:request.id,p_payload:request.payload}:{p_request:request.id,p_action:'create_orders',p_payload:request.payload});
 if(result.error){if(/^(?:22|23|42|P0001)/.test(result.error.code??''))localStorage.removeItem(key);throw Error(result.error.message);}
 if(!result.data||typeof result.data!=='object')throw Error('Save confirmation was incomplete. Retry the same order details.');
 const value=result.data as Record<string,unknown>;
 if((name==='erp_create_pickup_order'||name==='erp_checkout_order')?(typeof value.id!=='string'||typeof value.orderNo!=='number'||!Number.isInteger(value.orderNo)||typeof value.total!=='number'||!Number.isFinite(value.total)):name==='erp_create_scheduled_production'?typeof value.id!=='string':!Array.isArray(value.ids))throw Error('Save confirmation was incomplete. Retry the same order details.');
 localStorage.removeItem(key);return result.data as Record<string,unknown>;
}
