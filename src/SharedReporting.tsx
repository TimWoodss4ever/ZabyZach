import {useCallback,useEffect,useRef,useState,type FormEvent,type ReactNode} from 'react';
import {supabase} from './supabase';
import {reportDate,shiftReportDate,validateReport,reportTotals,replenish,type ReportSnapshot,type ReportExpense,type ReportQuality,type ReportLowStock} from './reporting';
import './reporting.css';

const money=(n:number)=>n.toLocaleString('en-US',{style:'currency',currency:'USD'});
const unitMoney=(n:number)=>n.toLocaleString('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:6});
const number=(n:number)=>n.toLocaleString('en-US',{maximumFractionDigits:2});
const shortDate=(s:string)=>new Date(s+'T12:00:00Z').toLocaleDateString('en-US',{timeZone:'UTC',month:'short',day:'numeric',year:'numeric'});
const postedDate=(s:string)=>new Date(s).toLocaleString('en-US',{timeZone:'America/Denver',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'});

function useReport(from:string,to:string,location:string){
 const [data,setData]=useState<ReportSnapshot|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(true);
 const reloadRef=useRef<()=>void>(()=>{});
 const reload=useCallback(()=>reloadRef.current(),[]);
 useEffect(()=>{
  const abort=new AbortController();let active=true,running=false,again=false;
  setData(null);setError('');setBusy(true);
  const load=async()=>{
   if(!active)return;if(running){again=true;return;}running=true;setBusy(true);
   try{
    const result=await supabase.rpc('erp_reporting_current',{p_from:from,p_to:to,p_location:location||null}).abortSignal(abort.signal);
    if(result.error)throw Error(result.error.message);
    const report=validateReport(result.data);
    if(report.version!==2)throw Error('The reporting endpoint needs the reporting-quality migration.');
    if(active){setData(report);setError('');}
   }catch(reason){if(active)setError(reason instanceof Error?reason.message:'Unable to load shared reports.');}
   finally{running=false;if(active){setBusy(false);if(again){again=false;void load();}}}
  };
  reloadRef.current=()=>{void load();};void load();
  const refresh=()=>{if(document.visibilityState==='visible')void load();};
  const timer=window.setInterval(refresh,15000);
  window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);
  const channel=supabase.channel('shared-reporting-'+crypto.randomUUID())
   .on('postgres_changes',{event:'*',schema:'public',table:'sales'},refresh)
   .on('postgres_changes',{event:'*',schema:'public',table:'inventory_transactions'},refresh).subscribe();
  return()=>{active=false;abort.abort();window.clearInterval(timer);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);void supabase.removeChannel(channel);};
 },[from,to,location]);
 return {data,error,busy,reload};
}

function Metric({label,value,note}:{label:string;value:string;note?:string}){
 return <div className="panel sr-metric"><span>{label}</span><strong>{value}</strong>{note&&<small>{note}</small>}</div>;
}
function Empty(){return <p className="empty-inline">No shared records match this selection.</p>;}
function ReportTable({children}:{children:ReactNode}){return <div className="table-scroll sr-table"><table>{children}</table></div>;}

function LowStockRow({row:r,today}:{row:ReportLowStock;today:string}){
 const plan=replenish(r,today),activeSupplier=!!r.supplier&&!!r.supplier_active;
 const enoughOpenSupply=plan.packages===0&&r.on_order>0&&r.daily_usage>0&&plan.position>=r.daily_usage*(r.lead+r.safety+r.review);
 return <tr><td>{r.name}<small className="cell-sub">{r.location_name} · {r.item_sku}</small></td>
  <td>{r.supplier||'Unassigned'}<small className="cell-sub">{r.lead} days quoted lead{r.supplier&&!r.supplier_active?' · Inactive':''}</small></td>
  <td className="right">{number(r.quantity)} / {number(r.on_order)} {r.base_unit}<small className="cell-sub">{number(r.daily_usage)} {r.base_unit}/day</small>
   {!!r.openOrders?.length&&<details className="sr-open-orders"><summary>Outstanding deliveries ({r.openOrders.length})</summary><ul>{r.openOrders.map((o,index)=><li key={o.id+index}>{o.po_no} · {number(o.remaining_base)} {r.base_unit}<br/>{o.expected_on<today?'Delivery overdue · Expected ':o.expected_on===today?'Expected today · ':'Expected '}{shortDate(o.expected_on)}</li>)}</ul></details>}
  </td>
  <td className="right">{!activeSupplier?'Assign active supplier':r.daily_usage<=0?'Insufficient usage history':`${number(plan.packages)} ${r.purchase_unit}`}<small className="cell-sub">{plan.exceedsShelfLife?'Pack size exceeds shelf-life demand; review manually.':enoughOpenSupply?'Open orders cover the calculated target.':plan.packages===0&&r.daily_usage>0?'No additional quantity suggested; review stock and shelf-life limits.':''}</small></td>
  <td>{r.daily_usage<=0?'Unavailable':!activeSupplier?'Supplier review required':plan.packages===0?'No new order suggested':plan.orderBy?(plan.orderBy<today?'New order overdue · ':'')+shortDate(plan.orderBy):'Unavailable'}</td>
 </tr>;
}

function QualityDetails({quality,negativeHistory}:{quality:ReportQuality;negativeHistory:boolean}){
 return <>
  {quality.costSales.length>0&&<section className="panel sr-quality" aria-label="Recorded cost warnings"><p className="p-note" role="status">{quality.costSales.length} sale(s) affecting this period have recorded cost issues. Profit and turnover use posted costs and remain unverified. No costs have been substituted.</p>
   <details className="sr-details"><summary>View affected receipts, lines and returns</summary>{quality.costSales.map(s=><article className="sr-issue" key={s.sale_id}>
    <h3>{s.receipt_no} · {s.location_name}</h3><p>Sale {s.sale_id} · {postedDate(s.created_at)}</p><ul>{s.reasons.map(reason=><li key={reason}>{reason}</li>)}</ul>
    <p>Header COGS {money(s.header_cogs)} · Sum of line costs {money(s.line_cogs)}. Differences are assessed at half-cent precision before display rounding.</p>
    <ReportTable><thead><tr><th>ITEM / LINE ID</th><th className="right">QUANTITY</th><th className="right">POSTED UNIT COST</th><th className="right">POSTED LINE COST</th></tr></thead><tbody>{s.lines.map(l=><tr key={l.id}><td>{l.name} · {l.sku}<small className="cell-sub">{l.id}</small></td><td className="right">{number(l.quantity)}</td><td className="right">{unitMoney(l.unit_cost)}</td><td className="right">{money(l.quantity*l.unit_cost)}</td></tr>)}</tbody></ReportTable>
    {s.returns.length>0&&<><h4>Linked recorded returns through report end</h4><ul>{s.returns.map(r=><li key={r.id}>{r.id} · {postedDate(r.created_at)} · Refund before tax {money(r.refund_subtotal)} · Posted restock cost {money(r.restock_cost)}</li>)}</ul></>}
   </article>)}</details>
  </section>}
  {negativeHistory&&<section className="panel sr-quality" aria-label="Historical stock warnings"><p className="p-note" role="status">The ledger contains negative stock history. Inventory values remain unverified and turnover remains unavailable. Later positive stock does not erase these historical entries.</p>
   <details className="sr-details"><summary>View affected stock history ({quality.stockHistory.length} item/location pairs)</summary><p>Costs are pooled across locations, so source history from another store may appear here. Entries are ordered by timestamp and UUID; the final column distinguishes a negative timestamp-batch balance from a warning limited to ordering within that timestamp.</p>
    {!quality.stockHistory.length?<p>No location-level detail was returned. The existing historical warning is retained; review the company cost-pool history.</p>:<ReportTable><thead><tr><th>ITEM / LOCATION</th><th>RECORDED DATES</th><th className="right">LOWEST / CLOSING QUANTITY</th><th>FIRST NEGATIVE ENTRY</th><th>HISTORY BASIS</th></tr></thead><tbody>{quality.stockHistory.map(s=><tr key={s.sku+s.location_name}><td>{s.name}<small className="cell-sub">{s.sku} · {s.location_name}</small></td><td>First: {postedDate(s.first_negative_at)}<small className="cell-sub">Last: {postedDate(s.last_negative_at)}</small></td><td className="right">{number(s.lowest_balance)} / {number(s.closing_quantity)} {s.base_unit}</td><td>{s.reference_document||s.transaction_type}<small className="cell-sub">{s.transaction_type} · {s.transaction_id}</small><small className="cell-sub">Posted quantity {number(s.transaction_quantity)} · Unit cost {unitMoney(s.posted_unit_cost)}</small></td><td>{s.timestamp_batch_negative?'Negative after timestamp batch':'Within-timestamp order only; sequence unverified'}</td></tr>)}</tbody></ReportTable>}
   </details>
  </section>}
 </>;
}

export function SharedReporting({view}:{view:'financials'|'reports'}){
 const today=reportDate();
 const [from,setFrom]=useState(()=>shiftReportDate(today,-29)),[to,setTo]=useState(today),[location,setLocation]=useState('');
 const [inputs,setInputs]=useState({from:shiftReportDate(today,-29),to:today,location:''});
 const [validation,setValidation]=useState('');const {data,error,busy,reload}=useReport(from,to,location);
 // All locations is the default so changing screens never hides company expenses.
 const apply=(e:FormEvent)=>{e.preventDefault();if(!inputs.from||!inputs.to||inputs.from>inputs.to||inputs.to>today||inputs.from<shiftReportDate(inputs.to,-3660)){setValidation('Choose a valid date range of at most 3661 days ending today or earlier.');return;}setValidation('');setFrom(inputs.from);setTo(inputs.to);setLocation(inputs.location);if(from===inputs.from&&to===inputs.to&&location===inputs.location)reload();};
 const totals=data?reportTotals(data):null;
 const [grouping,setGrouping]=useState<'daily'|'weekly'>('daily');
 const [stockLocation,setStockLocation]=useState('');
 return <div className="shared-reporting">
  <form className="panel sr-filters" onSubmit={apply}>
   <label>From<input aria-label="Report start date" type="date" value={inputs.from} max={today} onChange={e=>setInputs({...inputs,from:e.target.value})}/></label>
   <label>Through<input aria-label="Report end date" type="date" value={inputs.to} max={today} onChange={e=>setInputs({...inputs,to:e.target.value})}/></label>
   <label>Location<select value={inputs.location} onChange={e=>setInputs({...inputs,location:e.target.value})}><option value="">All locations</option>{data?.locations.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
   <button className="button primary" type="submit">Apply</button><button className="button secondary" type="button" onClick={()=>{const d=new Date(today+'T12:00:00Z');d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()-6);const start=d.toISOString().slice(0,10);setInputs({...inputs,from:start,to:today});setFrom(start);setTo(today);setLocation(inputs.location);}}>Six months</button><button className="button secondary" type="button" onClick={reload} disabled={busy}>{busy?'Refreshing…':'Refresh now'}</button>
  </form>
  {validation&&<p role="alert" className="login-error">{validation}</p>}
  <p className="sr-status" aria-live="polite">Shared Supabase records · Mountain Time · refreshes every 15 seconds while visible{data&&<> · Updated {new Date(data.generatedAt).toLocaleTimeString()} · {shortDate(data.from)}–{shortDate(data.to)}</>}</p>
  {error&&<div role="alert" className="login-error">{data?'Refresh failed; the displayed report is stale. ':''}{error}<button className="table-action" onClick={reload}>Retry</button></div>}
  {!data&&!error&&<div className="panel empty-inline">Loading shared reports…</div>}
  {data&&totals&&<>
   {data.sampleHistory&&<p className="p-note">History available: {shortDate(data.sampleHistory.from)}–{shortDate(data.sampleHistory.to)}. Material costs use recorded catalog and recipe costs. Historical inventory turnover is unavailable where opening stock valuation is incomplete.</p>}
   {location&&<p className="p-note">This location excludes company-wide expenses. Choose All locations for the company P&amp;L.</p>}
   {data.quality&&<QualityDetails quality={data.quality} negativeHistory={data.inventory.some(v=>v.negative_history)}/>}
   {view==='financials'?<>
    <div className="sr-metrics"><Metric label="Net sales" value={money(totals.net)} note="Before tax, after discounts and refunds"/><Metric label="Gross profit" value={money(totals.grossProfit)} note="Net sales less posted COGS"/><Metric label="Recorded operating result" value={money(totals.result)} note="After saved expenses, waste and stock adjustments"/><Metric label="Inventory at period end" value={money(totals.closing)} note="Ledger-derived moving weighted average"/></div>
    <section className="panel"><div className="panel-head"><div><h2>Profit &amp; loss</h2><p>Only stored transactions are included. Unrecorded labor, rent or other expenses are excluded.</p></div></div>
     <ReportTable><thead><tr><th>ACCOUNT</th><th className="right">AMOUNT</th></tr></thead><tbody>{[
      ['Gross sales',data.pnl.gross],['Discounts',-data.pnl.discounts],['Returns / refunds',-data.pnl.refunds],['Net sales',totals.net],['Cost of goods sold',-data.pnl.cogs],['Gross profit',totals.grossProfit],['Recorded waste',-data.pnl.waste],['Inventory adjustments (gain / loss)',data.pnl.adjustments],['Recorded operating expenses',-data.pnl.expenses],['Recorded operating result',totals.result],['Sales tax collected, net of refunds (excluded from profit)',data.pnl.tax]
     ].map(([label,value])=><tr key={label}><td>{label}</td><td className="right">{money(Number(value))}</td></tr>)}</tbody></ReportTable>
    </section>
    <div className="sr-metrics"><Metric label="Opening inventory" value={money(totals.opening)}/><Metric label="Closing inventory" value={money(totals.closing)}/><Metric label="Average inventory" value={money(totals.average)} note="(Opening + closing) ÷ 2"/><Metric label="Inventory turnover" value={totals.turnover===null?'Unavailable':number(totals.turnover)+'×'} note="Period posted COGS ÷ average inventory; not annualized"/></div>
    <ExpenseRegister data={data} location={location} reload={reload}/>
   </>:<>
    <div className="sr-metrics"><Metric label="Net sales" value={money(totals.net)}/><Metric label="Recorded COGS" value={money(data.pnl.cogs)}/><Metric label="Gross profit" value={money(totals.grossProfit)}/><Metric label="Inventory value" value={money(totals.closing)}/></div>
    <div className="sr-two"><section className="panel"><div className="panel-head"><div><h2>Sales by {grouping==='daily'?'day':'week'}</h2><p>Net of discounts and refunds; before tax. Weeks start Monday.</p></div><select aria-label="Sales grouping" value={grouping} onChange={e=>setGrouping(e.target.value as 'daily'|'weekly')}><option value="daily">Daily</option><option value="weekly">Weekly</option></select></div><ReportTable><thead><tr><th>PERIOD</th><th className="right">NET SALES</th></tr></thead><tbody>{(grouping==='daily'?data.daily.map(d=>({date:d.day,net:d.net})):data.weekly.map(w=>({date:w.week,net:w.net}))).map(row=><tr key={row.date}><td>{shortDate(row.date)}</td><td className="right">{money(row.net)}</td></tr>)}</tbody></ReportTable></section>
    <section className="panel"><div className="panel-head"><div><h2>Top-selling items</h2><p>Net units sold during this period, after returns. Top 20.</p></div></div>{!data.topItems.length?<Empty/>:<ReportTable><thead><tr><th>ITEM</th><th className="right">NET UNITS</th></tr></thead><tbody>{data.topItems.map(i=><tr key={i.item_sku}><td>{i.name}<small className="cell-sub">{i.item_sku}</small></td><td className="right">{number(i.units)}</td></tr>)}</tbody></ReportTable>}</section></div>
    <section className="panel"><div className="panel-head"><div><h2>Low stock &amp; suggested replenishment</h2><p>Trailing 180-day material demand; lead time, safety stock, review interval and open supplier orders.</p></div></div>
     {to!==data.today?<p className="empty-inline">Choose an end date of today for current replenishment suggestions.</p>:!data.lowStock.length?<Empty/>:<ReportTable><thead><tr><th>ITEM / LOCATION</th><th>SUPPLIER</th><th className="right">ON HAND / ON ORDER</th><th className="right">SUGGESTED ORDER</th><th>ORDER BY</th></tr></thead><tbody>{data.lowStock.map(r=><LowStockRow key={r.item_sku+r.location_id} row={r} today={data.today}/>)}</tbody></ReportTable>}
     <p className="sr-footnote">Suggestions require manager review. Open receipts may be overdue; no orders are created automatically.</p>
    </section>
    <section className="panel"><div className="panel-head"><div><h2>Supplier performance</h2><p>Completed orders received within the selected period. Actual days to last delivery versus quoted days at ordering.</p></div></div><ReportTable><thead><tr><th>SUPPLIER</th><th className="right">ORDERS</th><th className="right">AVG ACTUAL DAYS</th><th className="right">AVG QUOTED DAYS</th><th className="right">LATE ORDERS</th></tr></thead><tbody>{data.suppliers.map(s=><tr key={s.id}><td>{s.name}</td><td className="right">{s.deliveries}</td><td className="right">{s.actual===null?'No receipt history':number(s.actual)}</td><td className="right">{s.quoted===null?'—':number(s.quoted)}{(s.legacy_quote_orders??0)>0&&<small className="cell-sub">{s.legacy_quote_orders} order(s) use current quote</small>}</td><td className="right">{s.late}</td></tr>)}</tbody></ReportTable><p className="sr-footnote">Received and Closed orders are included. Final delivery is determined across all receipts before filtering dates. Legacy orders without a saved quote use the supplier’s current quote; partial orders are excluded until completed.</p></section>
   </>}
   <section className="panel"><div className="panel-head"><div><h2>Inventory valuation by location</h2><p>As of {shortDate(data.to)} · base units · moving weighted-average cost reconstructed from posted ledger history.</p></div><select aria-label="Inventory detail location" value={stockLocation} onChange={e=>setStockLocation(e.target.value)}><option value="">All report locations</option>{data.locations.filter(l=>!location||l.id===location).map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
    <ReportTable><thead><tr><th>LOCATION</th><th className="right">VALUE</th></tr></thead><tbody>{data.locations.filter(l=>!location||l.id===location).map(l=><tr key={l.id}><td>{l.name}</td><td className="right">{money(data.inventory.filter(i=>i.location_id===l.id).reduce((s,i)=>s+i.quantity*i.average_cost,0))}</td></tr>)}</tbody></ReportTable>
    <details className="sr-details"><summary>Item quantities and costs</summary><ReportTable><thead><tr><th>ITEM / LOCATION</th><th className="right">QUANTITY</th><th className="right">AVERAGE COST / BASE UNIT</th><th className="right">VALUE</th></tr></thead><tbody>{data.inventory.filter(i=>(!stockLocation||i.location_id===stockLocation)&&i.quantity!==0).map(i=><tr key={i.item_sku+i.location_id}><td>{i.name}<small className="cell-sub">{i.location_name} · {i.item_sku}</small></td><td className="right">{number(i.quantity)} {i.base_unit}</td><td className="right">{i.average_cost.toLocaleString('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:6})}</td><td className="right">{money(i.quantity*i.average_cost)}</td></tr>)}</tbody></ReportTable></details>
    <p className="sr-footnote">Cost is pooled by item across locations. Transfers keep the company average unchanged. Posted sale COGS is preserved; past sales are never repriced. Negative stock history and same-time postings can limit valuation accuracy.</p>
   </section>
  </>}
 </div>;
}

function ExpenseRegister({data,location,reload}:{data:ReportSnapshot;location:string;reload:()=>void}){
 const [date,setDate]=useState(data.today),[expenseLocation,setExpenseLocation]=useState(location),[category,setCategory]=useState('Other'),[amount,setAmount]=useState(''),[description,setDescription]=useState('');
 const [message,setMessage]=useState(''),[saving,setSaving]=useState(false),[uncertain,setUncertain]=useState(false);
 const request=useRef<{p_id:string;p_date:string;p_location:string|null;p_category:string;p_amount:number;p_description:string}|null>(null);
 const lock=useRef(false);
 const [voiding,setVoiding]=useState<ReportExpense|null>(null),[reason,setReason]=useState('');
 const save=async(e:FormEvent)=>{e.preventDefault();if(lock.current)return;
  if(!request.current){const value=Number(amount);if(!Number.isFinite(value)||value<=0||value>999999999||Math.abs(value*100-Math.round(value*100))>0.000001||!description.trim()||!date||date>data.today){setMessage('Enter a valid date, positive amount with at most two decimal places, and description.');return;}
   request.current={p_id:crypto.randomUUID(),p_date:date,p_location:expenseLocation||null,p_category:category,p_amount:value,p_description:description.trim()};}
  lock.current=true;setSaving(true);setMessage('');
  try{const {data:id,error}=await supabase.rpc('erp_reporting_expense',request.current);if(error)throw Error(error.message);if(id!==request.current.p_id)throw Error('The server did not confirm this expense ID.');request.current=null;setUncertain(false);setAmount('');setDescription('');setMessage('Expense saved to shared records.');reload();}
  catch(error){setUncertain(true);setMessage((error instanceof Error?error.message:'Save was not confirmed.')+' Retry uses the same expense ID to prevent duplicates.');}
  finally{lock.current=false;setSaving(false);}
 };
 const voidExpense=async(e:FormEvent)=>{e.preventDefault();if(!voiding||lock.current)return;lock.current=true;setSaving(true);try{const {error}=await supabase.rpc('erp_reporting_void_expense',{p_id:voiding.id,p_reason:reason});if(error)throw Error(error.message);setVoiding(null);setReason('');setMessage('Expense voided; its audit record is retained.');reload();}catch(error){setMessage(error instanceof Error?error.message:'Void was not confirmed. You can retry safely.');}finally{lock.current=false;setSaving(false);}};
 return <section className="panel"><div className="panel-head"><div><h2>Shared operating expenses</h2><p>Manager-only records. Purchases stay in inventory until consumed; supplier payments are not additional expenses.</p></div></div>
  <form className="sr-expense" onSubmit={save}>
   <fieldset disabled={saving||uncertain}><label>Date<input type="date" required max={data.today} value={date} onChange={e=>setDate(e.target.value)}/></label><label>Location<select value={expenseLocation} onChange={e=>setExpenseLocation(e.target.value)}><option value="">Company-wide</option>{data.locations.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select></label><label>Category<select value={category} onChange={e=>setCategory(e.target.value)}>{['Labor','Rent','Utilities','Delivery','Other'].map(c=><option key={c}>{c}</option>)}</select></label><label>Amount ($)<input type="number" min="0.01" max="999999999" step="0.01" required value={amount} onChange={e=>setAmount(e.target.value)}/></label><label className="sr-description">Description<input required maxLength={500} value={description} onChange={e=>setDescription(e.target.value)}/></label></fieldset>
   <button type="submit" className="button primary" disabled={saving}>{saving?'Saving…':uncertain?'Retry same expense':'Save expense'}</button>
   {uncertain&&<button type="button" className="button secondary" disabled={saving} onClick={()=>{reload();setMessage('Check the expense register before entering another expense. Unconfirmed request: '+request.current?.p_id);}}>Check shared records</button>}
  </form>
  {message&&<p className="p-note" role="status">{message}</p>}
  {uncertain&&<p className="sr-footnote">If the server rejected the values, first check shared records; then <button type="button" className="table-action" onClick={()=>{if(window.confirm('An earlier save might have succeeded. Check the shared register before starting a different expense. Release this form?')){request.current=null;setUncertain(false);}}}>release this form</button> to correct them.</p>}
  {voiding&&<form className="sr-void" onSubmit={voidExpense}><label>Reason for voiding {money(voiding.amount)}<input required maxLength={500} value={reason} onChange={e=>setReason(e.target.value)}/></label><button className="button danger-outline" disabled={saving}>Confirm void</button><button className="button secondary" type="button" disabled={saving} onClick={()=>setVoiding(null)}>Cancel</button></form>}
  {!data.expenses.length?<Empty/>:<ReportTable><thead><tr><th>DATE / CATEGORY</th><th>DESCRIPTION / LOCATION</th><th className="right">AMOUNT</th><th>STATUS</th></tr></thead><tbody>{data.expenses.map(e=><tr key={e.id}><td>{shortDate(e.expense_date)}<small className="cell-sub">{e.category}</small></td><td>{e.description}<small className="cell-sub">{data.locations.find(l=>l.id===e.location_id)?.name||'Company-wide'} · {e.id}</small></td><td className="right">{money(e.amount)}</td><td>{e.voided_at?<span title={e.void_reason||''}>Voided</span>:<button className="table-action" disabled={saving} onClick={()=>{setVoiding(e);setReason('');}}>Void</button>}</td></tr>)}</tbody></ReportTable>}
 </section>;
}
