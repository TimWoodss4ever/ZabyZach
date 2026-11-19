import {useCallback,useEffect,useRef,useState} from 'react';
import {supabase} from './supabase';
import {readPlanSnapshot} from './sharedMrp';
import type {PlanSnapshot} from './sharedMrp';

export function useSharedPlan(){
 const [data,setData]=useState<PlanSnapshot|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[stale,setStale]=useState(true);
 const [updatedAt,setUpdatedAt]=useState<Date|null>(null);
 const lock=useRef(false),generation=useRef(0),mounted=useRef(false);
 const load=useCallback(async()=>{const request=++generation.current;setLoading(true);try{
  const result=await supabase.rpc('erp_planning_snapshot');if(result.error)throw Error(result.error.message);
  const snapshot=readPlanSnapshot(result.data);if(!mounted.current||request!==generation.current)return false;
  setData(snapshot);setUpdatedAt(new Date());setError('');setStale(false);return true;
 }catch(e){if(mounted.current&&request===generation.current){setError(e instanceof Error?e.message:'Unable to load shared planning.');setStale(true);}return false;
 }finally{if(mounted.current&&request===generation.current)setLoading(false);}},[]);
 useEffect(()=>{mounted.current=true;void load();const refresh=()=>{if(!lock.current&&document.visibilityState==='visible')void load();};window.addEventListener('focus',refresh);window.addEventListener('erp-shared-purchasing-updated',refresh);window.addEventListener('erp-shared-planning-updated',refresh);const channel=supabase.channel('shared-orders-'+crypto.randomUUID()).on('postgres_changes',{event:'*',schema:'public',table:'sales_orders'},refresh).on('postgres_changes',{event:'*',schema:'public',table:'sales_order_lines'},refresh).subscribe();const timer=window.setInterval(refresh,15000);return()=>{mounted.current=false;generation.current++;window.clearInterval(timer);window.removeEventListener('focus',refresh);window.removeEventListener('erp-shared-purchasing-updated',refresh);window.removeEventListener('erp-shared-planning-updated',refresh);void supabase.removeChannel(channel);};},[load]);
 const write=async(operation:()=>Promise<unknown>)=>{if(lock.current||stale)return false;lock.current=true;setBusy(true);try{await operation();const refreshed=await load();if(!refreshed)setError('Saved. Refresh shared records before making another change.');window.dispatchEvent(new Event('erp-shared-planning-updated'));return true;}catch(e){setError(e instanceof Error?e.message:'Unable to confirm save. Retry the same action.');return false;}finally{lock.current=false;if(mounted.current)setBusy(false);}};
 return{data,error,loading,busy,updatedAt,locked:busy||stale||loading,load,write};
}
