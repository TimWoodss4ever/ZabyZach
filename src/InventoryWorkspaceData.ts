import {useEffect,useRef,useState} from 'react';
import {supabase} from './supabase';
import {validateInventorySnapshot} from './inventoryManagement';
import type {InventorySnapshot} from './inventoryManagement';
import {summarizeUsage,usageStart} from './inventoryWorkspaceLogic';
import type {StockItem,UsageByLocation,UsageRow} from './inventoryWorkspaceLogic';

export type InventoryWorkspaceData={snapshot:InventorySnapshot;items:StockItem[];usage:UsageByLocation|null;usageError:string|null;usageLoading:boolean};
const timed=<T,>(timings:Record<string,number>,name:string,request:()=>PromiseLike<T>)=>{const at=performance.now();return Promise.resolve(request()).finally(()=>{timings[name]=Math.round(performance.now()-at);});};
const logTimings=(name:string,timings:Record<string,number>,started:number)=>console.debug(`[Inventory] ${name} stage timings (ms)`,{...timings,total:Math.round(performance.now()-started)});
export async function readInventoryWorkspace(userId:string):Promise<InventoryWorkspaceData>{
 const timings:Record<string,number>={},started=performance.now();
 try{
  const response=await timed(timings,'erp_inventory_snapshot',()=>supabase.rpc('erp_inventory_snapshot'));if(response.error)throw Error(response.error.message);
  const snapshot=validateInventorySnapshot(response.data);if(snapshot.userId!==userId)throw Error('Your account changed. Reload inventory.');
  const [costs,bom]=await Promise.all([
   timed(timings,'items_costs',()=>supabase.from('items').select('sku,unit_cost')),
   timed(timings,'bom_lines',()=>supabase.from('bom_lines').select('parent_sku,component_sku,quantity'))
  ]);
  if(costs.error)throw Error(costs.error.message);if(bom.error)throw Error(bom.error.message);
  const bySku=new Map((costs.data??[]).map(i=>[i.sku,Number(i.unit_cost)])),recipes:Record<string,Record<string,number>>={};
  for(const line of bom.data??[]){const recipe=recipes[line.parent_sku]??(recipes[line.parent_sku]={});recipe[line.component_sku]=Number(line.quantity);}
  const items=snapshot.items.map(item=>{const cost=bySku.get(item.sku);if(cost===undefined||!Number.isFinite(cost))throw Error('Item costs could not be loaded.');return{...item,cost,recipe:recipes[item.sku]??{}};});
  return{snapshot,items,usage:null,usageError:'Usage history is loading.',usageLoading:true};
 }finally{
  logTimings('essential',timings,started);
 }
}
export async function readInventoryWorkspaceUsage(today:string):Promise<Pick<InventoryWorkspaceData,'usage'|'usageError'|'usageLoading'>>{
 const timings:Record<string,number>={},started=performance.now();
 try{
  const since=usageStart(today);
  const [recordedResult,sampleResult]=await Promise.allSettled([
   timed(timings,'erp_inventory_recorded_usage',()=>supabase.rpc('erp_inventory_recorded_usage',{p_since:since})),
   timed(timings,'erp_inventory_sample_usage',()=>supabase.rpc('erp_inventory_sample_usage'))
  ]);
  const usageRows:UsageRow[]=[];let usageError:string|null=null;
  if(recordedResult.status==='rejected')usageError=`Recorded usage unavailable: ${recordedResult.reason instanceof Error?recordedResult.reason.message:String(recordedResult.reason)}`;
  else if(recordedResult.value.error)usageError=`Recorded usage unavailable: ${recordedResult.value.error.message}`;
  else if(!Array.isArray(recordedResult.value.data))usageError='Recorded usage unavailable: the service returned an invalid response.';
  else for(const row of recordedResult.value.data){
   if(typeof row.item_sku!=='string'||typeof row.location_id!=='string'||!Number.isFinite(row.quantity)||row.quantity>=0){usageError='Recorded usage unavailable: the service returned invalid quantities.';break;}
   usageRows.push({...row,transaction_type:'Sale'});
  }
  if(!usageError){
   if(sampleResult.status==='rejected')usageError=`Sample usage unavailable: ${sampleResult.reason instanceof Error?sampleResult.reason.message:String(sampleResult.reason)}`;
   else if(sampleResult.value.error)usageError=`Sample usage unavailable: ${sampleResult.value.error.message}`;
   else if(!Array.isArray(sampleResult.value.data))usageError='Sample usage unavailable: the service returned an invalid response.';
   else for(const row of sampleResult.value.data){
    if(typeof row.item_sku!=='string'||typeof row.location_id!=='string'||!Number.isFinite(row.quantity)||row.quantity>=0){usageError='Sample usage unavailable: the service returned invalid quantities.';break;}
    usageRows.push({...row,transaction_type:'Sale'});
   }
  }
  const usage=usageError?null:summarizeUsage(usageRows);
  return{usage,usageError,usageLoading:false};
 }catch(error){
  return{usage:null,usageError:`Usage calculations unavailable: ${error instanceof Error?error.message:String(error)}`,usageLoading:false};
 }finally{
  logTimings('supplementary usage',timings,started);
 }
}
// One refresh owner updates Stock and Backorders from the same stock snapshot.
// A write arriving during a read queues a follow-up read, rather than being lost.
export function useInventoryWorkspace(userId:string){
 const [data,setData]=useState<InventoryWorkspaceData|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[updatedAt,setUpdatedAt]=useState<Date|null>(null);
 const refreshRef=useRef<()=>void>(()=>{});
 useEffect(()=>{
  let active=true,running=false,queued=false;setData(null);setError('');setUpdatedAt(null);
  const load=async(silent=false)=>{if(running){queued=true;return;}running=true;
   do{queued=false;if(active&&!silent)setLoading(true);try{const next=await readInventoryWorkspace(userId);if(active){setData(current=>current&&current.usage?{...next,usage:current.usage,usageError:null,usageLoading:false}:next);setUpdatedAt(new Date());setError('');}
     if(active)setLoading(false);
     const usage=await readInventoryWorkspaceUsage(next.snapshot.today);if(active)setData(current=>current?{...current,...usage}:current);}
    catch(e){if(active)setError(e instanceof Error?e.message:'Unable to refresh shared inventory.');}
   }while(active&&queued);
   running=false;if(active)setLoading(false);
  };
  const refresh=()=>{if(document.visibilityState!=='hidden')void load();};refreshRef.current=refresh;
  void load();const timer=window.setInterval(()=>{if(!running&&document.visibilityState!=='hidden')void load(true);},15000);
  window.addEventListener('erp-inventory-updated',refresh);window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);
  return()=>{active=false;window.clearInterval(timer);window.removeEventListener('erp-inventory-updated',refresh);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);refreshRef.current=()=>{};};
 },[userId]);
 return{data,loading,error,updatedAt,refresh:()=>refreshRef.current()};
}
