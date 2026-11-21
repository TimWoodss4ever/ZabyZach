import {sendPlanningRequest,hasPendingPlanningRequest,retryPlanningRequest} from './planningRequests';
import {CameraScanner} from './CameraScanner';
import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {Check,Activity,Minus,AlertTriangle,Boxes,CircleDollarSign,Warehouse,RotateCcw,Printer,X,ScanLine,Plus,ArrowRight,ArrowLeftRight,PackageCheck,Pizza,CheckCircle2,ClipboardList,Clock3,ArrowUpRight} from 'lucide-react';
import {InventoryWriteStatus,useInventoryWrite} from './InventoryAvailability';
import {InventoryWorkspace} from './InventoryWorkspace';
import type {InventoryMovementSelection} from './InventoryWorkspace';
import {validateInventoryQuantity} from './inventoryManagement';
import {BarcodeLabelsScreen} from './BarcodeLabels.tsx';
import type {AppState,Location,PurchaseOrder,Item} from './domain';
import {fmt} from './domain';
import {supabase} from './supabase';
import {renderCode128} from './barcode';
import {NumberInput} from './NumberInput';
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
export function ConnectedInventoryPage({search,flash,safetyDays,onOpenLabels,userId,canManage=false,onSearchChange}:{userId:string;search:string;flash:(s:string)=>void;safetyDays:number;onOpenLabels:()=>void;canManage?:boolean;onSearchChange:(value:string)=>void}){
 return <InventoryWorkspace userId={userId} search={search} onSearchChange={onSearchChange} safetyDays={safetyDays} onOpenLabels={onOpenLabels} canManage={canManage} renderMovement={selection=><ConnectedMovements userId={userId} flash={flash} initial={selection}/>}/>;
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
export function ConnectedMovements({flash,userId,initial}:{flash:(s:string)=>void;userId:string;initial?:InventoryMovementSelection}){
 const writeApi=useInventoryWrite(userId);
 const [lossQty,setLossQty]=useState(0);
 const [mode,setMode]=useState<'Transfer'|'Cycle count'>(initial?.mode??'Transfer');
 const [sku,setSku]=useState(initial?.sku??'1003');
 const [qty,setQty]=useState(initial?1:200);
 const [fromId,setFromId]=useState(initial?.locationId??'');
 const [toId,setToId]=useState('');
 const [count,setCount]=useState<number|''>('');
 const [reason,setReason]=useState(initial?.reason??'Cycle count correction');
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
 useEffect(()=>{void load();const refresh=()=>void load();window.addEventListener('erp-inventory-updated',refresh);return()=>window.removeEventListener('erp-inventory-updated',refresh);},[load]);
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
  if(submitting||writeApi.busy||writeApi.pending)return;
  setActionError('');setSubmitting(true);let sent=false;
  try{
   let variance=0;
   if(mode==='Transfer'){
    validateInventoryQuantity(qty,selectedItem.unit);
    if(from.id===to.id)throw Error('Choose two different locations.');
    if(qty>onHand(sku,from))throw Error('The transfer quantity exceeds available stock.');
    sent=true;await writeApi.execute('transfer',{sku,fromId:from.id,toId:to.id,quantity:qty});
   }else{
    const physicalCount=reason==='Cycle count correction'?(typeof count==='number'?count:NaN):onHand(sku,from)-lossQty;
    if(reason!=='Cycle count correction'){validateInventoryQuantity(lossQty,selectedItem.unit);if(lossQty>onHand(sku,from))throw Error('The loss quantity exceeds stock at this location.');}
    validateInventoryQuantity(physicalCount,selectedItem.unit,true);
    sent=true;const result=await writeApi.execute('adjustment',{sku,locationId:from.id,...(reason==='Cycle count correction'?{counted:physicalCount}:{lossQuantity:lossQty}),reason});variance=Number(result.variance);
   }
   if(!await load()){setActionError('The inventory action was saved, but balances could not be refreshed. Refresh before posting another action.');return;}
   if(mode==='Transfer')flash(`${qty} ${selectedItem.unit} transferred to ${to.name}.`);
   else if(variance===0)flash('Count matches on-hand; no adjustment was posted.');
   else flash(`Inventory adjustment posted: ${variance>0?'+':''}${variance} ${selectedItem.unit}.`);
  }catch(error){if(!sent)setActionError(error instanceof Error?error.message:'Check the inventory form.');}
  finally{setSubmitting(false);}
 };
 return <div className="movement-layout">{loadError&&<div className="login-error" role="alert">{loadError}</div>}<section className="panel movement-form"><div className="tab-switch">{(['Transfer','Cycle count'] as const).map(x=><button key={x} className={mode===x?'selected':''} onClick={()=>setMode(x)}>{x==='Transfer'?<ArrowLeftRight size={15}/>:<RotateCcw size={15}/>} {x==='Transfer'?'Transfer':'Count / damage'}</button>)}</div><div className="form-section-title"><span className="step-index">01</span><div><h2>{mode==='Transfer'?'Move inventory':reason==='Cycle count correction'?'Record a physical count':'Record damage or loss'}</h2><p>{mode==='Transfer'?'Choose where stock leaves and where it arrives.':reason==='Cycle count correction'?'Enter the total physically counted, including zero.':'Enter only the quantity lost; current stock is checked before posting.'}</p></div></div><label className="field-label">Scan item barcode or enter SKU</label><div className="scan-input"><ScanLine size={16}/><input value={barcode} onChange={event=>setBarcode(event.target.value)} onKeyDown={event=>event.key==='Enter'&&resolve()} placeholder="e.g. ZBZ-1003"/><kbd>ENTER</kbd><button onClick={resolve}>Find item</button></div><label className="field-label mt">Item</label><select value={selectedItem.sku} onChange={event=>setSku(event.target.value)}>{selectableItems.map(item=><option value={item.sku} key={item.sku}>{item.name} · {item.sku}</option>)}</select><div className="form-grid two"><div><label className="field-label">{mode==='Transfer'?'From location':'Count at'}</label><select value={from.id} onChange={event=>{const nextId=event.target.value;setFromId(nextId);if(to.id===nextId)setToId(snapshot.locations.find(location=>location.id!==nextId)?.id??nextId);}}>{snapshot.locations.map(location=><option key={location.id} value={location.id}>{location.name}</option>)}</select><small className="helper">Current: {onHand(selectedItem.sku,from).toLocaleString()} {selectedItem.unit}</small></div>{mode==='Transfer'?<div><label className="field-label">To location</label><select value={to.id} onChange={event=>setToId(event.target.value)}>{snapshot.locations.filter(location=>location.id!==from.id).map(location=><option key={location.id} value={location.id}>{location.name}</option>)}</select></div>:<div><label className="field-label">{reason==='Cycle count correction'?'Physical count':'Quantity damaged / lost'} · {selectedItem.unit}</label><NumberInput type="number" min="0" step={selectedItem.unit==='each'?'1':'any'} value={reason==='Cycle count correction'?count:lossQty} onChange={event=>reason==='Cycle count correction'?setCount(event.target.value===''?'':Number(event.target.value)):setLossQty(Number(event.target.value))}/><small className="helper">Estimated after adjustment: {reason==='Cycle count correction'?count:onHand(sku,from)-lossQty} {selectedItem.unit}. {reason==='Cycle count correction'?'Enter the amount physically counted.':'Enter the amount lost, not the remaining stock.'}</small></div>}</div><div className="form-grid two"><div><label className="field-label">{mode==='Transfer'?'Quantity':'Reason code'}</label>{mode==='Transfer'?<NumberInput type="number" min="0.000001" step={selectedItem.unit==='each'?'1':'any'} value={qty} onChange={event=>setQty(Number(event.target.value))}/>:<select value={reason} onChange={event=>setReason(event.target.value)}>{['Cycle count correction','Spoiled/Expired','Damaged','Dropped/Spilled','Theft/Unknown loss'].map(value=><option key={value}>{value}</option>)}</select>}</div>{mode==='Transfer'&&<div><label className="field-label">Unit cost</label><div className="readonly-input">{usd(itemCost(selectedItem))} / {selectedItem.unit}</div></div>}</div>{mode==='Transfer'&&<div className="transfer-note"><Check size={15}/><span>Transfer out and transfer in post together. Total inventory value stays constant.</span></div>}{actionError&&<div className="login-error" role="alert">{actionError}</div>}<InventoryWriteStatus api={writeApi}/><button className="button primary form-submit" onClick={()=>void submit()} disabled={submitting||writeApi.busy||!!writeApi.pending||loading||!from.id||!to.id}>{submitting?'Posting…':mode==='Transfer'?'Post transfer':reason==='Cycle count correction'?'Save physical count':'Record damage / loss'} <ArrowUpRight size={16}/></button></section>
 <section className="panel movement-side"><div className="panel-head"><div><h2>Recent stock movements</h2><p>From the Supabase transaction ledger</p></div><span className="ledger-badge"><Activity size={14}/>{snapshot.transactionCount.toLocaleString()} entries</span></div><div className="movement-list">{snapshot.recent.map(transaction=>{const item=itemBySku.get(transaction.item_sku)!;const location=locationById.get(transaction.location_id)!;const isTransfer=transaction.transaction_type.toLowerCase().startsWith('transfer');return <div className="movement-item" key={transaction.id}><div className={`movement-icon ${transaction.quantity>0?'positive':isTransfer?'transfer':'negative'}`}>{isTransfer?<ArrowLeftRight size={15}/>:transaction.quantity>0?<Plus size={15}/>:<Minus size={15}/>}</div><div className="movement-copy"><b>{item.name}</b><span>{transaction.transaction_type} · {transaction.reference_document??'—'}{transaction.reason_code?` · ${transaction.reason_code}`:''}</span></div><div className="movement-qty"><b className={transaction.quantity>0?'text-green':'text-red'}>{transaction.quantity>0?'+':''}{transaction.quantity.toLocaleString()} {item.unit}</b><span>{location.name.split(' ')[0]} · {dateLabel(transaction.occurred_at.slice(0,10))}</span></div></div>;})}</div></section></div>;
}
function BarcodeModal({catalog,onClose,flash}:{catalog:Item[];onClose:()=>void;flash:(m:string)=>void}){const [chosen,setChosen]=useState(catalog.slice(0,8).map(i=>i.sku));const svgRefs=useRef<Record<string,SVGSVGElement|null>>({});useEffect(()=>{for(const i of catalog.filter(x=>chosen.includes(x.sku))){const el=svgRefs.current[i.sku];if(el)renderCode128(el,i.barcode);}},[catalog,chosen]);return <div className="modal-backdrop"><div className="modal labels-modal"><button className="modal-x" onClick={onClose}><X size={18}/></button><span className="eyebrow">BARCODE LABELS</span><h2>Print item labels</h2><p>Select products to print Code 128 labels for demo props.</p><div className="label-picker">{catalog.map(i=><label key={i.sku}><input type="checkbox" checked={chosen.includes(i.sku)} onChange={e=>setChosen(v=>e.target.checked?[...v,i.sku]:v.filter(s=>s!==i.sku))}/>{i.name}</label>)}</div><div className="label-sheet">{catalog.filter(i=>chosen.includes(i.sku)).map(i=><div className="barcode-label" key={i.sku}><b>Za by Zach</b><span>{i.name}</span><svg ref={el=>{svgRefs.current[i.sku]=el}}/><small>SKU {i.sku}</small></div>)}</div><div className="modal-actions"><button className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" onClick={()=>{window.print();flash('Barcode labels sent to print.');}}><Printer size={15}/> Print labels</button></div></div></div>}

type ProductionItemRecord={sku:string;name:string;unit_cost:number;active:boolean;hasBom:boolean;unitCost:number};
type ProductionLocationRecord={id:string;name:string};
type ProductionOrderRecord={id:string;order_no:string;parent_sku:string;location_id:string;quantity_started:number;quantity_good:number;quantity_scrapped:number;status:string;started_at:string|null;finished_at:string|null;reason_code:string|null};
type ProductionOrderView={id:string;orderNo:string;sku:string;location:string;qty:number;good:number;scrap:number;status:'Planned'|'In Progress'|'Completed';started?:string;startedAt?:string;finishedAt?:string;reason?:string;unitCost:number};
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
  return{id:order.id,orderNo:order.order_no,sku:order.parent_sku,location:location.name,qty,good,scrap,status:order.status,started:order.started_at?.slice(0,10),startedAt:order.started_at??undefined,finishedAt:order.finished_at??undefined,reason:order.reason_code??undefined,unitCost:unitCostBySku[order.parent_sku]??0};
 });
 return{items,locations:locationRows,orders};
}
const fmtStamp=(iso?:string)=>iso?new Date(iso).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZone:'America/Denver'}):'—';
const fmtDuration=(mins:number)=>mins<1?`${Math.round(mins*60)} sec`:mins<120?`${mins.toFixed(1)} min`:`${(mins/60).toFixed(1)} hr`;
const denverDay=(d:Date)=>d.toLocaleDateString('en-CA',{timeZone:'America/Denver'});
export function ConnectedProductionPage({flash,userId}:{flash:(message:string)=>void;userId:string}){
 const [snapshot,setSnapshot]=useState<ProductionSnapshot|null>(null);
 const [loading,setLoading]=useState(true);
 const [loadError,setLoadError]=useState('');
 const [actionError,setActionError]=useState('');
 const [busy,setBusy]=useState(false);
 const [showNew,setShowNew]=useState(false);
 const [sku,setSku]=useState('1030');
 const [qty,setQty]=useState(20);
 const [due,setDue]=useState(()=>denverDay(new Date()));
 const [locationId,setLocationId]=useState('');
 const [completion,setCompletion]=useState<string|null>(null);
 const [good,setGood]=useState(18);
 const [scrap,setScrap]=useState(2);
 const [reason,setReason]=useState('Burnt');
 const [reportTo,setReportTo]=useState(()=>denverDay(new Date()));
 const [reportFrom,setReportFrom]=useState(()=>denverDay(new Date(Date.now()-29*86400000)));
 const load=useCallback(async()=>{
  setLoading(true);setLoadError('');
  try{setSnapshot(await loadProductionSnapshot());return null;}
  catch(error){const message=error instanceof Error?error.message:'Unable to load production data from Supabase.';setLoadError(message);return message;}
  finally{setLoading(false);}
 },[]);
 useEffect(() => {   void load();    const refresh = () => {     if (document.visibilityState === 'visible') void load();   };    const channel = supabase     .channel(`production-live-${userId}`)     .on(       'postgres_changes',       { event: '*', schema: 'public', table: 'production_orders' },       refresh     )     .on(       'postgres_changes',       { event: '*', schema: 'public', table: 'inventory_transactions' },       refresh     )     .subscribe();    window.addEventListener('focus', refresh);   document.addEventListener('visibilitychange', refresh);    return () => {     window.removeEventListener('focus', refresh);     document.removeEventListener('visibilitychange', refresh);     void supabase.removeChannel(channel);   }; }, [load, userId]);
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
   await sendPlanningRequest(userId,'production-create','erp_create_scheduled_production',{sku,locationId,quantity:qty,due},(name,args)=>supabase.rpc(name,args));
   setShowNew(false);
   await refreshAfterWrite('Production order created and scheduled.','Production order creation');
  }catch(error){setActionError(`Unable to create production order: ${error instanceof Error?error.message:'Unexpected Supabase error.'}`);}
  finally{setBusy(false);}
 };
 const recoverCreate=async()=>{if(busy)return;setBusy(true);try{await retryPlanningRequest(userId,'production-create','erp_create_scheduled_production',(name,args)=>supabase.rpc(name,args));setShowNew(false);await refreshAfterWrite('Scheduled production confirmed.','Production creation');}catch(error){setActionError(error instanceof Error?error.message:'Unable to recover production.');}finally{setBusy(false);}};
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
 const inRange=completed.filter(o=>{if(!o.finishedAt)return false;const d=denverDay(new Date(o.finishedAt));return d>=reportFrom&&d<=reportTo;}).sort((a,b)=>(b.finishedAt??'').localeCompare(a.finishedAt??''));
 const rStarted=inRange.reduce((t,o)=>t+o.qty,0),rGood=inRange.reduce((t,o)=>t+o.good,0),rScrap=inRange.reduce((t,o)=>t+o.scrap,0);
 const rScrapCost=inRange.reduce((t,o)=>t+o.scrap*o.unitCost,0),rTotalCost=inRange.reduce((t,o)=>t+o.qty*o.unitCost,0);
 const timed=inRange.filter(o=>o.startedAt&&o.finishedAt);
 const rAvgMin=timed.length?timed.reduce((t,o)=>t+(new Date(o.finishedAt!).getTime()-new Date(o.startedAt!).getTime())/60000,0)/timed.length:0;
 const rYield=rStarted?rGood/rStarted*100:0,rScrapRate=rStarted?rScrap/rStarted*100:0,rCostPerGood=rGood?rTotalCost/rGood:0;
 const scrapByReason=new Map<string,number>();for(const o of inRange)if(o.scrap>0)scrapByReason.set(o.reason||'Unspecified',(scrapByReason.get(o.reason||'Unspecified')??0)+o.scrap);
 return <>{hasPendingPlanningRequest(userId,'production-create')&&<div className="p-note" role="status">A production save needs confirmation. <button className="button secondary" disabled={busy} onClick={()=>void recoverCreate()}>Recover production save</button></div>}{(actionError||loadError)&&<div className="login-error" role="alert">{actionError||loadError}{loadError&&<button className="table-action" onClick={()=>{setActionError('');void load();}}>Retry</button>}</div>}<div className="stats-grid compact-stats"><StatCard label="Production orders" value={String(snapshot.orders.length)} icon={Pizza} sub="Planned + completed"/><StatCard label="Yield" value={`${yieldPct.toFixed(1)}%`} icon={Activity} accent="green" sub="Good units ÷ started units"/><StatCard label="Units scrapped" value={String(snapshot.orders.reduce((sum,order)=>sum+order.scrap,0))} icon={AlertTriangle} accent="amber" sub="By recorded reason"/><StatCard label="Scrap cost" value={usd(scrapCost)} icon={CircleDollarSign} accent="red" sub="Rolled-up recipe cost"/></div><section className="panel"><div className="panel-head table-header"><div><h2>Production orders</h2><p>Make dough and prepared items in house; issue their bill of materials and receive good units at rolled-up cost.</p></div><button className="button primary" disabled={busy||!makeItems.length||!snapshot.locations.length} onClick={()=>setShowNew(true)}><Plus size={15}/> New production order</button></div><div className="table-scroll"><table><thead><tr><th>ORDER</th><th>ITEM</th><th>LOCATION</th><th className="right">STARTED</th><th className="right">GOOD / SCRAP</th><th>STATUS</th><th></th></tr></thead><tbody>{snapshot.orders.length?snapshot.orders.map(order=><tr key={order.id}><td><b className="mono">{order.orderNo}</b><small className="cell-sub">{order.startedAt?`Started ${fmtStamp(order.startedAt)}${order.finishedAt?` · Finished ${fmtStamp(order.finishedAt)}`:''}`:'Not started yet'}</small></td><td><b>{itemBySku.get(order.sku)?.name??order.sku}</b><small className="cell-sub">Cost {usd(order.unitCost)} / unit</small></td><td>{order.location.split(' ')[0]}</td><td className="right">{order.qty}</td><td className="right">{order.status==='Completed'?`${order.good} / ${order.scrap}`:'—'}</td><td><span className={`status-chip ${order.status==='Completed'?'good':order.status==='In Progress'?'warn':'info'}`}>{order.status}</span></td><td className="right">{order.status==='Planned'?<button className="table-action" disabled={busy} onClick={()=>void issue(order)}><PackageCheck size={14}/> Issue</button>:order.status==='In Progress'?<button className="table-action" disabled={busy} onClick={()=>{setCompletion(order.id);setGood(order.qty);setScrap(0);}}><Check size={14}/> Complete</button>:<span className="text-muted">{order.reason||'—'}</span>}</td></tr>):<tr><td colSpan={7}><div className="empty-inline">No production orders yet. Create a batch or run a production acceptance scenario.</div></td></tr>}</tbody></table></div></section><section className="panel"><div className="panel-head table-header"><div><h2>Production report</h2><p>Completed orders in the date range, computed live from stored production orders.</p></div><div className="form-grid two"><div><label className="field-label">From</label><input type="date" value={reportFrom} max={reportTo} onChange={event=>setReportFrom(event.target.value)}/></div><div><label className="field-label">To</label><input type="date" value={reportTo} min={reportFrom} onChange={event=>setReportTo(event.target.value)}/></div></div></div><div className="stats-grid compact-stats"><StatCard label="Orders completed" value={String(inRange.length)} icon={PackageCheck} sub={`${rStarted} units started`}/><StatCard label="Yield" value={`${rYield.toFixed(1)}%`} icon={Activity} accent="green" sub={`${rGood} good ÷ ${rStarted} started`}/><StatCard label="Scrap rate" value={`${rScrapRate.toFixed(1)}%`} icon={AlertTriangle} accent="amber" sub={`${rScrap} units scrapped`}/><StatCard label="Avg batch time" value={timed.length?fmtDuration(rAvgMin):'—'} icon={Clock3} sub="Issue to complete"/><StatCard label="Cost / good unit" value={usd(rCostPerGood)} icon={CircleDollarSign} sub="Includes scrap loss"/><StatCard label="Scrap cost" value={usd(rScrapCost)} icon={CircleDollarSign} accent="red" sub="Rolled-up recipe cost"/></div>{scrapByReason.size>0&&<p className="cell-sub">Scrap by reason: {[...scrapByReason.entries()].map(([r,n])=>`${r} ${n}`).join(' · ')}</p>}<div className="table-scroll"><table><thead><tr><th>ORDER</th><th>ITEM</th><th>STARTED</th><th>FINISHED</th><th className="right">BATCH TIME</th><th className="right">STARTED QTY</th><th className="right">GOOD</th><th className="right">SCRAPPED</th><th>REASON</th><th className="right">YIELD</th></tr></thead><tbody>{inRange.length?inRange.map(o=><tr key={o.id}><td><b className="mono">{o.orderNo}</b></td><td>{itemBySku.get(o.sku)?.name??o.sku}</td><td>{fmtStamp(o.startedAt)}</td><td>{fmtStamp(o.finishedAt)}</td><td className="right">{o.startedAt&&o.finishedAt?fmtDuration((new Date(o.finishedAt).getTime()-new Date(o.startedAt).getTime())/60000):'—'}</td><td className="right">{o.qty}</td><td className="right">{o.good}</td><td className="right">{o.scrap}</td><td>{o.reason||'—'}</td><td className="right">{o.qty?(o.good/o.qty*100).toFixed(0):0}%</td></tr>):<tr><td colSpan={10}><div className="empty-inline">No completed production orders in this date range.</div></td></tr>}</tbody></table></div></section>{showNew&&<div className="modal-backdrop"><div className="modal form-modal"><button className="modal-x" disabled={busy} onClick={()=>setShowNew(false)}><X size={18}/></button><span className="eyebrow">IN-HOUSE PREP</span><h2>Create production order</h2><p>Components will be checked when the order is issued. Scheduled output is available to MRP on its completion date.</p><label className="field-label">Item to make</label><select value={selectedItem?.sku??''} onChange={event=>setSku(event.target.value)}>{makeItems.map(item=><option value={item.sku} key={item.sku}>{item.name} · {usd(item.unitCost)}/unit</option>)}</select><div className="form-grid two"><div><label className="field-label">Completion date</label><input aria-label="Production completion date" type="date" min={denverDay(new Date())} value={due} onChange={event=>setDue(event.target.value)}/><label className="field-label">Quantity to start</label><NumberInput type="number" min="1" value={qty} onChange={event=>setQty(Number(event.target.value))}/></div><div><label className="field-label">Location</label><select value={locationId} onChange={event=>setLocationId(event.target.value)}>{snapshot.locations.map(location=><option key={location.id} value={location.id}>{location.name}</option>)}</select></div></div><div className="modal-actions"><button className="button secondary" disabled={busy} onClick={()=>setShowNew(false)}>Cancel</button><button className="button primary" disabled={busy||hasPendingPlanningRequest(userId,'production-create')||!due||!selectedItem||!locationId||!Number.isFinite(qty)||qty<=0} onClick={()=>void create()}>{busy?'Saving…':'Create order'}</button></div></div></div>}{completion&&selectedOrder&&<div className="modal-backdrop"><div className="modal form-modal"><button className="modal-x" disabled={busy} onClick={()=>setCompletion(null)}><X size={18}/></button><span className="eyebrow">COMPLETE PRODUCTION</span><h2>Record good units and scrap</h2><p>Started {selectedOrder.qty} units. Good + scrapped must equal {selectedOrder.qty}. A reason is required if any are scrapped.</p><div className="form-grid two"><div><label className="field-label">Good units</label><NumberInput type="number" min="0" value={good} onChange={event=>setGood(Number(event.target.value))}/></div><div><label className="field-label">Scrapped units</label><NumberInput type="number" min="0" value={scrap} onChange={event=>setScrap(Number(event.target.value))}/></div></div><label className="field-label mt">Scrap reason</label><select value={reason} onChange={event=>setReason(event.target.value)}>{['Burnt','Dropped','Wrong toppings','Undercooked','Other'].map(value=><option key={value}>{value}</option>)}</select><div className="modal-actions"><button className="button secondary" disabled={busy} onClick={()=>setCompletion(null)}>Cancel</button><button className="button primary" disabled={busy||!Number.isFinite(good)||!Number.isFinite(scrap)||good<0||scrap<0||good+scrap!==selectedOrder.qty} onClick={()=>void complete()}>{busy?'Saving…':'Complete order'}</button></div></div></div>}</>;
}


// The new printable catalog uses the team's real item/supplier/PO records.
export function ConnectedBarcodeLabels({state,flash,onReceive}:{state:AppState;flash:(message:string)=>void;onReceive?:(code:string)=>void}){
 const [result,setResult]=useState<{catalog:Item[];state:AppState;orderNumbers:Record<string,string>}|null>(null),[error,setError]=useState('');
 const load=useCallback(async()=>{setError('');try{
  const response=await supabase.rpc('erp_barcode_catalog');if(response.error)throw Error(response.error.message);const raw=response.data;
  const recipes:Record<string,Record<string,number>>={};for(const b of raw.bom??[])(recipes[b.parent_sku]??={})[b.component_sku]=Number(b.quantity);
  const inventory={items:(raw.items as any[]).map(row=>({sku:row.sku,name:row.name,category:row.category,barcode:row.barcode,unit:row.base_unit,pack:row.purchase_unit,factor:Number(row.conversion_factor),cost:Number(row.unit_cost),price:Number(row.selling_price),shelf:row.shelf_life_days,supplier:'',lead:row.lead_days,recipe:recipes[row.sku],makeToStock:row.category==='Ingredient'&&!!recipes[row.sku]} as Item)),locations:raw.locations as InventoryLocationRow[]};
  const suppliers={data:raw.suppliers as any[]},assignments={data:raw.items as any[]},orders={data:raw.orders as any[]},lines={data:raw.lines as any[]};
  const records=(suppliers.data??[]).map((s:any)=>({id:s.id,name:s.name,contact:s.contact_name??'',email:s.email??'',phone:s.phone??'',address:s.address??'',lead:Number(s.quoted_lead_days),terms:Number(s.payment_terms_days),active:true,notes:''}));
  const itemSupplierIds=Object.fromEntries((assignments.data??[]).filter((i:any)=>i.supplier_id).map((i:any)=>[i.sku,i.supplier_id]));
  const enabled=new Set((assignments.data??[]).filter((i:any)=>i.active!==false).map((i:any)=>i.sku));
  const purchaseOrders:PurchaseOrder[]=(orders.data??[]).map((p:any)=>({id:p.id,supplierId:p.supplier_id,supplier:records.find((s:any)=>s.id===p.supplier_id)?.name??'',date:p.ordered_at.slice(0,10),expected:p.expected_at.slice(0,10),received:p.received_at?.slice(0,10),status:p.status,location:inventory.locations.find(l=>l.id===p.ship_to_location_id)?.name as Location,terms:records.find((s:any)=>s.id===p.supplier_id)?.terms??30,lines:(lines.data??[]).filter((l:any)=>l.purchase_order_id===p.id).map((l:any)=>({id:l.id,sku:l.item_sku,qty:Number(l.quantity_purchase),received:Number(l.quantity_received_purchase),unitPrice:Number(l.unit_price_purchase)}))}));
  setResult({orderNumbers:Object.fromEntries((orders.data??[]).map((p:any)=>[p.id,p.po_no??p.id])),catalog:inventory.items.filter(i=>enabled.has(i.sku)),state:{...state,supplierRecords:records,itemSupplierIds,purchaseOrders}});
 }catch(e){setError(e instanceof Error?e.message:'Unable to load barcode catalog.');}},[state]);
 useEffect(()=>{void load();},[load]);
 if(error)return <section className="panel"><p role="alert" className="login-error">{error}</p><button className="button secondary" onClick={()=>void load()}>Retry</button></section>;
 if(!result)return <section className="panel"><div className="empty-inline">Loading incoming item barcodes…</div></section>;
 return <BarcodeLabelsScreen state={result.state} catalog={result.catalog} orderNumbers={result.orderNumbers} flash={flash} onReceive={onReceive}/>;
}
