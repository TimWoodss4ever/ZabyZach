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
export function sharedPickupConfirmation(payload:Record<string,unknown>,result:Record<string,unknown>):SalesOrder{
 if(typeof result.id!=='string'||typeof result.total!=='number'||typeof payload.name!=='string'||typeof payload.location!=='string'||typeof payload.pickup!=='string'||!Array.isArray(payload.lines))throw Error('Order confirmation was incomplete. Check shared Sales Orders before placing another order.');
 return{id:result.id,customer:payload.name,orderName:payload.name,customerPhone:String(payload.phone??''),location:payload.location as Location,pickup:payload.pickup.slice(0,10),pickupTime:payload.pickup.slice(11,16),status:'Order Placed',lines:payload.lines as {sku:string;qty:number}[],discountPct:Number(payload.discountPct??0),discountAmount:Number(payload.discountAmount??0),notes:'Shared online pickup order',payment:{status:'Simulated paid',amount:result.total,reference:'SIM-'+result.id,paidAt:new Date().toISOString()}};
}
// A lost response must retry the SAME request ID and payload, including after a
// refresh. Both server endpoints are idempotent. Never silently replace a save.
export async function sendPlanningRequest(userId:string,scope:string,name:string,payload:Record<string,unknown>,invoke:Invoke){
 const key=requestKey(userId,scope);
 const request=pendingPlanningRequest(userId,scope)??{id:crypto.randomUUID(),payload};
 if(JSON.stringify(request.payload)!==JSON.stringify(payload))throw Error('An earlier save is awaiting confirmation. Retry it with the original order details before starting another.');
 localStorage.setItem(key,JSON.stringify(request));
 const result=await invoke(name,name==='erp_create_pickup_order'?{p_request:request.id,p_payload:request.payload}:{p_request:request.id,p_action:'create_orders',p_payload:request.payload});
 if(result.error){if(/^(?:22|23|42|P0001)/.test(result.error.code??''))localStorage.removeItem(key);throw Error(result.error.message);}
 if(!result.data||typeof result.data!=='object')throw Error('Save confirmation was incomplete. Retry the same order details.');
 const value=result.data as Record<string,unknown>;
 if(name==='erp_create_pickup_order'?(typeof value.id!=='string'||typeof value.total!=='number'||!Number.isFinite(value.total)):!Array.isArray(value.ids))throw Error('Save confirmation was incomplete. Retry the same order details.');
 localStorage.removeItem(key);return result.data as Record<string,unknown>;
}
