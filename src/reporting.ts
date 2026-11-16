export const REPORT_TIME_ZONE='America/Denver';
export function reportDate(value=new Date()):string {
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:REPORT_TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(value);
 return ['year','month','day'].map(k=>parts.find(p=>p.type===k)!.value).join('-');
}
export function shiftReportDate(date:string,days:number):string {
 const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);
}
export type ReportInventory={item_sku:string;name:string;category:string;base_unit:string;location_id:string;location_name:string;opening_quantity:number;quantity:number;opening_cost:number;average_cost:number;negative_history:boolean};
export type ReportLowStock=ReportInventory&{supplier:string|null;supplier_active:boolean|null;lead:number;daily_usage:number;on_order:number;safety:number;review:number;conversion_factor:number;purchase_unit:string;shelf_life_days:number|null};
export type ReportExpense={id:string;expense_date:string;location_id:string|null;category:string;amount:number;description:string;voided_at:string|null;void_reason:string|null};
export type ReportSnapshot={version:1;today:string;generatedAt:string;from:string;to:string;locations:{id:string;name:string}[];
 pnl:{gross:number;discounts:number;refunds:number;tax:number;cogs:number;waste:number;adjustments:number;expenses:number;zeroCostSales:number};
 inventory:ReportInventory[];daily:{day:string;net:number}[];weekly:{week:string;net:number}[];topItems:{item_sku:string;name:string;units:number}[];
 lowStock:ReportLowStock[];suppliers:{id:string;name:string;deliveries:number;actual:number|null;quoted:number|null;late:number}[];expenses:ReportExpense[]};
export function validateReport(value:unknown):ReportSnapshot {
 if(!value||typeof value!=='object')throw Error('The reporting service returned no report.');
 const r=value as ReportSnapshot;
 if(r.version!==1||!r.pnl||typeof r.generatedAt!=='string'||!Number.isFinite(Date.parse(r.generatedAt))||
  !['locations','inventory','daily','weekly','topItems','lowStock','suppliers','expenses'].every(k=>Array.isArray((r as unknown as Record<string,unknown>)[k]))||
  !['gross','discounts','refunds','tax','cogs','waste','adjustments','expenses','zeroCostSales'].every(k=>typeof r.pnl[k as keyof typeof r.pnl]==='number'&&Number.isFinite(r.pnl[k as keyof typeof r.pnl])))
  throw Error('The reporting service returned an unsupported or incomplete report.');
 const finiteFields=(rows:unknown[],keys:string[])=>rows.every(row=>row!==null&&typeof row==='object'&&keys.every(k=>typeof (row as Record<string,unknown>)[k]==='number'&&Number.isFinite((row as Record<string,unknown>)[k])));
 if(!finiteFields(r.inventory,['opening_quantity','quantity','opening_cost','average_cost'])||
  !finiteFields(r.daily,['net'])||!finiteFields(r.weekly,['net'])||!finiteFields(r.topItems,['units'])||
  !finiteFields(r.lowStock,['quantity','on_order','daily_usage','lead','safety','review','conversion_factor'])||
  !finiteFields(r.expenses,['amount']))throw Error('The reporting service returned incomplete numeric records.');
 return r;
}
export function reportTotals(r:ReportSnapshot){
 const p=r.pnl,net=p.gross-p.discounts-p.refunds,grossProfit=net-p.cogs;
 const opening=r.inventory.reduce((s,v)=>s+v.opening_quantity*v.opening_cost,0);
 const closing=r.inventory.reduce((s,v)=>s+v.quantity*v.average_cost,0),average=(opening+closing)/2;
 return {net,grossProfit,result:grossProfit-p.waste+p.adjustments-p.expenses,opening,closing,average,
  turnover:average>0&&p.cogs>=0&&!r.inventory.some(v=>v.negative_history)?p.cogs/average:null};
}
export function replenish(r:ReportLowStock,today:string){
 const position=r.quantity+r.on_order;
 const target=r.daily_usage*(r.lead+r.safety+r.review);
 // Shelf life caps the total projected inventory position, including open POs.
 const cap=r.shelf_life_days===null?Infinity:r.daily_usage*r.shelf_life_days;
 const base=Math.max(0,Math.min(target,cap)-position);
 const pack=r.conversion_factor;
 const packages=pack>0?Math.ceil(base/pack):0;
 const days=r.daily_usage>0?Math.floor(r.quantity/r.daily_usage-r.safety-r.lead):null;
 return {position,packages,base:packages*pack,exceedsShelfLife:packages>0&&position+packages*pack>cap,
  orderBy:days===null?null:shiftReportDate(today,days)};
}
