type Response={data:unknown;error:{message:string;code?:string}|null};
type Invoke=(name:string,args:Record<string,unknown>)=>PromiseLike<Response>;
// A lost response must retry the SAME request ID and payload, including after a
// refresh. Both server endpoints are idempotent. Never silently replace a save.
export async function sendPlanningRequest(userId:string,scope:string,name:string,payload:Record<string,unknown>,invoke:Invoke){
 const key='zbyzack-shared-planning:'+userId+':'+scope;
 const saved=localStorage.getItem(key);
 const request=saved?JSON.parse(saved) as {id:string;payload:Record<string,unknown>}:{id:crypto.randomUUID(),payload};
 if(JSON.stringify(request.payload)!==JSON.stringify(payload))throw Error('An earlier save is awaiting confirmation. Retry it with the original order details before starting another.');
 localStorage.setItem(key,JSON.stringify(request));
 const result=await invoke(name,name==='erp_create_pickup_order'?{p_request:request.id,p_payload:request.payload}:{p_request:request.id,p_action:'create_orders',p_payload:request.payload});
 if(result.error){if(/^(?:22|23|42|P0001)/.test(result.error.code??''))localStorage.removeItem(key);throw Error(result.error.message);}
 if(!result.data||typeof result.data!=='object')throw Error('Save confirmation was incomplete. Retry the same order details.');
 const value=result.data as Record<string,unknown>;
 if(name==='erp_create_pickup_order'?(typeof value.id!=='string'||typeof value.total!=='number'||!Number.isFinite(value.total)):!Array.isArray(value.ids))throw Error('Save confirmation was incomplete. Retry the same order details.');
 localStorage.removeItem(key);return result.data as Record<string,unknown>;
}
