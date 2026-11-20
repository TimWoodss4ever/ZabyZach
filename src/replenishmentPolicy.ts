// Shared EOQ/review policy. Inputs and outputs use inventory base units;
// only packs cross the purchasing boundary. Confirmed MRP demand is separate.
export type OrderingOptions={order_cost:number;holding_rate:number;safety_days:number;review_days:number};
export function purchasePackPrice(unitCost:number,factor:number){return Math.round(unitCost*factor*100)/100;}
export function replenishmentPolicy(input:{daily:number;onHand:number;onOrder:number;factor:number;cost:number;lead:number;shelfLife:number|null;options:OrderingOptions}){
 const {daily,onHand,onOrder,factor,cost,lead,shelfLife,options:o}=input;
 const valid=[daily,onHand,onOrder,factor,cost,lead,o.order_cost,o.holding_rate,o.safety_days,o.review_days].every(Number.isFinite)&&daily>=0&&onOrder>=0&&factor>0&&cost>=0&&lead>=0&&o.order_cost>=0&&o.holding_rate>0&&o.safety_days>=0&&o.review_days>=0;
 if(!valid)throw Error('Review usage, pack size, cost and ordering options before replenishing.');
 const rop=daily*(lead+o.safety_days),rawEOQ=cost>0?Math.sqrt(2*daily*365*o.order_cost/(cost*o.holding_rate)):0;
 const eoq=shelfLife?Math.min(rawEOQ,daily*shelfLife):rawEOQ;
 const position=onHand+onOrder,target=daily*(lead+o.safety_days+o.review_days),need=Math.max(0,target-position);
 const desired=need>0?Math.max(need,eoq):0,limited=shelfLife?Math.min(desired,Math.max(0,daily*shelfLife-position)):desired;
 const packs=limited>0?Math.ceil(limited/factor):0;
 return{daily,onHand,onOrder,position,rop,rawEOQ,eoq,target,packs,belowROP:position<rop,packExceedsShelf:!!shelfLife&&packs*factor+position>daily*shelfLife};
}
export type DraftReference={id?:string;po_no?:string;location_id:string;item_sku:string;source?:string};
export function matchingDrafts(drafts:DraftReference[],location:string,sku:string){return drafts.filter(d=>d.location_id===location&&d.item_sku===sku);}
