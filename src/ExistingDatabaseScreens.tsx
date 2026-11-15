import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {Check,Activity,Minus,AlertTriangle,Boxes,CircleDollarSign,Warehouse,RotateCcw,Printer,X,ScanLine,Plus,ArrowRight,ArrowLeftRight,PackageCheck,Pizza,CheckCircle2,ClipboardList,Clock3,ArrowUpRight} from 'lucide-react';
import {BarcodeLabelsScreen} from './BarcodeLabels';
import type {AppState,Location,PurchaseOrder,Item} from './domain';
import {fmt} from './domain';
import {supabase} from './supabase';
import {renderCode128} from './barcode';
const usd=fmt;
const dateLabel=(s:string)=>new Date(`${s}T12:00:00`).toLocaleDateString('en-US',{month:'short',day:'numeric'});
function StatCard({label,value,change,icon:Icon,accent='blue',sub}:{label:string;value:string;change?:string;icon:any;accent?:string;sub?:string}){return <div className="stat-card"><div className="stat-head"><span>{label}</span><span className={`stat-icon ${accent}`}><Icon size={17}/></span></div><div className="stat-value">{value}</div><div className="stat-foot">{change&&<span className="trend-up"><ArrowUpRight size={13}/>{change}</span>}<span>{sub}</span></div></div>}
type InventoryItemRow={sku:string;name:string;category:string;barcode:string;base_unit:string;purchase_unit:string;conversion_factor:number;unit_cost:number;selling_price:number;shelf_life_days:number|null;lead_days:number};
type InventoryLocationRow={id:string;name:string};
type InventoryBomRow={parent_sku:string;component_sku:string;quantity:number};
type InventoryTransactionRow={id:string;item_sku:string;location_id:string;quantity:number;transaction_type:string;occurred_at:string};
type InventorySnapshot={items:Item[];locations:InventoryLocationRow[];stockBySku:Record<string,Record<string,number>>;usageBySku:Record<string,number>;transactionCount:number};
const inventoryPageSize=1000;
const inventoryCategories:Item['category'][]=['Pizza','Sides','Ingredient','Packaging','Beverage'];
const inventoryUsageFallback:Record<string,number>={1001:1550,1002:880,1003:1120,1005:155,1009:45,1018:42,1017:27};
function isInventoryCategory(category:string):category is Item['category']{return inventoryCategories.includes(category as Item['category']);}
async function loadInventorySnapshot():Promise<InventorySnapshot>{
 const [itemsResult,locationsResult,bomResult]=await Promise.all([
  supabase.from('items').select('sku,name,category,barcode,base_unit,purchase_unit,conversion_factor,unit_cost,selling_price,shelf_life_days,lead_days').order('sku'),
  supabase.from('locations').select('id,name').order('name'),
  supabase.from('bom_lines').select('parent_sku,component_sku,quantity')
 ]);
 if(itemsResult.error)throw Error(`Unable to load inventory catalog: ${itemsResult.error.message}`);
 if(locationsResult.error)throw Error(`Unable to load inventory locations: ${locationsResult.error.message}`);
 if(bomResult.error)throw Error(`Unable to load inventory bill of materials: ${bomResult.error.message}`);
 const itemRows=(itemsResult.data??[]) as InventoryItemRow[];
 const locationRows=(locationsResult.data??[]) as InventoryLocationRow[];
 const bomRows=(bomResult.data??[]) as InventoryBomRow[];
 const recipes:Record<string,Record<string,number>>={};
 for(const line of bomRows)(recipes[line.parent_sku]??={})[line.component_sku]=line.quantity;
 const itemSkus=new Set(itemRows.map(row=>row.sku));
 for(const line of bomRows)if(!itemSkus.has(line.parent_sku)||!itemSkus.has(line.component_sku))throw Error(`Inventory BOM references an unknown item: ${line.parent_sku} → ${line.component_sku}.`);
 const catalog:Item[]=itemRows.map(row=>{
  if(!isInventoryCategory(row.category))throw Error(`Unsupported inventory category "${row.category}" for SKU ${row.sku}.`);
  if(row.base_unit!=='oz'&&row.base_unit!=='each')throw Error(`Unsupported inventory unit "${row.base_unit}" for SKU ${row.sku}.`);
  return{sku:row.sku,name:row.name,category:row.category,barcode:row.barcode,unit:row.base_unit,pack:row.purchase_unit,factor:row.conversion_factor,cost:row.unit_cost,price:row.selling_price,shelf:row.shelf_life_days,supplier:'',lead:row.lead_days,recipe:recipes[row.sku],makeToStock:row.category==='Ingredient'&&!!recipes[row.sku]};
 });
 const locationNames=new Map<string,string>(locationRows.map(location=>[location.id,location.name] as const));
 const stockBySku:Record<string,Record<string,number>>={};
 const usageBySku:Record<string,number>={};
 const cutoff=Date.now()-180*86400000;
 let transactionCount=0;
 for(let offset=0;;offset+=inventoryPageSize){
  const {data,error}=await supabase.from('inventory_transactions').select('id,item_sku,location_id,quantity,transaction_type,occurred_at').order('occurred_at',{ascending:true}).order('id',{ascending:true}).range(offset,offset+inventoryPageSize-1);
  if(error)throw Error(`Unable to load inventory transactions: ${error.message}`);
  const page=(data??[]) as InventoryTransactionRow[];
  transactionCount+=page.length;
  for(const transaction of page){
   if(!itemSkus.has(transaction.item_sku))throw Error(`Inventory transaction ${transaction.id} references unknown SKU ${transaction.item_sku}.`);
   const locationName=locationNames.get(transaction.location_id);
   if(!locationName)throw Error(`Inventory transaction ${transaction.id} references an unknown location.`);
   const byLocation=stockBySku[transaction.item_sku]??(stockBySku[transaction.item_sku]={});
   byLocation[locationName]=(byLocation[locationName]??0)+transaction.quantity;
   const type=transaction.transaction_type.toLowerCase();
   if(transaction.quantity<0&&(type==='sale'||type==='production'||type==='production issue')&&new Date(transaction.occurred_at).getTime()>=cutoff)usageBySku[transaction.item_sku]=(usageBySku[transaction.item_sku]??0)-transaction.quantity;
  }
  if(page.length<inventoryPageSize)break;
 }
 return{items:catalog,locations:locationRows,stockBySku,usageBySku,transactionCount};
}
export function ConnectedInventoryPage({search,flash,safetyDays,onOpenLabels}:{search:string;flash:(s:string)=>void;safetyDays:number;onOpenLabels:()=>void}){
 const [snapshot,setSnapshot]=useState<InventorySnapshot|null>(null);
 const [loading,setLoading]=useState(true);
 const [error,setError]=useState('');
 const [category,setCategory]=useState('All categories');
 const [selected,setSelected]=useState<Item|null>(null);
 const [showLabels,setShowLabels]=useState(false);
 const load=useCallback(async()=>{setLoading(true);setError('');try{setSnapshot(await loadInventorySnapshot());}catch(error){setError(error instanceof Error?error.message:'Unable to load inventory from Supabase.');}finally{setLoading(false);}},[]);
 useEffect(()=>{void load();},[load]);
 if(!snapshot)return <section className="panel">{loading?<div className="empty-inline">Loading inventory from Supabase…</div>:<><div className="login-error" role="alert">{error}</div><button className="button secondary" onClick={()=>void load()}>Retry</button></>}</section>;
 const itemBySku=new Map<string,Item>(snapshot.items.map(item=>[item.sku,item] as const));
 const onHand=(sku:string,location?:string)=>location?(snapshot.stockBySku[sku]?.[location]??0):snapshot.locations.reduce((sum,entry)=>sum+(snapshot.stockBySku[sku]?.[entry.name]??0),0);
 const itemCost=(item:Item,seen=new Set<string>()):number=>{if(!item.recipe)return item.cost;if(seen.has(item.sku))throw Error(`Inventory BOM contains a recipe cycle at SKU ${item.sku}.`);const next=new Set(seen).add(item.sku);return Object.entries(item.recipe).reduce((sum,[sku,quantity])=>{const component=itemBySku.get(sku);if(!component)throw Error(`Inventory BOM references missing item ${sku}.`);return sum+quantity*itemCost(component,next);},0);};
 const dailyUsage=(item:Item)=>(snapshot.usageBySku[item.sku]??0)/180||inventoryUsageFallback[item.sku]||12;
 const reorderPointFor=(item:Item)=>dailyUsage(item)*(item.lead+safetyDays);
 const filtered=snapshot.items.filter(item=>(category==='All categories'||item.category===category)&&`${item.sku} ${item.name} ${item.barcode}`.toLowerCase().includes(search.toLowerCase()));
 const value=snapshot.items.filter(item=>!item.recipe||item.makeToStock).reduce((sum,item)=>sum+onHand(item.sku)*itemCost(item),0);
 const categories=[...new Set(snapshot.items.map(item=>item.category))];
 return <>{error&&<div className="login-error" role="alert">{error}</div>}<div className="stats-grid compact-stats"><StatCard label="Tracked items" value={String(snapshot.items.length)} icon={Boxes} sub={`Across ${snapshot.locations.length} locations`}/><StatCard label="Inventory value" value={usd(value)} icon={CircleDollarSign} accent="green" sub="Weighted average cost"/><StatCard label="Need replenishment" value={String(snapshot.items.filter(item=>!item.recipe&&onHand(item.sku)<reorderPointFor(item)).length)} icon={AlertTriangle} accent="amber" sub="Below reorder point"/><StatCard label="Active locations" value={String(snapshot.locations.length)} icon={Warehouse} sub="Supabase locations"/></div><section className="panel"><div className="panel-head table-header"><div><h2>Inventory by location</h2><p>Quantities reconcile to the Supabase transaction ledger</p></div><div className="table-controls"><button className="button secondary" onClick={onOpenLabels}>Barcode catalog & SKUs</button><button className="button secondary" onClick={()=>void load()} disabled={loading}><RotateCcw size={15}/>{loading?'Refreshing…':'Refresh'}</button><select value={category} onChange={event=>setCategory(event.target.value)}><option>All categories</option>{categories.map(value=><option key={value}>{value}</option>)}</select><button className="button secondary" onClick={()=>setShowLabels(true)}><Printer size={15}/> Print barcode labels</button></div></div><div className="table-scroll"><table><thead><tr><th>ITEM</th><th>SKU / BARCODE</th>{snapshot.locations.map(location=><th className="right" key={location.id}>{location.name==='Central Commissary'?'COMMISSARY':location.name.split(' ')[0].toUpperCase()}</th>)}<th className="right">TOTAL</th><th className="right">AVG COST</th><th className="right">REORDER</th><th></th></tr></thead><tbody>{filtered.map(item=>{const total=onHand(item.sku),reorder=item.recipe?0:reorderPointFor(item),below=!item.recipe&&total<reorder;return <tr key={item.sku} className="click-row" onClick={()=>setSelected(item)}><td><div className="item-cell"><span className="item-emoji">{item.category==='Pizza'?'🍕':item.category==='Beverage'?'🥤':item.category==='Packaging'?'📦':item.category==='Sides'?'🥣':'🥬'}</span><span><b>{item.name}</b><small>{item.category}</small></span></div></td><td><b className="mono">{item.sku}</b><small className="cell-sub">{item.barcode}</small></td>{snapshot.locations.map(location=><td className="right" key={location.id}>{onHand(item.sku,location.name).toLocaleString()} <span className="unit-mini">{item.unit}</span></td>)}<td className="right"><b>{total.toLocaleString()}</b> <span className="unit-mini">{item.unit}</span></td><td className="right">{usd(itemCost(item))}/{item.unit}</td><td className="right">{item.recipe?'—':<span className={below?'text-red':'text-muted'}>{Math.ceil(reorder).toLocaleString()}</span>}</td><td><span className={`status-chip ${below?'warn':'good'}`}>{item.recipe?(item.makeToStock?'Make-to-stock':'Make-to-order'):below?'Reorder':'Healthy'}</span></td></tr>})}</tbody></table></div><div className="table-bottom"><span>Showing <b>{filtered.length}</b> of {snapshot.items.length} items</span><span>Values derived from {snapshot.transactionCount.toLocaleString()} Supabase ledger entries</span></div></section>{selected&&<div className="modal-backdrop" onClick={()=>setSelected(null)}><div className="modal item-modal" onClick={event=>event.stopPropagation()}><button className="modal-x" onClick={()=>setSelected(null)}><X size={18}/></button><div className="item-modal-top"><div className="big-item-emoji">{selected.category==='Pizza'?'🍕':'📦'}</div><div><span className="eyebrow">{selected.category.toUpperCase()} · SKU {selected.sku}</span><h2>{selected.name}</h2><p>{selected.barcode} · {selected.pack} × {selected.factor} {selected.unit}</p></div></div><div className="item-detail-stats">{snapshot.locations.map(location=><div key={location.id}><span>{location.name}</span><b>{onHand(selected.sku,location.name).toLocaleString()} {selected.unit}</b></div>)}</div><div className="detail-cost"><span>Weighted average cost</span><b>{usd(itemCost(selected))} / {selected.unit}</b></div>{selected.recipe&&<><h3 className="detail-section-title">Bill of materials · per unit</h3><div className="bom-lines">{Object.entries(selected.recipe).map(([sku,quantity])=>{const component=itemBySku.get(sku)!;return <div key={sku}><span>{component.name} <small>{quantity} {component.unit} × {usd(itemCost(component))}</small></span><b>{usd(quantity*itemCost(component))}</b></div>})}<div className="bom-total"><b>Rolled-up cost</b><b>{usd(itemCost(selected))}</b></div></div>{selected.price>0&&<div className="margin-strip"><span>Gross margin</span><b>{usd(selected.price-itemCost(selected))} · {((selected.price-itemCost(selected))/selected.price*100).toFixed(1)}%</b></div>}</>}<button className="button secondary full" onClick={()=>setSelected(null)}>Close item details</button></div></div>}{showLabels&&<BarcodeModal catalog={snapshot.items} onClose={()=>setShowLabels(false)} flash={flash}/>}</>;
}
type MovementItemRow={sku:string;name:string;category:string;barcode:string;base_unit:string;purchase_unit:string;conversion_factor:number;unit_cost:number;selling_price:number;shelf_life_days:number|null;lead_days:number};
type MovementLocationRow={id:string;name:string};
type MovementBomRow={parent_sku:string;component_sku:string;quantity:number};
type MovementTransactionRow={id:string;item_sku:string;location_id:string;quantity:number;transaction_type:string;reason_code:string|null;reference_document:string|null;occurred_at:string};
type MovementSnapshot={items:Item[];locations:MovementLocationRow[];stockBySku:Record<string,Record<string,number>>;recent:MovementTransactionRow[];transactionCount:number};
async function loadMovementSnapshot():Promise<MovementSnapshot>{
 const [itemsResult,locationsResult,bomResult]=await Promise.all([
  supabase.from('items').select('sku,name,category,barcode,base_unit,purchase_unit,conversion_factor,unit_cost,selling_price,shelf_life_days,lead_days').order('sku'),
  supabase.from('locations').select('id,name').order('name'),
  supabase.from('bom_lines').select('parent_sku,component_sku,quantity')
 ]);
 if(itemsResult.error)throw Error(`Unable to load the item catalog: ${itemsResult.error.message}`);
 if(locationsResult.error)throw Error(`Unable to load locations: ${locationsResult.error.message}`);
 if(bomResult.error)throw Error(`Unable to load the item bill of materials: ${bomResult.error.message}`);
 const itemRows=(itemsResult.data??[]) as MovementItemRow[];
 const locations=(locationsResult.data??[]) as MovementLocationRow[];
 const bomRows=(bomResult.data??[]) as MovementBomRow[];
 const recipes:Record<string,Record<string,number>>={};
 for(const line of bomRows)(recipes[line.parent_sku]??={})[line.component_sku]=line.quantity;
 const itemSkus=new Set(itemRows.map(row=>row.sku));
 for(const line of bomRows)if(!itemSkus.has(line.parent_sku)||!itemSkus.has(line.component_sku))throw Error(`Item bill of materials references an unknown SKU: ${line.parent_sku} → ${line.component_sku}.`);
 const catalog:Item[]=itemRows.map(row=>{
  if(!isInventoryCategory(row.category))throw Error(`Unsupported inventory category "${row.category}" for SKU ${row.sku}.`);
  if(row.base_unit!=='oz'&&row.base_unit!=='each')throw Error(`Unsupported inventory unit "${row.base_unit}" for SKU ${row.sku}.`);
  return{sku:row.sku,name:row.name,category:row.category,barcode:row.barcode,unit:row.base_unit,pack:row.purchase_unit,factor:row.conversion_factor,cost:row.unit_cost,price:row.selling_price,shelf:row.shelf_life_days,supplier:'',lead:row.lead_days,recipe:recipes[row.sku],makeToStock:row.category==='Ingredient'&&!!recipes[row.sku]};
 });
 if(!catalog.length)throw Error('No inventory items are available.');
 if(!locations.length)throw Error('No inventory locations are available.');
 const locationNames=new Map<string,string>(locations.map(location=>[location.id,location.name] as const));
 const stockBySku:Record<string,Record<string,number>>={};
 const recent:MovementTransactionRow[]=[];
 let transactionCount=0;
 for(let offset=0;;offset+=inventoryPageSize){
  const {data,error}=await supabase.from('inventory_transactions').select('id,item_sku,location_id,quantity,transaction_type,reason_code,reference_document,occurred_at').order('occurred_at',{ascending:true}).order('id',{ascending:true}).range(offset,offset+inventoryPageSize-1);
  if(error)throw Error(`Unable to load inventory transactions: ${error.message}`);
  const page=(data??[]) as MovementTransactionRow[];
  transactionCount+=page.length;
  for(const transaction of page){
   if(!itemSkus.has(transaction.item_sku))throw Error(`Inventory transaction ${transaction.id} references unknown SKU ${transaction.item_sku}.`);
   const locationName=locationNames.get(transaction.location_id);
   if(!locationName)throw Error(`Inventory transaction ${transaction.id} references an unknown location.`);
   const byLocation=stockBySku[transaction.item_sku]??(stockBySku[transaction.item_sku]={});
   byLocation[locationName]=(byLocation[locationName]??0)+transaction.quantity;
   recent.push(transaction);
   if(recent.length>12)recent.shift();
  }
  if(page.length<inventoryPageSize)break;
 }
 return{items:catalog,locations,stockBySku,recent:recent.reverse(),transactionCount};
}
export function ConnectedMovements({flash}:{flash:(s:string)=>void}){
 const [mode,setMode]=useState<'Transfer'|'Cycle count'>('Transfer');
 const [sku,setSku]=useState('1003');
 const [qty,setQty]=useState(200);
 const [fromId,setFromId]=useState('');
 const [toId,setToId]=useState('');
 const [count,setCount]=useState(0);
 const [reason,setReason]=useState('Cycle count correction');
 const [barcode,setBarcode]=useState('');
 const [snapshot,setSnapshot]=useState<MovementSnapshot|null>(null);
 const [loading,setLoading]=useState(true);
 const [submitting,setSubmitting]=useState(false);
 const [loadError,setLoadError]=useState('');
 const [actionError,setActionError]=useState('');
 const load=useCallback(async()=>{
  setLoading(true);
  setLoadError('');
  try{setSnapshot(await loadMovementSnapshot());return true;}
  catch(error){setLoadError(error instanceof Error?error.message:'Unable to load inventory from Supabase.');return false;}
  finally{setLoading(false);}
 },[]);
 useEffect(()=>{void load();},[load]);
 useEffect(()=>{
  if(!snapshot)return;
  const selectable=snapshot.items.filter(item=>!item.recipe||item.makeToStock);
  if(!snapshot.items.some(item=>item.sku===sku))setSku(selectable[0]?.sku??snapshot.items[0].sku);
  if(!snapshot.locations.some(location=>location.id===fromId)){
   const defaultFrom=snapshot.locations.find(location=>location.name==='Central Commissary')??snapshot.locations[0];
   setFromId(defaultFrom.id);
  }
  if(!snapshot.locations.some(location=>location.id===toId)||toId===fromId){
   const defaultTo=snapshot.locations.find(location=>location.name==='Orem Store'&&location.id!==fromId)??snapshot.locations.find(location=>location.id!==fromId)??snapshot.locations[0];
   setToId(defaultTo.id);
  }
 },[snapshot,sku,fromId,toId]);
 if(!snapshot)return <section className="panel">{loading?<div className="empty-inline">Loading transfers and counts from Supabase…</div>:<><div className="login-error" role="alert">{loadError}</div><button className="button secondary" onClick={()=>void load()}>Retry</button></>}</section>;
 const itemBySku=new Map<string,Item>(snapshot.items.map(item=>[item.sku,item] as const));
 const selectedItem=itemBySku.get(sku)??snapshot.items[0];
 const locationById=new Map(snapshot.locations.map(location=>[location.id,location] as const));
 const from=locationById.get(fromId)??snapshot.locations[0];
 const to=locationById.get(toId)??snapshot.locations.find(location=>location.id!==from.id)??from;
 const selectableItems=snapshot.items.filter(item=>!item.recipe||item.makeToStock);
 const onHand=(itemSku:string,location:MovementLocationRow)=>snapshot.stockBySku[itemSku]?.[location.name]??0;
 const itemCost=(item:Item,seen=new Set<string>()):number=>{
  if(!item.recipe)return item.cost;
  if(seen.has(item.sku))throw Error(`Inventory bill of materials contains a recipe cycle at SKU ${item.sku}.`);
  const next=new Set(seen).add(item.sku);
  return Object.entries(item.recipe).reduce((sum,[componentSku,quantity])=>{
   const component=itemBySku.get(componentSku);
   if(!component)throw Error(`Inventory bill of materials references missing item ${componentSku}.`);
   return sum+quantity*itemCost(component,next);
  },0);
 };
 const resolve=()=>{
  const item=snapshot.items.find(candidate=>candidate.barcode===barcode||candidate.sku===barcode);
  if(item){setSku(item.sku);flash(`${item.name} selected`);setBarcode('');}
  else flash('No matching barcode or SKU.');
 };
 const submit=async()=>{
  if(submitting)return;
  setActionError('');
  setSubmitting(true);
  try{
   let variance=0;
   if(mode==='Transfer'){
    const {error}=await supabase.rpc('post_transfer',{p_item_sku:sku,p_from:from.id,p_to:to.id,p_quantity:qty});
    if(error)throw Error(error.message);
   }else{
    const {data,error}=await supabase.rpc('post_adjustment',{p_item_sku:sku,p_location:from.id,p_counted:count,p_reason:reason});
    if(error)throw Error(error.message);
    variance=Number(data);
    if(!Number.isFinite(variance))throw Error('The adjustment RPC returned an invalid variance.');
   }
   if(!await load())return;
   if(mode==='Transfer')flash(`${qty} ${selectedItem.unit} transferred to ${to.name}.`);
   else if(variance===0)flash('Count matches on-hand; no adjustment was posted.');
   else flash(`Cycle count posted: ${variance>0?'+':''}${variance} ${selectedItem.unit}.`);
  }catch(error){setActionError(`Unable to post ${mode.toLowerCase()}: ${error instanceof Error?error.message:'Unexpected Supabase error.'}`);}
  finally{setSubmitting(false);}
 };
 return <div className="movement-layout">{loadError&&<div className="login-error" role="alert">{loadError}</div>}<section className="panel movement-form"><div className="tab-switch">{(['Transfer','Cycle count'] as const).map(x=><button key={x} className={mode===x?'selected':''} onClick={()=>setMode(x)}>{x==='Transfer'?<ArrowLeftRight size={15}/>:<RotateCcw size={15}/>} {x}</button>)}</div><div className="form-section-title"><span className="step-index">01</span><div><h2>{mode==='Transfer'?'Move inventory':'Reconcile a cycle count'}</h2><p>{mode==='Transfer'?'Create a paired stock movement between locations.':'Enter the physical count; the system posts the variance.'}</p></div></div><label className="field-label">Scan item barcode or enter SKU</label><div className="scan-input"><ScanLine size={16}/><input value={barcode} onChange={event=>setBarcode(event.target.value)} onKeyDown={event=>event.key==='Enter'&&resolve()} placeholder="e.g. ZBZ-1003"/><kbd>ENTER</kbd><button onClick={resolve}>Find item</button></div><label className="field-label mt">Item</label><select value={selectedItem.sku} onChange={event=>setSku(event.target.value)}>{selectableItems.map(item=><option value={item.sku} key={item.sku}>{item.name} · {item.sku}</option>)}</select><div className="form-grid two"><div><label className="field-label">{mode==='Transfer'?'From location':'Count at'}</label><select value={from.id} onChange={event=>{const nextId=event.target.value;setFromId(nextId);if(to.id===nextId)setToId(snapshot.locations.find(location=>location.id!==nextId)?.id??nextId);}}>{snapshot.locations.map(location=><option key={location.id} value={location.id}>{location.name}</option>)}</select><small className="helper">Current: {onHand(selectedItem.sku,from).toLocaleString()} {selectedItem.unit}</small></div>{mode==='Transfer'?<div><label className="field-label">To location</label><select value={to.id} onChange={event=>setToId(event.target.value)}>{snapshot.locations.filter(location=>location.id!==from.id).map(location=><option key={location.id} value={location.id}>{location.name}</option>)}</select></div>:<div><label className="field-label">Physical count · {selectedItem.unit}</label><input type="number" min="0" value={count} onChange={event=>setCount(Number(event.target.value))}/></div>}</div><div className="form-grid two"><div><label className="field-label">{mode==='Transfer'?'Quantity':'Reason code'}</label>{mode==='Transfer'?<input type="number" min="1" value={qty} onChange={event=>setQty(Number(event.target.value))}/>:<select value={reason} onChange={event=>setReason(event.target.value)}>{['Cycle count correction','Spoiled/Expired','Damaged','Dropped/Spilled','Theft/Unknown loss'].map(value=><option key={value}>{value}</option>)}</select>}</div>{mode==='Transfer'&&<div><label className="field-label">Unit cost</label><div className="readonly-input">{usd(itemCost(selectedItem))} / {selectedItem.unit}</div></div>}</div>{mode==='Transfer'&&<div className="transfer-note"><Check size={15}/><span>Transfer out and transfer in post together. Total inventory value stays constant.</span></div>}{actionError&&<div className="login-error" role="alert">{actionError}</div>}<button className="button primary form-submit" onClick={()=>void submit()} disabled={submitting||loading||!from.id||!to.id}>{submitting?'Posting…':mode==='Transfer'?'Post transfer':'Post cycle count'} <ArrowUpRight size={16}/></button></section>
 <section className="panel movement-side"><div className="panel-head"><div><h2>Recent stock movements</h2><p>From the Supabase transaction ledger</p></div><span className="ledger-badge"><Activity size={14}/>{snapshot.transactionCount.toLocaleString()} entries</span></div><div className="movement-list">{snapshot.recent.map(transaction=>{const item=itemBySku.get(transaction.item_sku)!;const location=locationById.get(transaction.location_id)!;const isTransfer=transaction.transaction_type.toLowerCase().startsWith('transfer');return <div className="movement-item" key={transaction.id}><div className={`movement-icon ${transaction.quantity>0?'positive':isTransfer?'transfer':'negative'}`}>{isTransfer?<ArrowLeftRight size={15}/>:transaction.quantity>0?<Plus size={15}/>:<Minus size={15}/>}</div><div className="movement-copy"><b>{item.name}</b><span>{transaction.transaction_type} · {transaction.reference_document??'—'}{transaction.reason_code?` · ${transaction.reason_code}`:''}</span></div><div className="movement-qty"><b className={transaction.quantity>0?'text-green':'text-red'}>{transaction.quantity>0?'+':''}{transaction.quantity.toLocaleString()} {item.unit}</b><span>{location.name.split(' ')[0]} · {dateLabel(transaction.occurred_at.slice(0,10))}</span></div></div>;})}</div></section></div>;
}
function BarcodeModal({catalog,onClose,flash}:{catalog:Item[];onClose:()=>void;flash:(m:string)=>void}){const [chosen,setChosen]=useState(catalog.slice(0,8).map(i=>i.sku));const svgRefs=useRef<Record<string,SVGSVGElement|null>>({});useEffect(()=>{for(const i of catalog.filter(x=>chosen.includes(x.sku))){const el=svgRefs.current[i.sku];if(el)renderCode128(el,i.barcode);}},[catalog,chosen]);return <div className="modal-backdrop"><div className="modal labels-modal"><button className="modal-x" onClick={onClose}><X size={18}/></button><span className="eyebrow">BARCODE LABELS</span><h2>Print item labels</h2><p>Select products to print Code 128 labels for demo props.</p><div className="label-picker">{catalog.map(i=><label key={i.sku}><input type="checkbox" checked={chosen.includes(i.sku)} onChange={e=>setChosen(v=>e.target.checked?[...v,i.sku]:v.filter(s=>s!==i.sku))}/>{i.name}</label>)}</div><div className="label-sheet">{catalog.filter(i=>chosen.includes(i.sku)).map(i=><div className="barcode-label" key={i.sku}><b>ZA BY ZACK</b><span>{i.name}</span><svg ref={el=>{svgRefs.current[i.sku]=el}}/><small>SKU {i.sku}</small></div>)}</div><div className="modal-actions"><button className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" onClick={()=>{window.print();flash('Barcode labels sent to print.');}}><Printer size={15}/> Print labels</button></div></div></div>}
function CameraScanner({onClose,onResult}:{onClose:()=>void;onResult:(value:string)=>void}){const video=useRef<HTMLVideoElement>(null);const [message,setMessage]=useState('Starting camera…');useEffect(()=>{let stream:MediaStream|undefined,stopped=false,timer:number|undefined;const start=async()=>{try{const Detector=(window as any).BarcodeDetector;if(!Detector){setMessage('Camera scanning is not supported by this browser. Use the barcode input and press Enter.');return;}stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});if(!video.current)return;video.current.srcObject=stream;await video.current.play();const detector=new Detector({formats:['code_128']});setMessage('Point the camera at a Za by Zack item label.');const scan=async()=>{if(stopped||!video.current)return;try{const codes=await detector.detect(video.current);if(codes.length){stopped=true;onResult(codes[0].rawValue);return;}}catch{}timer=window.setTimeout(scan,250);};scan();}catch{setMessage('Camera access is unavailable. Check browser permissions or enter the barcode manually.');}};start();return()=>{stopped=true;if(timer)clearTimeout(timer);stream?.getTracks().forEach(t=>t.stop());};},[onResult]);return <div className="modal-backdrop"><div className="modal camera-modal"><button className="modal-x" onClick={onClose}><X size={18}/></button><span className="eyebrow">CAMERA SCAN</span><h2>Scan an item label</h2><video ref={video} muted playsInline/><div className="camera-message"><ScanLine size={15}/>{message}</div><button className="button secondary full" onClick={onClose}>Close scanner</button></div></div>}
type ProductionItemRecord={sku:string;name:string;unit_cost:number;active:boolean;hasBom:boolean;unitCost:number};
type ProductionLocationRecord={id:string;name:string};
type ProductionOrderRecord={id:string;order_no:string;parent_sku:string;location_id:string;quantity_started:number;quantity_good:number;quantity_scrapped:number;status:string;started_at:string|null;finished_at:string|null;reason_code:string|null};
type ProductionOrderView={id:string;orderNo:string;sku:string;location:string;qty:number;good:number;scrap:number;status:'Planned'|'In Progress'|'Completed';started?:string;reason?:string;unitCost:number};
type ProductionSnapshot={items:ProductionItemRecord[];locations:ProductionLocationRecord[];orders:ProductionOrderView[]};
type ProductionBomRecord={parent_sku:string;component_sku:string;quantity:number};
const productionPageSize=1000;
function isProductionOrderStatus(status:string):status is ProductionOrderView['status']{return status==='Planned'||status==='In Progress'||status==='Completed';}
async function loadProductionSnapshot():Promise<ProductionSnapshot>{
 const [itemsResult,bomResult,locationsResult]=await Promise.all([
  supabase.from('items').select('sku,name,unit_cost,active').order('sku'),
  supabase.from('bom_lines').select('parent_sku,component_sku,quantity'),
  supabase.from('locations').select('id,name').order('name')
 ]);
 if(itemsResult.error)throw Error(`Unable to load production items: ${itemsResult.error.message}`);
 if(bomResult.error)throw Error(`Unable to load production bill of materials: ${bomResult.error.message}`);
 if(locationsResult.error)throw Error(`Unable to load production locations: ${locationsResult.error.message}`);
 const itemRows=(itemsResult.data??[]) as {sku:string;name:string;unit_cost:number;active:boolean}[];
 const bomRows=(bomResult.data??[]) as ProductionBomRecord[];
 const locationRows=(locationsResult.data??[]) as ProductionLocationRecord[];
 const orderRows:ProductionOrderRecord[]=[];
 for(let offset=0;;offset+=productionPageSize){
  const {data,error}=await supabase.from('production_orders').select('id,order_no,parent_sku,location_id,quantity_started,quantity_good,quantity_scrapped,status,started_at,finished_at,reason_code').order('created_at',{ascending:false}).order('id',{ascending:false}).range(offset,offset+productionPageSize-1);
  if(error)throw Error(`Unable to load production orders: ${error.message}`);
  const page=(data??[]) as ProductionOrderRecord[];
  orderRows.push(...page);
  if(page.length<productionPageSize)break;
 }
 const itemBySku=new Map(itemRows.map(item=>[item.sku,item] as const));
 const locationById=new Map(locationRows.map(location=>[location.id,location] as const));
 const unitCostBySku:Record<string,number>={};
 const hasBomBySku=new Set<string>();
 for(const line of bomRows){
  const parent=itemBySku.get(line.parent_sku),component=itemBySku.get(line.component_sku),quantity=Number(line.quantity),componentCost=Number(component?.unit_cost);
  if(!parent||!component)throw Error(`Production bill of materials references an unknown item: ${line.parent_sku} → ${line.component_sku}.`);
  if(!Number.isFinite(quantity)||quantity<=0||!Number.isFinite(componentCost)||componentCost<0)throw Error(`Production bill of materials has an invalid quantity or cost for ${line.parent_sku} → ${line.component_sku}.`);
  hasBomBySku.add(line.parent_sku);
  unitCostBySku[line.parent_sku]=(unitCostBySku[line.parent_sku]??0)+quantity*componentCost;
 }
 const items:ProductionItemRecord[]=itemRows.map(item=>({sku:item.sku,name:item.name,unit_cost:Number(item.unit_cost),active:item.active,hasBom:hasBomBySku.has(item.sku),unitCost:unitCostBySku[item.sku]??0}));
 for(const item of items)if(!Number.isFinite(item.unit_cost)||item.unit_cost<0)throw Error(`Production item ${item.sku} has an invalid unit cost.`);
 const orders:ProductionOrderView[]=orderRows.map(order=>{
  const item=itemBySku.get(order.parent_sku),location=locationById.get(order.location_id),qty=Number(order.quantity_started),good=Number(order.quantity_good),scrap=Number(order.quantity_scrapped);
  if(!item)throw Error(`Production order ${order.order_no} references an unknown item ${order.parent_sku}.`);
  if(!location)throw Error(`Production order ${order.order_no} references an unknown location.`);
  if(!isProductionOrderStatus(order.status))throw Error(`Production order ${order.order_no} has an unsupported status "${order.status}".`);
  if(!Number.isFinite(qty)||!Number.isFinite(good)||!Number.isFinite(scrap))throw Error(`Production order ${order.order_no} has invalid quantities.`);
  return{id:order.id,orderNo:order.order_no,sku:order.parent_sku,location:location.name,qty,good,scrap,status:order.status,started:order.started_at?.slice(0,10),reason:order.reason_code??undefined,unitCost:unitCostBySku[order.parent_sku]??0};
 });
 return{items,locations:locationRows,orders};
}
export function ConnectedProductionPage({flash}:{flash:(message:string)=>void}){
 const [snapshot,setSnapshot]=useState<ProductionSnapshot|null>(null);
 const [loading,setLoading]=useState(true);
 const [loadError,setLoadError]=useState('');
 const [actionError,setActionError]=useState('');
 const [busy,setBusy]=useState(false);
 const [showNew,setShowNew]=useState(false);
 const [sku,setSku]=useState('1030');
 const [qty,setQty]=useState(20);
 const [locationId,setLocationId]=useState('');
 const [completion,setCompletion]=useState<string|null>(null);
 const [good,setGood]=useState(18);
 const [scrap,setScrap]=useState(2);
 const [reason,setReason]=useState('Burnt');
 const load=useCallback(async()=>{
  setLoading(true);setLoadError('');
  try{setSnapshot(await loadProductionSnapshot());return null;}
  catch(error){const message=error instanceof Error?error.message:'Unable to load production data from Supabase.';setLoadError(message);return message;}
  finally{setLoading(false);}
 },[]);
 useEffect(()=>{void load();},[load]);
 useEffect(()=>{
  if(!snapshot)return;
  const makeItems=snapshot.items.filter(item=>item.active&&item.hasBom);
  if(!makeItems.some(item=>item.sku===sku))setSku(makeItems[0]?.sku??'');
  if(!snapshot.locations.some(location=>location.id===locationId))setLocationId(snapshot.locations.find(location=>location.name==='Central Commissary')?.id??snapshot.locations[0]?.id??'');
 },[snapshot,sku,locationId]);
 const refreshAfterWrite=async(successMessage:string,writeDescription:string)=>{
  const error=await load();
  if(error){setActionError(`${writeDescription} succeeded, but production data could not be refreshed: ${error}`);return;}
  flash(successMessage);
 };
 const create=async()=>{
  if(busy)return;
  setActionError('');setLoadError('');
  setBusy(true);
  try{
   const {error}=await supabase.rpc('create_production_order',{p_parent_sku:sku,p_location:locationId,p_quantity:qty});
   if(error)throw Error(error.message);
   setShowNew(false);
   await refreshAfterWrite('Production order created.','Production order creation');
  }catch(error){setActionError(`Unable to create production order: ${error instanceof Error?error.message:'Unexpected Supabase error.'}`);}
  finally{setBusy(false);}
 };
 const issue=async(order:ProductionOrderView)=>{
  if(busy)return;
  setActionError('');setLoadError('');setBusy(true);
  try{
   const {error}=await supabase.rpc('issue_production_order',{p_order:order.id});
   if(error)throw Error(error.message);
   await refreshAfterWrite(`${order.orderNo} issued; components consumed from the ledger.`,'Issuing the production order');
  }catch(error){setActionError(`Unable to issue ${order.orderNo}: ${error instanceof Error?error.message:'Unexpected Supabase error.'}`);}
  finally{setBusy(false);}
 };
 const complete=async()=>{
  if(!completion||busy)return;
  const order=snapshot?.orders.find(candidate=>candidate.id===completion);
  if(!order){setActionError('The selected production order is no longer available. Refresh and try again.');return;}
  setActionError('');setLoadError('');setBusy(true);
  try{
   const {error}=await supabase.rpc('complete_production_order',{p_order:order.id,p_good:good,p_scrapped:scrap,p_reason:reason});
   if(error)throw Error(error.message);
   setCompletion(null);
   await refreshAfterWrite(`${order.orderNo} completed. Good units received at rolled-up cost.`,'Completing the production order');
  }catch(error){setActionError(`Unable to complete ${order.orderNo}: ${error instanceof Error?error.message:'Unexpected Supabase error.'}`);}
  finally{setBusy(false);}
 };
 if(!snapshot)return <section className="panel">{loading?<div className="empty-inline">Loading production from Supabase…</div>:<><div className="login-error" role="alert">{loadError||'Unable to load production data from Supabase.'}</div><button className="button secondary" onClick={()=>void load()}>Retry</button></>}</section>;
 const itemBySku=new Map(snapshot.items.map(item=>[item.sku,item] as const));
 const makeItems=snapshot.items.filter(item=>item.active&&item.hasBom);
 const selectedItem=makeItems.find(item=>item.sku===sku)??makeItems[0];
 const selectedOrder=snapshot.orders.find(order=>order.id===completion);
 const completed=snapshot.orders.filter(order=>order.status==='Completed');
 const completedStarted=completed.reduce((sum,order)=>sum+order.qty,0);
 const yieldPct=completedStarted?completed.reduce((sum,order)=>sum+order.good,0)/completedStarted*100:0;
 const scrapCost=completed.reduce((sum,order)=>sum+order.scrap*order.unitCost,0);
 return <>{(actionError||loadError)&&<div className="login-error" role="alert">{actionError||loadError}{loadError&&<button className="table-action" onClick={()=>{setActionError('');void load();}}>Retry</button>}</div>}<div className="stats-grid compact-stats"><StatCard label="Production orders" value={String(snapshot.orders.length)} icon={Pizza} sub="Planned + completed"/><StatCard label="Yield" value={`${yieldPct.toFixed(1)}%`} icon={Activity} accent="green" sub="Good units ÷ started units"/><StatCard label="Units scrapped" value={String(snapshot.orders.reduce((sum,order)=>sum+order.scrap,0))} icon={AlertTriangle} accent="amber" sub="By recorded reason"/><StatCard label="Scrap cost" value={usd(scrapCost)} icon={CircleDollarSign} accent="red" sub="Rolled-up recipe cost"/></div><section className="panel"><div className="panel-head table-header"><div><h2>Production orders</h2><p>Make dough and prepared items in house; issue their bill of materials and receive good units at rolled-up cost.</p></div><button className="button primary" disabled={busy||!makeItems.length||!snapshot.locations.length} onClick={()=>setShowNew(true)}><Plus size={15}/> New production order</button></div><div className="table-scroll"><table><thead><tr><th>ORDER</th><th>ITEM</th><th>LOCATION</th><th className="right">STARTED</th><th className="right">GOOD / SCRAP</th><th>STATUS</th><th></th></tr></thead><tbody>{snapshot.orders.length?snapshot.orders.map(order=><tr key={order.id}><td><b className="mono">{order.orderNo}</b><small className="cell-sub">{order.started?`Started ${dateLabel(order.started)}`:'Batch production'}</small></td><td><b>{itemBySku.get(order.sku)?.name??order.sku}</b><small className="cell-sub">Cost {usd(order.unitCost)} / unit</small></td><td>{order.location.split(' ')[0]}</td><td className="right">{order.qty}</td><td className="right">{order.status==='Completed'?`${order.good} / ${order.scrap}`:'—'}</td><td><span className={`status-chip ${order.status==='Completed'?'good':order.status==='In Progress'?'warn':'info'}`}>{order.status}</span></td><td className="right">{order.status==='Planned'?<button className="table-action" disabled={busy} onClick={()=>void issue(order)}><PackageCheck size={14}/> Issue</button>:order.status==='In Progress'?<button className="table-action" disabled={busy} onClick={()=>{setCompletion(order.id);setGood(order.qty);setScrap(0);}}><Check size={14}/> Complete</button>:<span className="text-muted">{order.reason||'—'}</span>}</td></tr>):<tr><td colSpan={7}><div className="empty-inline">No production orders yet. Create a batch or run a production acceptance scenario.</div></td></tr>}</tbody></table></div></section>{showNew&&<div className="modal-backdrop"><div className="modal form-modal"><button className="modal-x" disabled={busy} onClick={()=>setShowNew(false)}><X size={18}/></button><span className="eyebrow">IN-HOUSE PREP</span><h2>Create production order</h2><p>Components will be checked when the order is issued.</p><label className="field-label">Item to make</label><select value={selectedItem?.sku??''} onChange={event=>setSku(event.target.value)}>{makeItems.map(item=><option value={item.sku} key={item.sku}>{item.name} · {usd(item.unitCost)}/unit</option>)}</select><div className="form-grid two"><div><label className="field-label">Quantity to start</label><input type="number" min="1" value={qty} onChange={event=>setQty(Number(event.target.value))}/></div><div><label className="field-label">Location</label><select value={locationId} onChange={event=>setLocationId(event.target.value)}>{snapshot.locations.map(location=><option key={location.id} value={location.id}>{location.name}</option>)}</select></div></div><div className="modal-actions"><button className="button secondary" disabled={busy} onClick={()=>setShowNew(false)}>Cancel</button><button className="button primary" disabled={busy||!selectedItem||!locationId||!Number.isFinite(qty)||qty<=0} onClick={()=>void create()}>{busy?'Saving…':'Create order'}</button></div></div></div>}{completion&&selectedOrder&&<div className="modal-backdrop"><div className="modal form-modal"><button className="modal-x" disabled={busy} onClick={()=>setCompletion(null)}><X size={18}/></button><span className="eyebrow">COMPLETE PRODUCTION</span><h2>Record good units and scrap</h2><p>Started {selectedOrder.qty} units. Record the final disposition.</p><div className="form-grid two"><div><label className="field-label">Good units</label><input type="number" min="0" value={good} onChange={event=>setGood(Number(event.target.value))}/></div><div><label className="field-label">Scrapped units</label><input type="number" min="0" value={scrap} onChange={event=>setScrap(Number(event.target.value))}/></div></div><label className="field-label mt">Scrap reason</label><select value={reason} onChange={event=>setReason(event.target.value)}>{['Burnt','Dropped','Wrong toppings','Undercooked','Other'].map(value=><option key={value}>{value}</option>)}</select><div className="modal-actions"><button className="button secondary" disabled={busy} onClick={()=>setCompletion(null)}>Cancel</button><button className="button primary" disabled={busy||!Number.isFinite(good)||!Number.isFinite(scrap)||good<0||scrap<0||good+scrap>selectedOrder.qty} onClick={()=>void complete()}>{busy?'Saving…':'Complete order'}</button></div></div></div>}</>;
}


// The new printable catalog uses the team's real item/supplier/PO records.
export function ConnectedBarcodeLabels({state,flash}:{state:AppState;flash:(message:string)=>void}){
 const [result,setResult]=useState<{catalog:Item[];state:AppState}|null>(null),[error,setError]=useState('');
 const load=useCallback(async()=>{setError('');try{
  const [inventory,suppliers,assignments,orders,lines]=await Promise.all([loadInventorySnapshot(),supabase.from('suppliers').select('*'),supabase.from('items').select('sku,supplier_id,active'),supabase.from('purchase_orders').select('*'),supabase.from('purchase_order_lines').select('*')]);
  for(const r of [suppliers,assignments,orders,lines])if(r.error)throw Error(r.error.message);
  const records=(suppliers.data??[]).map((s:any)=>({id:s.id,name:s.name,contact:s.contact_name??'',email:s.email??'',phone:s.phone??'',address:s.address??'',lead:Number(s.quoted_lead_days),terms:Number(s.payment_terms_days),active:true,notes:''}));
  const itemSupplierIds=Object.fromEntries((assignments.data??[]).filter((i:any)=>i.supplier_id).map((i:any)=>[i.sku,i.supplier_id]));
  const enabled=new Set((assignments.data??[]).filter((i:any)=>i.active!==false).map((i:any)=>i.sku));
  const purchaseOrders:PurchaseOrder[]=(orders.data??[]).map((p:any)=>({id:p.id,supplierId:p.supplier_id,supplier:records.find((s:any)=>s.id===p.supplier_id)?.name??'',date:p.ordered_at.slice(0,10),expected:p.expected_at.slice(0,10),received:p.received_at?.slice(0,10),status:p.status,location:inventory.locations.find(l=>l.id===p.ship_to_location_id)?.name as Location,terms:records.find((s:any)=>s.id===p.supplier_id)?.terms??30,lines:(lines.data??[]).filter((l:any)=>l.purchase_order_id===p.id).map((l:any)=>({id:l.id,sku:l.item_sku,qty:Number(l.quantity_purchase),received:Number(l.quantity_received_purchase),unitPrice:Number(l.unit_price_purchase)}))}));
  setResult({catalog:inventory.items.filter(i=>enabled.has(i.sku)),state:{...state,supplierRecords:records,itemSupplierIds,purchaseOrders}});
 }catch(e){setError(e instanceof Error?e.message:'Unable to load barcode catalog.');}},[state]);
 useEffect(()=>{void load();},[load]);
 if(error)return <section className="panel"><p role="alert" className="login-error">{error}</p><button className="button secondary" onClick={()=>void load()}>Retry</button></section>;
 if(!result)return <section className="panel"><div className="empty-inline">Loading incoming item barcodes…</div></section>;
 return <BarcodeLabelsScreen state={result.state} catalog={result.catalog} flash={flash}/>;
}
