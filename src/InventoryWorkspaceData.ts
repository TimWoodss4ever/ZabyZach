import {useEffect,useRef,useState} from 'react';
import {supabase} from './supabase';
import {validateInventorySnapshot} from './inventoryManagement';
import type {InventorySnapshot} from './inventoryManagement';
import {summarizeUsage,usageStart} from './inventoryWorkspaceLogic';
import type {StockItem,UsageByLocation,UsageRow} from './inventoryWorkspaceLogic';

export type InventoryWorkspaceData={snapshot:InventorySnapshot;items:StockItem[];usage:UsageByLocation};
export async function readInventoryWorkspace(userId:string):Promise<InventoryWorkspaceData>{
 const response=await supabase.rpc('erp_inventory_snapshot');if(response.error)throw Error(response.error.message);
 const snapshot=validateInventorySnapshot(response.data);if(snapshot.userId!==userId)throw Error('Your account changed. Reload inventory.');
 const [costs,bom]=await Promise.all([supabase.from('items').select('sku,unit_cost'),supabase.from('bom_lines').select('parent_sku,component_sku,quantity')]);
 if(costs.error)throw Error(costs.error.message);if(bom.error)throw Error(bom.error.message);
 const bySku=new Map((costs.data??[]).map(i=>[i.sku,Number(i.unit_cost)])),recipes:Record<string,Record<string,number>>={};
 for(const line of bom.data??[]){const recipe=recipes[line.parent_sku]??(recipes[line.parent_sku]={});recipe[line.component_sku]=Number(line.quantity);}
 const items=snapshot.items.map(item=>{const cost=bySku.get(item.sku);if(cost===undefined||!Number.isFinite(cost))throw Error('Item costs could not be loaded.');return{...item,cost,recipe:recipes[item.sku]??{}};});
 const rows:UsageRow[]=[];const since=usageStart(snapshot.today);
 for(let from=0;;from+=1000){
  const result=await supabase.from('inventory_transactions').select('item_sku,location_id,quantity,transaction_type').lt('quantity',0).gte('occurred_at',since).order('occurred_at').order('id').range(from,from+999);
  if(result.error)throw Error(result.error.message);const page=(result.data??[]) as UsageRow[];rows.push(...page);if(page.length<1000)break;
 }
 return{snapshot,items,usage:summarizeUsage(rows)};
}
// One refresh owner updates Stock and Backorders from the same stock snapshot.
// A write arriving during a read queues a follow-up read, rather than being lost.
export function useInventoryWorkspace(userId:string){
 const [data,setData]=useState<InventoryWorkspaceData|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[updatedAt,setUpdatedAt]=useState<Date|null>(null);
 const refreshRef=useRef<()=>void>(()=>{});
 useEffect(()=>{
  let active=true,running=false,queued=false;setData(null);setError('');setUpdatedAt(null);
  const load=async()=>{if(running){queued=true;return;}running=true;
   do{queued=false;if(active)setLoading(true);try{const next=await readInventoryWorkspace(userId);if(active){setData(next);setUpdatedAt(new Date());setError('');}}
    catch(e){if(active)setError(e instanceof Error?e.message:'Unable to refresh shared inventory.');}
   }while(active&&queued);
   running=false;if(active)setLoading(false);
  };
  const refresh=()=>{if(document.visibilityState!=='hidden')void load();};refreshRef.current=refresh;
  void load();const timer=window.setInterval(()=>{if(!running)refresh();},15000);
  window.addEventListener('erp-inventory-updated',refresh);window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);
  return()=>{active=false;window.clearInterval(timer);window.removeEventListener('erp-inventory-updated',refresh);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);refreshRef.current=()=>{};};
 },[userId]);
 return{data,loading,error,updatedAt,refresh:()=>refreshRef.current()};
}
