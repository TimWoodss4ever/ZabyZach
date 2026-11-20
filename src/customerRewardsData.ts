export type RewardsActivity={id:string;occurred_at:string;label:string;reference:string;points:number;reserved_points:number};
export type CustomerRewards={status:'not_enrolled'}|{status:'link_review'}|{status:'ready';available:number;posted:number;reserved:number;activity:RewardsActivity[]};
export function validateCustomerRewards(value:unknown):CustomerRewards {
 if(!value||typeof value!=='object')throw Error('Rewards information was incomplete.');
 const r=value as CustomerRewards;
 if(r.status==='not_enrolled'||r.status==='link_review')return r;
 if(r.status!=='ready'||![r.available,r.posted,r.reserved].every(Number.isSafeInteger)||r.reserved<0||r.available!==r.posted-r.reserved||!Array.isArray(r.activity)||
  !r.activity.every(a=>a&&typeof a.id==='string'&&typeof a.label==='string'&&typeof a.reference==='string'&&typeof a.occurred_at==='string'&&Number.isFinite(Date.parse(a.occurred_at))&&Number.isSafeInteger(a.points)&&Number.isSafeInteger(a.reserved_points)&&a.reserved_points>=0))
  throw Error('Rewards information was incomplete. Refresh before using points.');
 return r;
}
export function rewardsProgress(points:number){return Math.max(0,Math.min(100,points));}
// Keep the existing request-ID persistence, validation and recovery transport.
// Old saved requests continue to use their original endpoint and payload.
export function customerRewardsRpc(payload:unknown){
 return payload&&typeof payload==='object'&&(payload as Record<string,unknown>).rewardsVersion===1
  ?'erp_customer_rewards_checkout':'erp_checkout_order';
}
