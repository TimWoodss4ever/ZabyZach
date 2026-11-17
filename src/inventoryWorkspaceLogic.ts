import type {InventoryItem,InventorySnapshot} from './inventoryManagement';
import {inventoryOnHand} from './inventoryManagement.ts';

export type StockItem=InventoryItem&{cost:number;recipe:Record<string,number>};
export type UsageRow={item_sku:string;location_id:string;quantity:number;transaction_type:string};
export type UsageByLocation=Record<string,Record<string,number>>;
export const stockedItem=(item:InventoryItem)=>!item.made||item.category==='Ingredient';
export const usageDays=180;
export function usageStart(today:string){const date=new Date(today+'T00:00:00Z');date.setUTCDate(date.getUTCDate()-usageDays);return date.toISOString();}
export function summarizeUsage(rows:UsageRow[]):UsageByLocation{
 const usage:UsageByLocation={};
 for(const row of rows){if(!Number.isFinite(row.quantity))throw Error('Recorded inventory usage is invalid.');
  if(row.quantity>=0||!['sale','production','production issue','backorder fulfillment'].includes(row.transaction_type.toLowerCase()))continue;
  const locations=usage[row.item_sku]??(usage[row.item_sku]={});locations[row.location_id]=(locations[row.location_id]??0)-row.quantity;
 }return usage;
}
export function reorderLevel(item:InventoryItem,usage:UsageByLocation,locationId:string,safetyDays:number):number|null{
 const consumed=usage[item.sku]?.[locationId];
 if(!stockedItem(item)||!consumed||item.leadDays===null||!item.supplierActive||!item.supplier)return null;
 const level=consumed/usageDays*(item.leadDays+Math.max(0,safetyDays));
 return item.unit==='each'?Math.ceil(level):level;
}
// Make-to-stock components (including dough) must already have been produced.
// Combine repeated ingredients before checking capacity; locations never pool stock.
export function canMake(data:InventorySnapshot,items:StockItem[],sku:string,locationId:string):number|null{
 const bySku=new Map(items.map(i=>[i.sku,i])),needed=new Map<string,number>();
 const visit=(key:string,quantity:number,path:Set<string>)=>{
  const item=bySku.get(key);if(!item||path.has(key))throw Error('Recipe needs review.');
  if(stockedItem(item)){needed.set(key,(needed.get(key)??0)+quantity);return;}
  const recipe=Object.entries(item.recipe);if(!recipe.length)throw Error('Recipe needs review.');
  const next=new Set(path).add(key);for(const [child,amount]of recipe){if(!Number.isFinite(amount)||amount<=0)throw Error('Recipe needs review.');visit(child,quantity*amount,next);}
 };
 try{visit(sku,1,new Set());if(!needed.size)return null;
  return Math.max(0,Math.min(...[...needed].map(([child,quantity])=>Math.floor((inventoryOnHand(data,child,locationId)+1e-8)/quantity))));
 }catch{return null;}
}
export function itemNeedsAttention(data:InventorySnapshot,item:InventoryItem,usage:UsageByLocation,locationIds:string[],safetyDays:number){
 if(!stockedItem(item))return false;
 return locationIds.some(id=>{const onHand=inventoryOnHand(data,item.sku,id),level=reorderLevel(item,usage,id,safetyDays);return onHand<=0||(level!==null&&onHand<level);});
}
