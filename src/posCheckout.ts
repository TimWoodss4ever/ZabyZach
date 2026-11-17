import type {Location} from './domain.ts';
import {normalizeCustomerPhone} from './domain.ts';

export type PosCustomer={id:string;name:string;phone:string;enrolled:boolean;points:number};
export type PosTicket={location:Location;lines:{sku:string;qty:number}[];discount:number;phone:string;name:string;redeem:boolean};
export type PosResult={sale_id:string;receipt_no:string;subtotal:number;discount:number;tax:number;total:number;cogs:number;rewards_earned:number;rewards_redeemed:number;rewards_balance:number|null};
type Pending=PosTicket&{request:string;locationId:string};
const key='zbz-shared-pos-pending-v1';
export function validPosResult(value:unknown):value is PosResult{
 if(!value||typeof value!=='object')return false;
 const r=value as Record<string,unknown>;
 return typeof r.sale_id==='string'&&typeof r.receipt_no==='string'&&
  ['subtotal','discount','tax','total','cogs','rewards_earned','rewards_redeemed'].every(k=>typeof r[k]==='number'&&Number.isFinite(r[k]))&&
  (r.rewards_balance===null||typeof r.rewards_balance==='number'&&Number.isFinite(r.rewards_balance));
}
export function createPosCheckout(api:any,storage:Storage){
 const readPendingPosSale=():Pending|null=>{const saved=storage.getItem(key);if(!saved)return null;return JSON.parse(saved) as Pending;};
 const loadPosCustomer=async(phone:string,name?:string):Promise<PosCustomer|null>=>{
  const normalized=normalizeCustomerPhone(phone);if(!normalized)throw Error('Enter a 10-digit US phone number.');
  const {data,error}=await api.rpc('erp_pos_customer',{p_phone:normalized,p_name:name??null});
  if(error)throw Error(`Rewards unavailable: ${error.message}`);
  if(data===null)return null;
  if(!data||typeof data.id!=='string'||typeof data.name!=='string'||typeof data.phone!=='string'||typeof data.enrolled!=='boolean'||!Number.isInteger(data.points))throw Error('Rewards returned an invalid customer. Retry lookup before checkout.');
  return data;
 };
 const send=async(pending:Pending):Promise<PosResult>=>{
  let response;
  try{response=await api.rpc('erp_pos_sale',{p_request:pending.request,p_location:pending.locationId,p_lines:pending.lines,p_discount_percent:pending.discount,p_phone:pending.phone||null,p_name:pending.name||null,p_redeem:pending.redeem});}
  catch{throw Error('Connection lost. Recover checkout confirmation to check the same sale safely.');}
  const {data,error}=response;
  if(error){
   // SQL/PostgREST rejections are definitive. Transport failures retain the ID.
   if(error.code&&(/^[0-9A-Z]{5}$/.test(error.code)||/^PGRST/.test(error.code))&&!/^08/.test(error.code))storage.removeItem(key);
   throw Error(`Checkout failed: ${error.message}${readPendingPosSale()?' Recover checkout confirmation before starting another sale.':''}`);
  }
  if(!validPosResult(data))throw Error('Sale confirmation could not be read. Recover checkout confirmation before starting another sale.');
  storage.removeItem(key);return data;
 };
 const postPosSale=async(ticket:PosTicket)=>{
  if(readPendingPosSale())throw Error('Recover checkout confirmation before starting another sale.');
  const {data,error}=await api.from('locations').select('id').eq('name',ticket.location).maybeSingle();
  if(error||!data)throw Error(error?.message||'The selected store is not configured.');
  const pending:Pending={...ticket,phone:ticket.phone.trim()?normalizeCustomerPhone(ticket.phone):'',name:ticket.name.trim(),request:crypto.randomUUID(),locationId:data.id};
  if(ticket.phone.trim()&&!pending.phone)throw Error('Enter a valid rewards phone.');
  // Persist before sending. Retries, including after reload, reuse this request.
  storage.setItem(key,JSON.stringify(pending));return send(pending);
 };
 const recoverPosSale=async()=>{const pending=readPendingPosSale();if(!pending)throw Error('No pending checkout.');return send(pending);};
 return {readPendingPosSale,loadPosCustomer,postPosSale,recoverPosSale};
}
