import { businessDate } from './domain.ts';
export const pickupSlots=Array.from({length:22},(_,index)=>{const minutes=11*60+index*30;return String(Math.floor(minutes/60)).padStart(2,'0')+':'+String(minutes%60).padStart(2,'0');});
export function pickupSchedule(date:string,now=new Date()){
 const today=businessDate(now);
 const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/Denver',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
 const hour=Number(parts.find(p=>p.type==='hour')?.value??0),minute=Number(parts.find(p=>p.type==='minute')?.value??0);
 const earliest=Math.ceil((hour*60+minute)/30)*30;
 const todayOptions=pickupSlots.filter(slot=>Number(slot.slice(0,2))*60+Number(slot.slice(3))>=earliest);
 const tomorrow=new Date(today+'T12:00:00Z');tomorrow.setUTCDate(tomorrow.getUTCDate()+1);
 const minDate=todayOptions.length?today:tomorrow.toISOString().slice(0,10);
 const options=date===today?todayOptions:pickupSlots;
 return{minDate,options};
}
