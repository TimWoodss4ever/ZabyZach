import {useEffect, useRef, useState} from 'react';
import {AlertTriangle, ArrowLeftRight, ArrowUpRight, BookOpen, Boxes, CalendarClock, Check, CheckCircle2, ChevronRight, ClipboardList, Clock3, Factory, Package, RefreshCw, Search, ShoppingCart, X} from 'lucide-react';
import {InventoryDialog} from './InventoryDialog';
import {localDate, planLead, shiftDate} from './sharedMrp';
import type {calculateMrp, PlanRow, PlanSnapshot} from './sharedMrp';
import {hasMrpDraft, existingPurchaseDrafts, mrpPurchaseChoice, materialStatus, purchaseBlocker, rowKey, suggestedPacks, suggestedUnits, totalRequirement} from './mrpWorkspaceLogic';
import type {PurchaseMode} from './mrpWorkspaceLogic';
import './mrp.css';

type Tab = 'Requirements' | 'Recipes & BOMs' | 'Planning alerts';
type Props = {
  data: PlanSnapshot;
  plan: ReturnType<typeof calculateMrp>;
  loading: boolean;
  busy: boolean;
  locked: boolean;
  error: string;
  updatedAt?: Date | null;
  pendingPurchase: boolean;
  onRefresh: () => void;
  onPurchase: () => void;
  onTransfers: () => void;
  onProduction?: () => void;
  onOrders?: () => void;
  onSuppliers?: () => void;
  onRetryPurchase: () => void;
  onCreateDrafts: (rows: PlanRow[],mode:PurchaseMode) => Promise<boolean>;
  onSchedule: (id: string, due: string) => Promise<boolean>;
};
const qty = (value: number) => value.toLocaleString('en-US', {maximumFractionDigits: 3});
const date = (value: string) => new Date(value + 'T12:00:00').toLocaleDateString('en-US', {month: 'short', day: 'numeric'});
const money = (value: number) => value.toLocaleString('en-US', {style: 'currency', currency: 'USD'});
const tabs: Tab[] = ['Requirements', 'Recipes & BOMs', 'Planning alerts'];
const packPrice = (row: PlanRow) => Math.round(Number(row.item.unit_cost) * Number(row.item.conversion_factor) * 100) / 100;

export function MrpWorkspace(props: Props) {
  const {data, plan, loading, busy, locked, error, pendingPurchase, onRefresh, onPurchase, onTransfers, onProduction, onOrders, onSuppliers, onRetryPurchase, onCreateDrafts, onSchedule} = props;
  const [tab, setTab] = useState<Tab>('Requirements');
  const [locationId, setLocationId] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('demand');
  const [selected, setSelected] = useState<string[]>([]);
  const [detailSku, setDetailSku] = useState<string | null>(null);
  const [parentSku, setParentSku] = useState('');
  const [review, setReview] = useState(false);
  const [purchaseMode,setPurchaseMode]=useState<PurchaseMode>('minimum');
  const [period, setPeriod] = useState<'weeks'|'days'>('weeks');
  const [dailyWeek, setDailyWeek] = useState(0);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const location = data.locations.find(l => l.id === locationId) ?? data.locations.find(l => l.name === 'Provo Campus Store') ?? data.locations.find(l => l.can_sell) ?? data.locations[0];
  const here = location?.id ?? '';
  const locationName = (id: string) => data.locations.find(l => l.id === id)?.name ?? id;
  const rows = plan.rows.filter(row => row.location === here);
  const query = search.trim().toLowerCase();
  const visible = rows.filter(row => {
    if (query && !`${row.item.name} ${row.item.sku}`.toLowerCase().includes(query)) return false;
    if (filter === 'all') return true;
    if (filter === 'actions') return row.actions.length > 0;
    if (filter === 'buy') return !row.made && totalRequirement(row) > 0;
    if (filter === 'make') return row.made && totalRequirement(row) > 0;
    return totalRequirement(row) > 0;
  }).sort((a, b) => Number(b.actions.length > 0) - Number(a.actions.length > 0) || Number(a.made) - Number(b.made) || (a.actions[0]?.orderBy ?? '9999').localeCompare(b.actions[0]?.orderBy ?? '9999') || a.item.name.localeCompare(b.item.name));
  const eligible = visible.filter(row => !purchaseBlocker(data, row));
  const selectedRows = rows.filter(row => selected.includes(rowKey(row)) && !purchaseBlocker(data, row));
  const allVisibleSelected = eligible.length > 0 && eligible.every(row => selected.includes(rowKey(row)));
  const someVisibleSelected = eligible.some(row => selected.includes(rowKey(row)));
  useEffect(() => {if (selectAllRef.current) selectAllRef.current.indeterminate = someVisibleSelected && !allVisibleSelected;}, [someVisibleSelected, allVisibleSelected]);
  const alerts = plan.alerts.filter(alert => alert.location === here);
  const contributingOrders = new Set(rows.flatMap(row=>row.sources.flatMap(source=>source.orderIds??[])));
  const confirmed = data.orders.filter(order => order.location_id === here && order.status === 'Order Placed' && !order.erp_prepared_at && (localDate(order.pickup_at) < plan.end || contributingOrders.has(order.id)));
  const legacyOrders = confirmed.filter(order => !!order.erp_sale_id);
  const buyRows = rows.filter(row => !row.made && row.actions.length);
  const dueRows = rows.filter(row => row.actions.some(action => action.orderBy <= data.today));
  const transferRows = rows.filter(row => row.transfer.length);
  const detail = rows.find(row => row.item.sku === detailSku);
  const parents = data.items.filter(item => data.bom.some(line => line.parent_sku === item.sku));
  const parent = parents.find(item => item.sku === parentSku) ?? parents.find(item => item.category === 'Pizza') ?? parents[0];
  const componentLines = data.bom.filter(line => line.parent_sku === parent?.sku);
  const production = data.production.filter(order => order.location_id === here && ['Planned', 'In Progress'].includes(order.status));
  const choices=selectedRows.map(row=>({row,choice:mrpPurchaseChoice(data,row,purchaseMode)}));
  const selectedSuppliers=new Set(choices.flatMap(({row,choice})=>choice.actions.map(action=>row.location+'|'+row.item.supplier_id+'|'+action.date+'|'+action.orderBy))).size;
  const estimated=choices.reduce((sum,{choice})=>sum+choice.cost,0);
  const draftConflicts=rows.flatMap(row=>existingPurchaseDrafts(data,row).map(draft=>({row,draft})));
  const periods=Array.from({length:period==='weeks'?4:7},(_,index)=>({label:period==='weeks'?'WEEK '+(index+1):date(shiftDate(data.today,dailyWeek*7+index)),day:shiftDate(data.today,dailyWeek*7+index),index}));
  const cells=(row:PlanRow)=>periods.map(p=>period==='weeks'?{gross:row.gross[p.index],net:row.net[p.index]}:{gross:row.timeline.filter(t=>(t.date<data.today?data.today:t.date)===p.day).reduce((n,t)=>n+t.gross,0),net:row.timeline.filter(t=>(t.date<data.today?data.today:t.date)===p.day).reduce((n,t)=>n+t.net,0)});
  const changeLocation = (id: string) => {setLocationId(id); setSelected([]); setDetailSku(null); setReview(false);setPurchaseMode('minimum');};
  const toggle = (row: PlanRow) => setSelected(current => current.includes(rowKey(row)) ? current.filter(key => key !== rowKey(row)) : [...current, rowKey(row)]);
  const changeTab = (next: Tab) => {setTab(next); setDetailSku(null);};

  return <div className="mrpw">
    <section className="mrpw-banner" aria-label="Planning overview">
      <div className="mrpw-banner-symbol"><CalendarClock size={25}/></div>
      <div className="mrpw-banner-copy"><span className="mrpw-eyebrow">PLAN THE KITCHEN AHEAD</span><h2>Four-week material plan</h2><p>Turn confirmed pickup orders into the ingredients you need, where you need them.</p></div>
      <div className="mrpw-banner-period"><CalendarClock size={15}/><span>{date(data.today)} – {date(shiftDate(data.today, 27))}<small>4 weeks · Mountain time</small></span></div>
      <button className="button secondary" disabled={busy || loading} onClick={onRefresh}><RefreshCw size={15} className={loading ? 'mrpw-spinning' : ''}/>{loading ? 'Refreshing…' : 'Refresh'}</button>
    </section>

    {error && <div className="mrpw-notice mrpw-notice-error" role="alert"><AlertTriangle size={19}/><div><b>These values may be out of date.</b><p>{error}</p></div><button className="table-action" disabled={busy || loading} onClick={onRefresh}>Retry</button></div>}
    {pendingPurchase && <div className="mrpw-notice" role="status"><Clock3 size={19}/><div><b>A purchase draft save needs confirmation.</b><p>Recover its original request before creating more drafts.</p></div><button className="button secondary" disabled={locked} onClick={onRetryPurchase}>Confirm pending PO save</button></div>}

    <div className="mrpw-toolbar">
      <div className="mrpw-tabs" role="tablist" aria-label="Material planning views">{tabs.map((name, index) => {
        const Icon = index === 0 ? ClipboardList : index === 1 ? BookOpen : AlertTriangle;
        return <button key={name} id={'mrpw-tab-' + index} type="button" role="tab" aria-selected={tab === name} aria-controls={'mrpw-panel-' + index} tabIndex={tab === name ? 0 : -1} onClick={() => changeTab(name)} onKeyDown={event => {
          let next: number | undefined;
          if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
          if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
          if (event.key === 'Home') next = 0;
          if (event.key === 'End') next = tabs.length - 1;
          if (next !== undefined) {event.preventDefault(); changeTab(tabs[next]); document.getElementById('mrpw-tab-' + next)?.focus();}
        }}><Icon size={16}/>{name}{index === 2 && <span className={alerts.length ? 'mrpw-tab-count has-alerts' : 'mrpw-tab-count'}>{alerts.length}</span>}</button>;
      })}</div>
      <label className="mrpw-location">Planning location<select aria-label="MRP planning location" value={here} onChange={event => changeLocation(event.target.value)}>{data.locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
    </div>
    <div className="mrpw-sync" role="status"><span className="mrpw-sync-dot"/>{loading ? 'Updating the shared plan…' : props.updatedAt ? 'Updated ' + props.updatedAt.toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit', second: '2-digit'}) : 'Shared orders, inventory & receipts'}<span>Refreshes every 15 seconds while visible</span></div>

    <div id={'mrpw-panel-' + tabs.indexOf(tab)} role="tabpanel" aria-labelledby={'mrpw-tab-' + tabs.indexOf(tab)}>
      {tab === 'Requirements' && <>
        {legacyOrders.length > 0 && <div className="mrpw-notice" role="status"><AlertTriangle size={19}/><div><b>{legacyOrders.length} {legacyOrders.length === 1 ? 'open order already consumed' : 'open orders already consumed'} stock.</b><p>These earlier orders are excluded from new demand. Preparing them will not deduct ingredients again. New confirmed orders stay in this plan until preparation.</p></div>{onOrders && <button className="button secondary" onClick={onOrders}>Review orders</button>}</div>}
        {draftConflicts.length>0&&<div className="mrpw-notice" role="status"><ShoppingCart size={19}/><div><b>Existing purchase drafts need review</b><p>{[...new Set(draftConflicts.map(({row,draft})=>row.item.name+' · '+(draft.po_no??'PO draft')+(draft.source?' · '+draft.source:'')))].join('; ')}. Drafts do not cover demand until issued; creating another draft for the same item and location is blocked.</p></div><button className="button secondary" onClick={onPurchase}>Review existing purchase drafts</button></div>}
        <div className="mrpw-metrics">
          <Metric label="Confirmed orders" value={confirmed.length} note={legacyOrders.length ? (confirmed.length - legacyOrders.length) + ' to plan · ' + legacyOrders.length + ' already posted' : 'Awaiting preparation at this location'} icon={ClipboardList} tone="blue"/>
          <Metric label="Components to buy" value={buyRows.length} note="Items with an uncovered requirement" icon={ShoppingCart} tone="gold"/>
          <Metric label="Due now or overdue" value={dueRows.length} note="Purchase or production actions to review" icon={Clock3} tone={dueRows.length ? 'red' : 'green'}/>
          <Metric label="Possible transfers" value={transferRows.length} note="Items with surplus stock at another location" icon={ArrowLeftRight} tone="green"/>
        </div>
        <section className="panel mrpw-plan-panel">
          <div className="mrpw-panel-head"><div><h2>Component requirements</h2><p>{location?.name} · {visible.length} {visible.length === 1 ? 'item' : 'items'} shown</p></div><div className="mrpw-filters"><label className="mrpw-search"><Search size={16}/><input aria-label="Search MRP components" placeholder="Search component or SKU" value={search} onChange={event => setSearch(event.target.value)}/>{search && <button aria-label="Clear MRP search" onClick={() => setSearch('')}><X size={14}/></button>}</label><label className="mrpw-filter-label">Show<select aria-label="Filter MRP requirements" value={filter} onChange={event => setFilter(event.target.value)}><option value="demand">Items with demand</option><option value="actions">Action needed</option><option value="buy">Purchased with demand</option><option value="make">Made in house with demand</option><option value="all">All items</option></select></label></div></div>
          <div className="mrpw-period-controls" aria-label="Requirement periods"><div role="group" aria-label="Requirement view"><button className="button secondary" aria-pressed={period==='weeks'} onClick={()=>setPeriod('weeks')}>Weekly</button><button className="button secondary" aria-pressed={period==='days'} onClick={()=>setPeriod('days')}>Daily</button></div>{period==='days'&&<div><button className="button secondary" disabled={dailyWeek===0} onClick={()=>setDailyWeek(n=>n-1)}>Previous week</button><span>Week {dailyWeek+1} · {date(shiftDate(data.today,dailyWeek*7))}–{date(shiftDate(data.today,dailyWeek*7+6))}</span><button className="button secondary" disabled={dailyWeek===3} onClick={()=>setDailyWeek(n=>n+1)}>Next week</button></div>}</div>
          <div className="mrpw-table-scroll" tabIndex={0} aria-label={period==='weeks'?'Weekly component requirements, scroll horizontally for all weeks':'Daily component requirements, scroll horizontally for all days'}><table className="mrpw-table"><thead><tr><th className="mrpw-check"><input ref={selectAllRef} type="checkbox" aria-label="Select all eligible visible purchase suggestions" checked={allVisibleSelected} disabled={locked || pendingPurchase || !eligible.length} onChange={event => setSelected(current => event.target.checked ? [...new Set([...current, ...eligible.map(rowKey)])] : current.filter(key => !eligible.some(row => rowKey(row) === key)))}/></th><th>COMPONENT</th><th className="right">ON HAND</th><th className="right">OPEN RECEIPTS</th>{periods.map(p=><th key={p.index} className="right mrpw-week">{p.label}{period==='weeks'&&<small>{date(shiftDate(data.today,p.index*7))}–{date(shiftDate(data.today,p.index*7+6))}</small>}</th>)}<th>NEXT ACTION</th><th aria-label="View component plan"/></tr></thead><tbody>
            {visible.map(row => {
              const blocker = purchaseBlocker(data, row), status = materialStatus(data, row);
              return <tr key={row.item.sku}><td className="mrpw-check"><input type="checkbox" aria-label={'Select ' + row.item.name + ' for PO draft'} title={blocker ?? 'Include in purchase draft'} disabled={locked || pendingPurchase || !!blocker} checked={selectedRows.some(selectedRow => rowKey(selectedRow) === rowKey(row))} onChange={() => toggle(row)}/></td><td><button className="mrpw-item" onClick={() => setDetailSku(row.item.sku)}><span className={'mrpw-item-icon ' + (row.made ? 'made' : '')}>{row.made ? <Factory size={17}/> : <Package size={17}/>}</span><span><b>{row.item.name}</b><small>{row.item.sku} · {row.item.base_unit} · {row.made ? 'Make' : 'Buy'}</small></span></button></td><td className="right"><strong className={row.onHand < 0 ? 'text-red' : ''}>{qty(row.onHand)}</strong><small className="mrpw-cell-note">{row.item.base_unit}</small></td><td className="right"><strong>{qty(row.onOrder)}</strong><small className="mrpw-cell-note">dated supply</small></td>{cells(row).map(({gross,net}, index) => <td key={index} className={'right mrpw-week-cell' + (net > 0 ? ' has-shortage' : '')}><b>{gross ? qty(gross) : '—'}</b><small>{net > 0 ? qty(net) + ' short' : gross ? 'Covered' : 'No demand'}</small></td>)}<td><span className={'mrpw-status ' + status.tone}>{status.label}</span>{row.actions.length > 0 && <small className="mrpw-action-date">{row.made ? 'Start' : 'Order'} by <b>{date(row.actions[0].orderBy)}</b></small>}{row.transfer.length > 0 && <button className="mrpw-transfer-link" onClick={() => setDetailSku(row.item.sku)}><ArrowLeftRight size={12}/>Transfer option</button>}</td><td><button className="mrpw-chevron" aria-label={'View plan for ' + row.item.name} onClick={() => setDetailSku(row.item.sku)}><ChevronRight size={18}/></button></td></tr>;
            })}
          </tbody></table></div>
          {!visible.length && <div className="mrpw-empty"><CheckCircle2 size={29}/><h3>{search || filter !== 'demand' ? 'No matching components' : 'No confirmed demand at this location'}</h3><p>{search || filter !== 'demand' ? 'Try a different search or view to find a component.' : 'Create a confirmed sales order for this location within the next 28 days, then leave it unprepared. Select All components to inspect stock without demand. Earlier orders with posted stock are explained above.'}</p><div>{(search || filter !== 'demand') && <button className="button secondary" onClick={() => {setSearch(''); setFilter('demand');}}>Reset filters</button>}{onOrders && <button className="button secondary" onClick={onOrders}>Open Sales Orders <ArrowUpRight size={14}/></button>}</div></div>}
          <div className="mrpw-table-foot"><span><i className="mrpw-legend"/>{period==='weeks'?'Weekly':'Daily'} figures are required base units; amber cells show uncovered demand.</span><span>Open receipts count only at their destination and scheduled date.</span></div>
          <div className={'mrpw-selection-bar' + (selectedRows.length ? ' has-selection' : '')}><div><ShoppingCart size={18}/><span><b>{selectedRows.length ? selectedRows.length + ' components selected' : 'Select components to purchase'}</b><small>{selectedRows.length ? selectedSuppliers + ' supplier ' + (selectedSuppliers === 1 ? 'draft' : 'drafts') + ' · ' + money(estimated) + ' estimated before tax' : 'Only uncovered purchases with active suppliers can be selected.'}</small></span>{selectedRows.length > 0 && <button className="table-action" onClick={() => setSelected([])}>Clear</button>}</div><div><button className="button secondary" onClick={onPurchase}>Purchase orders</button><button className="button primary" disabled={locked || pendingPurchase || !selectedRows.length} onClick={() => {setPurchaseMode('minimum');setReview(true);}}>Review PO drafts{selectedRows.length ? ' (' + selectedRows.length + ')' : ''}<ChevronRight size={15}/></button></div></div>
        </section>
        <details className="mrpw-help"><summary>How this plan works</summary><div><p><b>1. Confirm demand.</b> Confirmed, unprepared pickup orders multiply through their recipes. Preparing an order deducts inventory once and removes its demand.</p><p><b>2. Net dated supply.</b> Each location uses its own stock and receipts due in time. Prepared dough and scheduled batches reduce how much new dough must be made.</p><p><b>3. Review an action.</b> Order-by dates use calendar-day lead times. Purchase quantities round to supplier packs. Drafts stay separated by requirement date; their order-by dates remain visible in purchasing. Suggested stock balances assume those actions happen; they are not current stock.</p><p>Possible transfers do not reduce shortages until posted. Existing MRP drafts need review and issue in Purchase Orders before they count as incoming supply.</p></div></details>
      </>}

      {tab === 'Recipes & BOMs' && <section className="panel mrpw-recipes-panel"><div className="mrpw-panel-head"><div><h2>Recipes & bills of material</h2><p>See exactly what one parent unit requires.</p></div><span className="mrpw-recipe-count"><BookOpen size={15}/>{plan.parentCount} parent items</span></div>{parent ? <div className="mrpw-recipes-layout"><div className="mrpw-parent-list" role="group" aria-label="Choose a parent recipe">{parents.map(item => <button key={item.sku} aria-pressed={item.sku === parent.sku} className={item.sku === parent.sku ? 'active' : ''} onClick={() => setParentSku(item.sku)}><span><b>{item.name}</b><small>{item.sku} · {data.bom.filter(line => line.parent_sku === item.sku).length} components</small></span><ChevronRight size={15}/></button>)}</div><div className="mrpw-recipe-detail"><div className="mrpw-recipe-heading"><span className="mrpw-item-icon made"><Factory size={21}/></span><div><span className="mrpw-eyebrow">PER PARENT UNIT</span><h3>{parent.name}</h3><p>Recipe for 1 {parent.base_unit} · {componentLines.length} child components</p></div></div><div className="table-scroll"><table><thead><tr><th>CHILD COMPONENT</th><th className="right">QTY PER PARENT UNIT</th><th className="right">LEAD TIME</th></tr></thead><tbody>{componentLines.map(line => {const item = data.items.find(item => item.sku === line.component_sku)!;return <tr key={line.component_sku}><td><b>{item.name}</b><small className="mrpw-cell-note">{item.sku} · {data.bom.some(b => b.parent_sku === item.sku) ? 'Made in house' : 'Purchased component'}</small></td><td className="right"><strong>{qty(Number(line.quantity))}</strong> {item.base_unit}</td><td className="right">{planLead(data, item)} <small>calendar days</small></td></tr>;})}</tbody></table></div><div className="mrpw-context"><BookOpen size={16}/><p>Parent quantity × component quantity = gross recipe usage. MRP first subtracts prepared subassembly stock, then plans the ingredients for only what must be made.</p></div></div></div> : <div className="mrpw-empty"><BookOpen size={28}/><h3>No bills of material are configured</h3><p>Add parent recipes and component quantities to the shared catalog before planning material demand.</p></div>}</section>}

      {tab === 'Planning alerts' && <>
        <section className="panel mrpw-alert-panel"><div className="mrpw-panel-head"><div><h2>Review the exceptions</h2><p>{location?.name} · Resolve these before relying on purchase suggestions.</p></div><span className={'mrpw-status ' + (alerts.length ? 'warn' : 'good')}>{alerts.length ? alerts.length + ' to review' : 'Up to date'}</span></div>{alerts.length ? <div className="mrpw-alert-list">{alerts.map((alert, index) => <div className="mrpw-alert" key={alert.kind + alert.reference + index}><span className="mrpw-alert-icon"><AlertTriangle size={18}/></span><div><b>{{order: 'Overdue pickup', receipt: 'Receipt date needs review', production: 'Production schedule', stock: 'Check physical stock', supplier: 'Supplier or item needs review', legacy: 'Stock already posted'}[alert.kind]}</b><p>{alert.message}</p></div>{alert.kind === 'receipt' && <button className="table-action" onClick={onPurchase}>Purchase orders <ArrowUpRight size={13}/></button>}{(alert.kind === 'order' || alert.kind === 'legacy') && onOrders && <button className="table-action" onClick={onOrders}>Sales orders <ArrowUpRight size={13}/></button>}{alert.kind === 'stock' && <button className="table-action" onClick={onTransfers}>Transfers & counts <ArrowUpRight size={13}/></button>}{alert.kind === 'supplier' && onSuppliers && <button className="table-action" onClick={onSuppliers}>Suppliers <ArrowUpRight size={13}/></button>}</div>)}</div> : <div className="mrpw-empty"><CheckCircle2 size={30}/><h3>No planning alerts here</h3><p>There are no overdue receipts, missing production dates, or catalog issues in this location’s plan.</p></div>}</section>
        {production.length > 0 && <details className="panel mrpw-production-dates"><summary><Factory size={17}/>Completion dates for open production<span>{production.length} batches</span></summary><p>Only scheduled output counts as future supply. Planned batches need ingredients by their start date; in-progress batches have already issued them.</p>{production.map(order => <form key={order.id} onSubmit={event => {event.preventDefault(); const due = String(new FormData(event.currentTarget).get('due')); void onSchedule(order.id, due);}}><div><b>{data.items.find(item => item.sku === order.parent_sku)?.name ?? order.parent_sku}</b><small>{order.order_no} · {qty(Number(order.quantity_started))} units · {order.status}</small></div><label>Completion date<input type="date" name="due" min={data.today} defaultValue={order.erp_due_date ?? data.today} required disabled={locked}/></label><button className="button secondary" disabled={locked}>Save date</button></form>)}</details>}
      </>}
    </div>

    {detail && <InventoryDialog title={detail.item.name} id="mrpw-detail-title" onClose={() => setDetailSku(null)} wide>
      <div className="mrpw-detail-meta"><span>{detail.item.sku} · {location?.name}</span><span>{detail.made ? 'Made in house' : 'Purchased'} · {detail.lead}-day lead</span></div>
      <div className="mrpw-detail-metrics"><div><span>On hand now</span><b>{qty(detail.onHand)} <small>{detail.item.base_unit}</small></b></div><div><span>Four-week requirement</span><b>{qty(totalRequirement(detail))} <small>{detail.item.base_unit}</small></b></div><div><span>Scheduled receipts</span><b>{qty(detail.onOrder)} <small>{detail.item.base_unit}</small></b></div><div className="mrpw-detail-suggestion"><span>{detail.made ? 'Suggested production' : 'Suggested purchase'}</span><b>{detail.made ? qty(suggestedUnits(detail)) + ' units' : qty(suggestedPacks(detail)) + ' × ' + detail.item.purchase_unit}</b><small>{qty(suggestedUnits(detail))} {detail.item.base_unit} in total</small></div></div>
      {!detail.made && <p className="mrpw-pack-note">1 {detail.item.purchase_unit} = {qty(Number(detail.item.conversion_factor))} {detail.item.base_unit}. Unused pack quantities carry forward to later requirements.</p>}
      {!detail.made && purchaseBlocker(data, detail) && <div className="mrpw-context"><AlertTriangle size={16}/><p>{purchaseBlocker(data, detail)}. Existing drafts must be reviewed in Purchase Orders; covered requirements do not need another purchase.</p></div>}
      <h3 className="mrpw-detail-heading">Dated requirement calculation</h3><p className="mrpw-detail-note">Available = previous projected balance + receipts due that day. Shortage = max(0, required − available). Projected balances include suggested supply.</p>
      <div className="mrpw-detail-scroll"><table className="mrpw-calculation"><thead><tr><th>REQUIRED / RECEIPT DATE</th><th className="right">RECEIPTS</th><th className="right">AVAILABLE</th><th className="right">REQUIRED</th><th className="right">SHORTAGE</th><th>SUGGESTED ACTION</th></tr></thead><tbody>{detail.timeline.map((step, index) => {const action = detail.actions.find(action => action.date === step.date);return <tr key={index}><td><b>{date(step.date)}</b></td><td className="right">{qty(step.receipts)}</td><td className="right">{qty(step.available)}</td><td className="right">{qty(step.gross)}</td><td className={'right' + (step.net > 0 ? ' text-red' : '')}>{qty(step.net)}</td><td>{action ? <><b>{detail.made ? 'Make ' + qty(action.quantity) : qty(action.packs) + ' × ' + detail.item.purchase_unit}</b><small className={'mrpw-cell-note' + (action.orderBy <= data.today ? ' text-red' : '')}>{detail.made ? 'Start' : 'Order'} by {date(action.orderBy)}{action.late ? ' · overdue' : action.orderBy === data.today ? ' · today' : ''}</small></> : <span className="mrpw-covered"><Check size={13}/>Covered</span>}</td></tr>;})}</tbody></table>{!detail.timeline.length && <p className="mrpw-pack-note">No confirmed requirements or scheduled receipts in this four-week window.</p>}</div>
      {detail.transfer.length > 0 && <div className="mrpw-transfer-card"><ArrowLeftRight size={20}/><div><h3>Possible transfers</h3>{detail.transfer.map(transfer => <p key={transfer.location}>{qty(transfer.quantity)} {detail.item.base_unit} from <b>{locationName(transfer.location)}</b></p>)}<small>The source keeps stock for its own four-week demand. These options do not reduce a purchase until a transfer is posted.</small></div><button className="button secondary" onClick={onTransfers}>Open transfers</button></div>}
      <details className="mrpw-source-details" open><summary>Where the requirement comes from</summary>{detail.sources.length ? detail.sources.map((source, index) => <div key={index}><span><b>{source.reference}</b><small>{date(source.date)}{source.orderIds?.length ? ' · ' + source.orderIds.map(id => {const order=data.orders.find(order=>order.id===id);return order?'Order '+order.erp_order_number:'Unavailable order';}).join(', ') : ''}</small></span><strong>{qty(source.qty)} {detail.item.base_unit}</strong></div>) : <p>No unprepared confirmed orders require this item in the current plan.</p>}</details>
      <details className="mrpw-source-details"><summary>Open purchase and production receipts</summary>{data.receipts.filter(receipt => receipt.location_id === here && receipt.item_sku === detail.item.sku).map((receipt, index) => <div key={index}><span><b>{receipt.kind} · {receipt.id.slice(0, 8)}</b><small>{date(localDate(receipt.due))}{localDate(receipt.due) < data.today ? ' · overdue, excluded' : localDate(receipt.due) >= plan.end ? ' · outside this window' : ' · counted on its scheduled date'}</small></span><strong>{qty(Number(receipt.quantity))} {detail.item.base_unit}</strong></div>)}</details>
      <div className="mrpw-dialog-actions"><button className="button secondary" onClick={() => setDetailSku(null)}>Close details</button>{detail.made ? onProduction && <button className="button primary" onClick={onProduction}><Factory size={15}/>Open production</button> : hasMrpDraft(data, detail) ? <button className="button primary" onClick={onPurchase}>Review existing PO draft</button> : <button className="button primary" title={purchaseBlocker(data, detail) ?? ''} disabled={locked || pendingPurchase || !!purchaseBlocker(data, detail)} onClick={() => toggle(detail)}>{selectedRows.some(row => rowKey(row) === rowKey(detail)) ? <><Check size={15}/>Selected for PO draft</> : <><ShoppingCart size={15}/>Select for PO draft</>}</button>}</div>
    </InventoryDialog>}

    {review && <InventoryDialog title="Review ingredient PO drafts" id="mrpw-review-title" onClose={() => {setReview(false);setPurchaseMode('minimum');}} busy={busy} wide>
      <p className="mrpw-detail-note">{location?.name} · {selectedSuppliers} supplier {selectedSuppliers === 1 ? 'draft' : 'drafts'}. Quantities below use the latest refreshed plan. Creating a draft does not send an order or change inventory.</p>
      {error && <p className="mrpw-review-error" role="alert">{error}</p>}
      <fieldset className="mrpw-purchase-options" disabled={locked||pendingPurchase}><legend>Purchase quantity</legend>
        <label><input type="radio" name="mrp-purchase-mode" value="minimum" checked={purchaseMode==='minimum'} onChange={()=>setPurchaseMode('minimum')}/><span><b>Cover confirmed demand</b><small>Default: buy only the dated MRP shortage, rounded to whole supplier packs.</small></span></label>
        <label><input type="radio" name="mrp-purchase-mode" value="replenish" checked={purchaseMode==='replenish'} disabled={!data.purchasePolicy} onChange={()=>setPurchaseMode('replenish')}/><span><b>Include routine replenishment</b><small>Use EOQ and the review target when they justify more stock. Credit extra packs toward later requirements; keep every deadline covered.</small></span></label>
      </fieldset>
      <p className="mrpw-detail-note">EOQ uses the shared ordering settings and 180-day usage history. Here, usage, stock and dated receipts belong to {location?.name}; Inventory Review shows the combined business. Raw EOQ is adjusted for shelf life and stock already available. No supplier MOQ is assumed.</p>
      {!data.purchasePolicy&&<p className="mrpw-context">EOQ comparison is unavailable until the purchasing policy update is installed and the plan refreshed. Minimum MRP purchases still work.</p>}
      <div className="table-scroll"><table className="mrpw-review-table"><thead><tr><th>COMPONENT / SUPPLIER</th><th>MRP REQUIREMENT / MINIMUM</th><th>EOQ / ROUTINE OPTION</th><th>PURCHASE QUANTITY / DATES</th><th className="right">ESTIMATED COST</th></tr></thead><tbody>{choices.map(({row,choice}) => <tr key={row.item.sku}><td><b>{row.item.name}</b><small className="mrpw-cell-note">{data.suppliers.find(supplier => supplier.id === row.item.supplier_id)?.name}</small></td><td><b>{qty(totalRequirement(row))} {row.item.base_unit} required</b><small className="mrpw-cell-note">On hand {qty(row.onHand)} · dated receipts {qty(row.onOrder)}</small><small className="mrpw-cell-note">Shortage {qty(row.actions.reduce((n,a)=>n+a.net,0))} {row.item.base_unit}</small><small className="mrpw-cell-note">Minimum {qty(choice.minimumPacks)} × {row.item.purchase_unit} ({qty(choice.minimumUnits)} {row.item.base_unit})</small>{row.actions.map(a=><small className="mrpw-cell-note" key={a.date}>Requirement {date(a.date)} · original order-by {date(a.orderBy)}</small>)}</td><td>{choice.routine?<><b>Raw EOQ {qty(choice.routine.rawEOQ)} {row.item.base_unit}</b><small className="mrpw-cell-note">Shelf-adjusted EOQ {qty(choice.routine.eoq)} {row.item.base_unit}</small><small className="mrpw-cell-note">Routine target {qty(choice.routine.target)} {row.item.base_unit} · {qty(choice.routine.packs)} packs suggested</small><small className="mrpw-cell-note">{qty(choice.daily)} {row.item.base_unit}/day at this location</small>{!choice.daily&&<small className="mrpw-cell-note">No usage history here; no extra replenishment.</small>}</>:<span>Unavailable</span>}</td><td><b>{qty(choice.packs)} × {row.item.purchase_unit}</b><small className="mrpw-cell-note">{qty(choice.units)} {row.item.base_unit} in total · {qty(choice.extraPacks)} extra packs</small>{choice.actions.map(action=><small key={action.date} className="mrpw-cell-note">{qty(action.packs)} packs needed {date(action.date)} · order by {date(action.orderBy)}{action.late?' · expedite':''}</small>)}{choice.shelfWarning&&<strong className="mrpw-shelf-warning">Shelf-life warning: stock plus planned supply exceeds {row.item.shelf_life_days} days of historical usage. Confirmed demand remains covered; review perishability.</strong>}</td><td className="right"><b>{money(choice.cost)}</b><small className="mrpw-cell-note">{money(choice.extraCost)} extra vs minimum</small></td></tr>)}</tbody></table></div>
      {!selectedRows.length && <p className="mrpw-review-error">The refreshed plan has no eligible selections. Close this review and select components again.</p>}
      <div className="mrpw-review-total"><span>Estimated materials <small>Before supplier tax; final pricing is reviewed in Purchase Orders.</small></span><b>{money(estimated)}</b></div>
      <div className="mrpw-context"><ShoppingCart size={17}/><p>Only issued purchase orders count as incoming supply. Review and issue these drafts in Purchase Orders after checking transfer options and delivery promises.</p></div>
      <div className="mrpw-dialog-actions"><button className="button secondary" disabled={busy} onClick={() => {setReview(false);setPurchaseMode('minimum');}}>Back to plan</button><button className="button primary" disabled={locked || pendingPurchase || !selectedRows.length} onClick={() => {void onCreateDrafts(selectedRows,purchaseMode).then(saved => {if (saved) {setReview(false); setPurchaseMode('minimum'); setSelected([]);}});}}><ShoppingCart size={15}/>{busy ? 'Saving drafts…' : 'Create ' + selectedSuppliers + ' supplier ' + (selectedSuppliers === 1 ? 'draft' : 'drafts')}</button></div>
    </InventoryDialog>}
  </div>;
}

function Metric({label, value, note, icon: Icon, tone}: {label: string; value: number; note: string; icon: typeof Boxes; tone: string}) {
  return <div className="mrpw-metric"><div><span>{label}</span><i className={'mrpw-metric-icon ' + tone}><Icon size={18}/></i></div><b>{value}</b><small>{note}</small></div>;
}
