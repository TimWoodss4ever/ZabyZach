// Pure dated MRP calculation. Quantities are always in inventory base units.
export type PlanItem={sku:string;name:string;category:string;base_unit:string;purchase_unit:string;conversion_factor:number;lead_days:number;supplier_id:string|null;active:boolean;selling_price:number;unit_cost:number};
export type BomLine={parent_sku:string;component_sku:string;quantity:number};
export type PlanOrder={id:string;location_id:string;pickup_at:string;status:string;erp_name:string|null;erp_phone:string|null;erp_prepared_at:string|null;erp_sale_id:string|null;discount_pct:number;discount_amount:number};
export type PlanLine={order_id:string;item_sku:string;quantity:number;unit_price:number};
export type PlanSnapshot={version:1;today:string;userId:string;items:PlanItem[];bom:BomLine[];locations:{id:string;name:string;can_sell:boolean}[];purchaseDrafts?:{location_id:string;item_sku:string}[];suppliers:{id:string;name:string;quoted_lead_days:number;erp_active:boolean}[];orders:PlanOrder[];lines:PlanLine[];stock:{item_sku:string;location_id:string;quantity:number}[];receipts:{id:string;item_sku:string;location_id:string;due:string;quantity:number;kind:'Purchase'|'Production'}[];production:{id:string;order_no:string;parent_sku:string;location_id:string;quantity_started:number;status:string;erp_due_date:string|null}[]};
export type PlanDemand={sku:string;location:string;date:string;qty:number;reference:string};
export type PlanAction={date:string;orderBy:string;net:number;quantity:number;packs:number;late:boolean};
export type PlanRow={item:PlanItem;location:string;made:boolean;lead:number;onHand:number;onOrder:number;gross:number[];net:number[];receipts:number[];projected:number[];actions:PlanAction[];sources:PlanDemand[];transfer:{location:string;quantity:number}[]};
export const shiftDate=(date:string,days:number)=>{const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);};
export const localDate=(value:string)=>/^\d{4}-\d{2}-\d{2}$/.test(value)?value:new Intl.DateTimeFormat('en-CA',{timeZone:'America/Denver',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
export function readPlanSnapshot(value:unknown):PlanSnapshot{
 if(!value||typeof value!=='object')throw Error('Invalid shared planning response.');
 const d=value as PlanSnapshot;
 if(d.version!==1||!/^\d{4}-\d{2}-\d{2}$/.test(d.today)||typeof d.userId!=='string')throw Error('Shared planning migration is not available.');
 for(const k of ['items','bom','locations','suppliers','orders','lines','stock','receipts','production'] as const)if(!Array.isArray(d[k]))throw Error('Incomplete shared plan: '+k);
 return d;
}
export function calculateMrp(d:PlanSnapshot){
 const end=shiftDate(d.today,28),catalog=new Map(d.items.map(i=>[i.sku,i])),recipes=new Map<string,BomLine[]>(),warnings:string[]=[];
 for(const i of d.items){if(!Number.isFinite(Number(i.lead_days))||Number(i.lead_days)<0)throw Error('Invalid component lead time: '+i.sku);if(!(Number(i.conversion_factor)>0))throw Error('Invalid purchase conversion: '+i.sku);}
 for(const b of d.bom){if(!catalog.has(b.parent_sku)||!catalog.has(b.component_sku)||!(Number(b.quantity)>0))throw Error('Invalid BOM component: '+b.parent_sku+' → '+b.component_sku);recipes.set(b.parent_sku,[...(recipes.get(b.parent_sku)??[]),b]);}
 // Parent-first topological order allows every use of a shared component to be
 // accumulated before that component is netted or exploded further.
 const visited=new Set<string>(),visiting=new Set<string>(),order:string[]=[];
 const visit=(sku:string)=>{if(visiting.has(sku))throw Error('BOM cycle at '+sku);if(visited.has(sku))return;visiting.add(sku);for(const b of recipes.get(sku)??[])visit(b.component_sku);visiting.delete(sku);visited.add(sku);order.push(sku);};
 for(const i of d.items)visit(i.sku);order.reverse();
 const demand=new Map<string,PlanDemand[]>(),key=(sku:string,loc:string)=>loc+'|'+sku;
 const add=(r:PlanDemand)=>{if(r.qty>0)demand.set(key(r.sku,r.location),[...(demand.get(key(r.sku,r.location))??[]),r]);};
 for(const so of d.orders.filter(o=>o.status==='Order Placed'&&!o.erp_prepared_at)){
  const due=localDate(so.pickup_at);if(due>=end)continue;
  if(due<d.today)warnings.push('Overdue pickup '+so.id.slice(0,8)+' is included in Week 1.');
  for(const l of d.lines.filter(l=>l.order_id===so.id)){if(!catalog.has(l.item_sku)||!(Number(l.quantity)>0))throw Error('Invalid sales-order line: '+so.id);add({sku:l.item_sku,location:so.location_id,date:due,qty:Number(l.quantity),reference:'Order '+so.id.slice(0,8)});}
 }
 const receipts=d.receipts.filter(r=>{if(localDate(r.due)<d.today){warnings.push('Overdue '+r.kind.toLowerCase()+' receipt '+r.id.slice(0,8)+' is excluded until its date is updated or it is received.');return false;}return true;});
 for(const p of d.production.filter(p=>['Planned','In Progress'].includes(p.status))){
  if(!p.erp_due_date||p.erp_due_date<d.today){warnings.push('Set a current due date for production '+p.order_no+'; its output is not counted as available.');}
  // In-progress ingredients have already been issued. Planned orders commit
  // ingredients whether or not their completion date is reliable.
  if(p.status==='Planned'&&(!p.erp_due_date||p.erp_due_date<end))for(const b of recipes.get(p.parent_sku)??[])add({sku:b.component_sku,location:p.location_id,date:p.erp_due_date??d.today,qty:Number(p.quantity_started)*Number(b.quantity),reference:p.order_no});
 }
 const rows:PlanRow[]=[];
 for(const sku of order)for(const location of d.locations){
  const item=catalog.get(sku)!,made=recipes.has(sku),supplier=d.suppliers.find(s=>s.id===item.supplier_id);
  const lead=made?Number(item.lead_days):Number(supplier?.quoted_lead_days??item.lead_days);
  if(!Number.isFinite(lead)||lead<0)throw Error('Invalid lead time for '+item.name);
  const sources=(demand.get(key(sku,location.id))??[]).sort((a,b)=>a.date.localeCompare(b.date));
  const incoming=receipts.filter(r=>r.item_sku===sku&&r.location_id===location.id&&localDate(r.due)<end);
  const onHand=d.stock.filter(s=>s.item_sku===sku&&s.location_id===location.id).reduce((n,s)=>n+Number(s.quantity),0);
  const row:PlanRow={item,location:location.id,made,lead,onHand,onOrder:incoming.reduce((n,r)=>n+Number(r.quantity),0),gross:[0,0,0,0],net:[0,0,0,0],receipts:[0,0,0,0],projected:[0,0,0,0],actions:[],sources,transfer:[]};
  const week=(date:string)=>Math.max(0,Math.floor((Date.parse(date+'T12:00:00Z')-Date.parse(d.today+'T12:00:00Z'))/604800000));
  const dates=[...new Set([...sources.map(s=>s.date),...incoming.map(r=>localDate(r.due)),...Array.from({length:4},(_,n)=>shiftDate(d.today,n*7+6))])].sort();
  let balance=onHand;
  for(const date of dates){const w=week(date);if(w>3)continue;
   const arrival=incoming.filter(r=>localDate(r.due)===date).reduce((n,r)=>n+Number(r.quantity),0);balance+=arrival;row.receipts[w]+=arrival;
   const due=sources.filter(s=>s.date===date).reduce((n,s)=>n+s.qty,0);row.gross[w]+=due;
   if(due>0){const net=Math.max(0,due-balance);if(net>1e-8){
    const packs=made?Math.ceil(net):Math.ceil((net-1e-8)/Number(item.conversion_factor)),quantity=made?packs:packs*Number(item.conversion_factor),orderBy=shiftDate(date,-lead);
    row.actions.push({date,orderBy,net,quantity,packs,late:orderBy<d.today});row.net[w]+=net;balance+=quantity;
    if(made)for(const b of recipes.get(sku)!)add({sku:b.component_sku,location:location.id,date:orderBy,qty:quantity*Number(b.quantity),reference:'Make '+quantity+' × '+item.name+' for '+date});
   }balance-=due;}row.projected[w]=balance;
  }
  if(row.sources.length||row.onHand||row.onOrder||!made)rows.push(row);
 }
 // Only existing stock surplus AFTER the source location's own requirements is
 // offered. Allocate each available unit once; never auto-net a possible transfer.
 for(const sku of order){const group=rows.filter(r=>r.item.sku===sku);const surplus=new Map(group.map(r=>[r.location,Math.max(0,r.onHand-r.gross.reduce((n,q)=>n+q,0))]));
  for(const target of group){let needed=target.actions.reduce((n,a)=>n+a.net,0);for(const source of group){if(source.location===target.location||needed<=0)continue;const qty=Math.min(needed,surplus.get(source.location)??0);if(qty>0){target.transfer.push({location:source.location,quantity:qty});surplus.set(source.location,(surplus.get(source.location)??0)-qty);needed-=qty;}}}
 }
 return{rows,warnings:[...new Set(warnings)],end,parentCount:recipes.size};
}
