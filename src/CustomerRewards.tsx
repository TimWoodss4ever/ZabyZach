import {useCallback,useEffect,useRef,useState} from 'react';
import {supabase} from './supabase';
import {validateCustomerRewards,rewardsProgress,type CustomerRewards} from './customerRewardsData';

export function useCustomerRewards(userId:string){
 const [result,setResult]=useState<{userId:string;data:CustomerRewards}|null>(null);
 const [failure,setFailure]=useState<{userId:string;message:string}|null>(null);
 const [loading,setLoading]=useState(false);const request=useRef(0);const controller=useRef<AbortController|null>(null);
 const refresh=useCallback(async()=>{
  const version=++request.current;controller.current?.abort();const abort=new AbortController();controller.current=abort;
  setLoading(true);
  try{
   const {data,error}=await supabase.rpc('erp_customer_rewards_snapshot').abortSignal(abort.signal);
   if(error)throw Error(error.message);
   const checked=validateCustomerRewards(data);
   if(version===request.current){setResult({userId,data:checked});setFailure(null);}
  }catch(error){if(version===request.current&&!abort.signal.aborted){setResult(null);setFailure({userId,message:error instanceof Error?error.message:'Unable to load rewards.'});}}
  finally{if(version===request.current)setLoading(false);}
 },[userId]);
 useEffect(()=>{
  void refresh();const visible=()=>{if(!document.hidden)void refresh();};
  const timer=window.setInterval(visible,15000);document.addEventListener('visibilitychange',visible);
  return()=>{++request.current;controller.current?.abort();window.clearInterval(timer);document.removeEventListener('visibilitychange',visible);};
 },[refresh]);
 return {data:result?.userId===userId?result.data:null,error:failure?.userId===userId?failure.message:'',loading,refresh};
}
type AreaProps={data:CustomerRewards|null;error:string;loading:boolean;onRefresh:()=>void};
export function MyRewards({data,error,loading,onRefresh}:AreaProps){
 return <section className="checkout-card" aria-label="My rewards">
  <h2>My rewards</h2><button type="button" className="table-action" onClick={onRefresh} disabled={loading}>{loading?'Refreshing…':'Refresh rewards'}</button>
  {error?<p role="alert">Unable to load rewards: {error}</p>:!data?<p role="status">Loading shared rewards…</p>:data.status==='not_enrolled'?<p>Your account is not enrolled in shared rewards yet. Ask store staff to verify your identity and enroll the customer record linked to this account. Entering a pickup phone number does not link rewards.</p>:data.status==='link_review'?<p>Your rewards link needs staff review. No membership has been linked automatically.</p>:<>
   <p><strong>{data.available} points available</strong> · {data.reserved} reserved for pending orders</p>
   <label>Progress toward a $5 reward <progress max={100} value={rewardsProgress(data.available)}/></label>
   <p>Earn 1 point per full $1 after discounts and before tax. Redeem 100 available points for $5 off an eligible order. Points are earned when the order becomes a completed sale.</p>
   {data.available<0&&<p>Returns have reduced your balance below zero. Future earnings apply to that balance under the existing rewards rules.</p>}
   <details><summary>Rewards activity · latest 50 entries</summary>{data.activity.length?<ul>{data.activity.map(a=><li key={a.id}>
    <time dateTime={a.occurred_at}>{new Date(a.occurred_at).toLocaleString('en-US',{timeZone:'America/Denver'})}</time> · {a.label} · {a.reference} · {a.points>0?'+':''}{a.points} points{a.reserved_points>0&&<> · {a.reserved_points} reserved</>}
   </li>)}</ul>:<p>No rewards activity has been recorded yet.</p>}</details>
  </>}
 </section>;
}
export function RewardsRedemption({data,redeem,onChange,afterWelcome,disabled}:{data:CustomerRewards|null;redeem:boolean;onChange:(value:boolean)=>void;afterWelcome:number;disabled:boolean}){
 const eligible=data?.status==='ready'&&data.available>=100&&afterWelcome>=5;
 return <fieldset disabled={disabled}><legend>Shared rewards</legend>
  <label><input type="checkbox" checked={redeem} disabled={!redeem&&!eligible} onChange={e=>onChange(e.target.checked)}/> Use 100 points for $5 off</label>
  <p>Requires 100 available points and at least $5 after other discounts. Rewards use your signed-in account, not the pickup phone number.</p>
  {data?.status==='ready'&&<p>{data.available} available · {data.reserved} reserved. Points are reserved at confirmation and released if the unprepared order is cancelled.</p>}
  {redeem&&!eligible&&<p role="alert">Rewards eligibility changed. Refresh or uncheck this option before submitting; checkout rechecks the shared balance.</p>}
 </fieldset>;
}
