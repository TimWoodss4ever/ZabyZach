import {SharedDashboard} from './SharedDashboard';
import {NumberInput} from './NumberInput';
import {OrderHistory} from './OrderHistory';
import {cardError,cardSummary,detectCardBrand,digitsOnly} from './cardValidation';
import {CameraScanner} from './CameraScanner';
import {loadPosCustomer,postPosSale,readPendingPosSale,recoverPosSale} from './posCheckoutData';
import type {PosCustomer} from './posCheckout';
import {SharedMrpScreen,SharedOrdersScreen} from './SharedPlanningScreens';
import {type SharedOrderConfirmation,sendPlanningRequest,hasPendingPlanningRequest,pendingPlanningRequest,sharedPickupConfirmation} from './planningRequests';
import {SharedPurchasingScreen} from './SharedPurchasingScreens';
import {SharedReporting} from './SharedReporting';
import {ConnectedBarcodeLabels,ConnectedInventoryPage,ConnectedMovements,ConnectedProductionPage} from './ExistingDatabaseScreens';
import {supabase} from './supabase';
import {customerCartPlan,isCustomerAvailability} from './customerAvailability';
import {RewardsRedemption,useCustomerRewards} from './CustomerRewards';
import {customerRewardsRpc} from './customerRewardsData';
import type {CustomerAvailability,CustomerStockStatus} from './customerAvailability';
import './customerAvailability.css';
import type {Session} from '@supabase/supabase-js';
import {SuppliersScreen,PurchaseOrdersScreen,SupplierScorecardsScreen,InventoryReviewScreen,SupplierPayablesSummary} from './PurchasingScreens';
import {PizzaGuide,HelpSupportScreen} from './PizzaGuide';
import {getSuppliers,createPurchaseOrder,supplierForItem,isOpenPO,isDeliveredPO} from './purchasing';
import { pickupSlots, pickupSchedule } from './pickup';
import { formatCardNumber, formatCardExpiry, updateFormattedPaymentInput } from './paymentFormatting';
import { type FormEvent, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, Bell, Boxes, Building2, CalendarClock, Check, ChevronDown, ClipboardList, CircleDollarSign, Cog, FileText, Gauge, Home, LogOut, PackageCheck, Pizza, Printer, Search, ShoppingCart, Truck, UserRound, Users, Warehouse, X, ScanLine, ArrowLeftRight, RotateCcw, AlertTriangle, Plus, Minus, ArrowUpRight, Clock3, Settings2, ShieldCheck, Menu, Activity, Sparkles, MapPin, CheckCircle2, ArrowLeft } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {BarcodeLabelsScreen} from './BarcodeLabels.tsx';
import { AppState, Item, LoyaltyCustomer, SaleInput, Ledger, Location, PurchaseOrder, Role, Sale, SalesOrder, applyAdjustment, applyReturn, applySale, cartStockIssue, businessDate, completeCustomerOrder, fulfillSalesOrder, saleBreakdown, applyTransfer, findLoyaltyCustomer, formatCustomerPhone, normalizeCustomerPhone, saveLoyaltyCustomer, loyaltySummary, customizedItem, sauceOptions, toppingOptions, toppingPortion, toppingCharge, avgDaily, completeProductionOrder, createProductionOrder, customers, eoq, fmt, inventory, issueProductionOrder, items, loadState, locations, maxMake, mrpRows, recipeCost, receivePO, reorderPoint, resetState, saveState, suppliers, today } from './domain';
import zaLogo from './assets/za-logo.png';
import brickOvenHero from './assets/brick-oven-kitchen.png';
import avatarImg from './assets/avatar.png';
import {pizzaImages} from './pizzaImages';
import {buildDeliveryQuote,customerStoreInfo,deliveryLimitMinutes,formatDeliveryAddress,type DeliveryAddress,type DeliveryQuote,type FulfillmentType} from './delivery';
import './customerDelivery.css';

type Page='Dashboard'|'POS'|'Sales Orders'|'Returns'|'Inventory'|'Transfers & Counts'|'Barcode Labels'|'Production'|'Purchase Orders'|'Supplier Scorecards'|'Suppliers'|'Inventory Review'|'Help & Support'|'MRP'|'Financials'|'Reports'|'Settings'|'About';
const groups:[string,{label:Page;icon:any}[]][]=[['Workspace',[{label:'Dashboard',icon:Home},{label:'POS',icon:ShoppingCart},{label:'Sales Orders',icon:ClipboardList},{label:'Returns',icon:RotateCcw}]],['Operations',[{label:'Inventory',icon:Boxes},{label:'Barcode Labels',icon:ScanLine},{label:'Transfers & Counts',icon:ArrowLeftRight},{label:'Production',icon:Pizza},{label:'MRP',icon:CalendarClock}]],['Purchasing',[{label:'Suppliers',icon:Users},{label:'Purchase Orders',icon:Truck},{label:'Inventory Review',icon:ClipboardList},{label:'Supplier Scorecards',icon:BarChart3}]],['Insights',[{label:'Financials',icon:CircleDollarSign},{label:'Reports',icon:BarChart3},{label:'Settings',icon:Cog},{label:'About',icon:FileText},{label:'Help & Support',icon:UserRound}]]];
const usd=(n:number)=>fmt(n);const itm=(sku:string)=>items.find(i=>i.sku===sku)!;const componentUsage=(sku:string,target:string,qty=1,seen=new Set<string>()):number=>{if(seen.has(sku))return 0;const current=itm(sku);if(!current.recipe)return sku===target?qty:0;const next=new Set(seen).add(sku);return Object.entries(current.recipe).reduce((sum,[component,amount])=>sum+componentUsage(component,target,qty*amount,next),0);};const dateLabel=(s:string)=>new Date(`${s}T12:00:00`).toLocaleDateString('en-US',{month:'short',day:'numeric'});const pickupTimeLabel=(time?:string)=>time?new Date('2000-01-01T'+time+':00').toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}):'Time not selected';
type AuthProfile={userId:string;email:string;role:Role;customerId:string|null};
const isRole=(value:string):value is Role=>value==='Manager'||value==='Cashier'||value==='Customer';
type RecordSaleResult={sale_id:string;receipt_no:string;subtotal:number;discount:number;tax:number;total:number;cogs:number};
type PosReceipt={receiptNo:string;saleId:string;date:string;location:Location;lines:{sku:string;qty:number}[];subtotal:number;discount:number;tax:number;total:number;cardBrand?:string;cardLast4?:string};
type ReturnSaleLine={id:string;item_sku:string;quantity:number};
type ReturnSale={id:string;receipt_no:string;location_id:string;location_name:string;customer_id:string|null;total:number;status:string;created_at:string;lines:ReturnSaleLine[]};
type ReturnHistoryLine={id:string;return_id:string;original_sale_id:string;original_sale_line_id:string;item_sku:string;quantity:number;reason_code:string;disposition:'Restock'|'Waste';refund_total:number;cost_amount:number};
type ReturnHistory={id:string;transaction_type:'Return'|'Exchange';original_sale_id:string;replacement_sale_id:string|null;refund_total:number;replacement_total:number;settlement_net:number;settlement_mode:string;created_at:string;lines:ReturnHistoryLine[]};
type ReturnRpcResult={return_id:string;transaction_type:'Return'|'Exchange';refund_total:number;replacement_total:number;settlement_net:number;settlement_mode:'Manual/Simulated'};
function isReturnRpcResult(value:unknown):value is ReturnRpcResult{
 if(!value||typeof value!=='object')return false;
 const result=value as Record<string,unknown>;
 return typeof result.return_id==='string'&&(result.transaction_type==='Return'||result.transaction_type==='Exchange')&&
  ['refund_total','replacement_total','settlement_net'].every(key=>typeof result[key]==='number'&&Number.isFinite(result[key]))&&
  result.settlement_mode==='Manual/Simulated';
}
function isRecordSaleResult(value:unknown):value is RecordSaleResult{
 if(!value||typeof value!=='object')return false;
 const result=value as Record<string,unknown>;
 return typeof result.sale_id==='string'&&typeof result.receipt_no==='string'&&
  ['subtotal','discount','tax','total','cogs'].every(key=>typeof result[key]==='number'&&Number.isFinite(result[key]));
}
function App(){
 const [state,setState]=useState<AppState>(()=>loadState());const [page,setPage]=useState<Page>('Dashboard');const [receivingCode,setReceivingCode]=useState('');const pageHistory=useRef<Page[]>([]);const [profile,setProfile]=useState<AuthProfile|null>(null);const [authLoading,setAuthLoading]=useState(true);const [authError,setAuthError]=useState('');const [location,setLocation]=useState<Location>('Provo Campus Store');const [toast,setToast]=useState('');const [returnSaleId,setReturnSaleId]=useState<string|null>(null);const [search,setSearch]=useState('');const [collapsed,setCollapsed]=useState(true);const [navHovered,setNavHovered]=useState(false),[navFocused,setNavFocused]=useState(false);const navExpanded=!collapsed||navHovered||navFocused;
 const role=profile?.role??null,login=profile?.email??'';
 const globalSearchRef=useRef<HTMLInputElement>(null);
 const [searchOpen,setSearchOpen]=useState(false);
 useEffect(()=>{if(role!=='Manager'&&role!=='Cashier')return;const shortcut=(event:KeyboardEvent)=>{if((event.metaKey||event.ctrlKey)&&!event.altKey&&event.key.toLowerCase()==='k'){event.preventDefault();setCollapsed(true);window.setTimeout(()=>{const input=page==='Inventory'?document.querySelector<HTMLInputElement>('input[aria-label="Search inventory"]'):globalSearchRef.current;input?.focus();input?.select();setSearchOpen(true);},50);}};window.addEventListener('keydown',shortcut);return()=>window.removeEventListener('keydown',shortcut);},[role,page]);
 const mutate=useCallback((next:AppState)=>{saveState(next);setState({...next,ledger:[...next.ledger],sales:[...next.sales],salesOrders:[...next.salesOrders],purchaseOrders:[...next.purchaseOrders],returns:[...next.returns],productionOrders:[...next.productionOrders]});},[]);
 const flash=useCallback((s:string)=>{setToast(s);setTimeout(()=>setToast(''),3200);},[]);
 const historyIndex=useRef(0);useEffect(()=>{try{window.history.replaceState({zabyPage:'Dashboard',idx:0},'',window.location.pathname+window.location.search);}catch{}const onPop=(event:PopStateEvent)=>{const s=event.state as {zabyPage?:Page;idx?:number}|null;if(s&&s.zabyPage){historyIndex.current=s.idx??0;setPage(s.zabyPage);setCollapsed(true);}};window.addEventListener('popstate',onPop);return()=>window.removeEventListener('popstate',onPop);},[]);const navigatePage=useCallback((next:Page)=>{if(next!==page){pageHistory.current.push(page);setPage(next);historyIndex.current+=1;try{window.history.pushState({zabyPage:next,idx:historyIndex.current},'','#'+encodeURIComponent(next));}catch{}}setCollapsed(true);setNavHovered(false);setNavFocused(false);requestAnimationFrame(()=>menuToggleRef.current?.focus({preventScroll:true}));},[page]);
 const goBack=useCallback(()=>{if(historyIndex.current>0){window.history.back();}else if(page!=='Dashboard')setPage('Dashboard');setCollapsed(true);setNavHovered(false);setNavFocused(false);},[page]);
 const mrpActionCount=0; // Shared MRP is calculated from its own dated database snapshot.
 const navigationRef=useRef<HTMLElement>(null),menuToggleRef=useRef<HTMLButtonElement>(null);
 useEffect(()=>{if(role!=='Manager'&&role!=='Cashier')return;const frame=requestAnimationFrame(()=>{if(collapsed)menuToggleRef.current?.focus({preventScroll:true});else navigationRef.current?.querySelector<HTMLButtonElement>('.collapse-btn')?.focus({preventScroll:true});});return()=>cancelAnimationFrame(frame);},[collapsed,role]);
 useEffect(()=>{const sync=()=>setState(loadState());const local=()=>sync();window.addEventListener('storage',sync);window.addEventListener('zbyZach-state',local);return()=>{window.removeEventListener('storage',sync);window.removeEventListener('zbyZach-state',local);};},[]);
 useEffect(()=>{const close=(event:KeyboardEvent)=>{if(event.key==='Escape'){setCollapsed(true);setNavHovered(false);setNavFocused(false);menuToggleRef.current?.focus({preventScroll:true});}};window.addEventListener('keydown',close);return()=>window.removeEventListener('keydown',close);},[]);
 useEffect(()=>{let active=true;let request=0;const loadProfile=async(session:Session|null)=>{const currentRequest=++request;if(!session){setProfile(null);setAuthError('');setAuthLoading(false);return;}setAuthLoading(true);setAuthError('');try{const {data,error}=await supabase.from('profiles').select('role, customer_id').eq('user_id',session.user.id).maybeSingle();if(!active||currentRequest!==request)return;if(error){setProfile(null);setAuthError(`Unable to load your profile: ${error.message}`);setAuthLoading(false);return;}if(!data){setProfile(null);setAuthError('No profile is configured for this account.');setAuthLoading(false);return;}if(!isRole(data.role)){setProfile(null);setAuthError('Your profile has an unsupported role.');setAuthLoading(false);return;}setProfile({userId:session.user.id,email:session.user.email??'',role:data.role,customerId:data.customer_id??null});setAuthLoading(false);}catch(error){if(!active||currentRequest!==request)return;setProfile(null);setAuthError(error instanceof Error?`Unable to load your profile: ${error.message}`:'Unable to load your profile.');setAuthLoading(false);}};const {data:{subscription}}=supabase.auth.onAuthStateChange((_event,session)=>{window.setTimeout(()=>{if(active)void loadProfile(session);},0);});void supabase.auth.getSession().then(({data,error})=>{if(!active)return;if(error){setAuthError(`Unable to restore your session: ${error.message}`);setAuthLoading(false);return;}void loadProfile(data.session);}).catch(error=>{if(!active)return;setAuthError(error instanceof Error?`Unable to restore your session: ${error.message}`:'Unable to restore your session.');setAuthLoading(false);});return()=>{active=false;request++;subscription.unsubscribe();};},[]);
 const signIn=async(email:string,password:string)=>{setAuthError('');try{const {error}=await supabase.auth.signInWithPassword({email,password});if(error)setAuthError(error.message);}catch(error){setAuthError(error instanceof Error?error.message:'Unable to sign in. Please try again.');}};
 const signOut=async()=>{try{const {error}=await supabase.auth.signOut();if(error)flash(`Unable to sign out: ${error.message}`);}catch(error){flash(error instanceof Error?`Unable to sign out: ${error.message}`:'Unable to sign out. Please try again.');}};
 if(authLoading)return <div className="login-screen"><div className="login-panel">Restoring your session…</div></div>;
 if(!profile||!role)return <Login onLogin={signIn} error={authError}/>;
 if(role==='Customer')return <><CustomerStorefront userId={profile.userId} state={state} onCommit={mutate} flash={flash} onSignOut={signOut}/>{toast&&<div className="toast"><Check size={17}/>{toast}<button onClick={()=>setToast('')}><X size={14}/></button></div>}</>;
 const canOpen=(p:Page)=>role==='Manager'||['Dashboard','POS','Sales Orders','Returns','Inventory','Barcode Labels','Help & Support'].includes(p);const helpNavigate=(p:string)=>{if(canOpen(p as Page))navigatePage(p as Page);};
 return <div className="app-shell">
  <aside ref={navigationRef} id="workspace-navigation" aria-label="Workspace navigation" className={`sidebar ${navExpanded?'':'collapsed'}`} onPointerEnter={e=>{if(e.pointerType==='mouse'&&window.matchMedia('(hover: hover)').matches)setNavHovered(true);}} onPointerLeave={()=>setNavHovered(false)} onFocus={()=>setNavFocused(true)} onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget))setNavFocused(false);}}>
   <div className="brand"><button type="button" className="brand-mark brand-home" aria-label="Go to dashboard" title="Dashboard" onClick={()=>navigatePage('Dashboard')}><img src={zaLogo} alt="Za by Zach" className="logo-img"/></button><div className="brand-copy"><b>Za by Zach</b><small>OPERATIONS SUITE</small></div><button className="collapse-btn" tabIndex={navExpanded?0:-1} onClick={()=>{setCollapsed(true);setNavHovered(false);setNavFocused(false);menuToggleRef.current?.focus({preventScroll:true});}} aria-label="Collapse navigation" title="Collapse navigation" aria-expanded={navExpanded} aria-controls="workspace-navigation"><X size={17}/></button></div>
   <div className="workspace-pill"><span className="live-dot"/> <span className="workspace-name">Za by Zach · LIVE DEMO</span><ChevronDown size={13}/></div>
   <nav>{groups.filter(([,links])=>links.some(({label})=>canOpen(label))).map(([group,links])=><div className="nav-group" key={group}><div className="nav-label">{group}</div>{links.filter(({label})=>canOpen(label)).map(({label,icon:Icon})=><button key={label} className={`nav-link ${page===label?'active':''}`} onClick={()=>navigatePage(label)} aria-label={label} title={navExpanded?undefined:label} aria-current={page===label?'page':undefined}><Icon size={17}/><span className="nav-link-text">{label}</span>{label==='MRP'&&mrpActionCount>0&&<i className="nav-count">{mrpActionCount}</i>}</button>)}</div>)}</nav>
   <div className="sidebar-bottom"><div className="sync-card"><div className="sync-icon"><Activity size={15}/></div><div><b>Shared workspace</b><span>Supabase records</span></div><span className="sync-status"/></div><div className="sidebar-foot"><span>Build 1.0.0</span><span>·</span><span>ERP demo</span></div></div>
  </aside>
  {!collapsed&&<button className="nav-scrim" onClick={()=>setCollapsed(true)} aria-label="Close navigation menu"/>}
  <main className="main-area" inert={!collapsed}>
   <header className="topbar"><div className="topbar-navigation"><button ref={menuToggleRef} className="nav-menu-button" onClick={()=>setCollapsed(!collapsed)} aria-label={collapsed?"Open navigation menu":"Collapse navigation menu"} aria-expanded={navExpanded} aria-controls="workspace-navigation"><Menu size={19}/><span>Menu</span></button><button type="button" className="nav-menu-button page-back-button" onClick={goBack} aria-label="Go back to previous page" title="Back"><ArrowLeft size={17}/><span>Back</span></button><div className="crumb">Za by Zach <span>/</span> <b>{page}</b></div></div><div className="top-actions">{page!=='Inventory'&&<div className="global-search" style={{position:'relative'}}><Search size={15}/><input ref={globalSearchRef} aria-label="Search pages or inventory" placeholder="Search pages or inventory…" value={search} onFocus={()=>setSearchOpen(true)} onBlur={()=>window.setTimeout(()=>setSearchOpen(false),150)} onChange={e=>{setSearch(e.target.value);setSearchOpen(true);}} onKeyDown={e=>{if(e.key==='Escape')setSearchOpen(false);if(e.key==='Enter'&&search.trim()){e.preventDefault();const match=groups.flatMap(([,links])=>links).find(l=>canOpen(l.label)&&l.label.toLowerCase()===search.trim().toLowerCase());if(match){setSearch('');navigatePage(match.label);}else navigatePage('Inventory');setSearchOpen(false);}}}/><kbd>⌘ K</kbd>{searchOpen&&search.trim()&&<div className="panel" aria-label="Search results" style={{position:'absolute',top:'100%',left:0,right:0,zIndex:100,padding:12}}>{groups.flatMap(([,links])=>links).filter(l=>canOpen(l.label)&&l.label.toLowerCase().includes(search.trim().toLowerCase())).map(l=><button key={l.label} className="table-action full" onMouseDown={e=>e.preventDefault()} onClick={()=>{navigatePage(l.label);setSearch('');setSearchOpen(false);}}>{l.label}</button>)}<button className="table-action full" onMouseDown={e=>e.preventDefault()} onClick={()=>{navigatePage('Inventory');setSearchOpen(false);}}>Search inventory for “{search.trim()}”</button></div>}</div>}<button className="icon-button" aria-label="Notifications" onClick={()=>flash('You’re all caught up.')}><Bell size={17}/><i/></button><div className="top-divider"/><button className="user-menu" onClick={signOut}><span className="avatar" style={{overflow:'hidden',background:'transparent'}}><img src={avatarImg} alt="" style={{width:'100%',height:'100%',objectFit:'cover',display:'block'}}/></span><span className="user-text"><b>{role}</b><small>{login}</small></span><LogOut size={15}/></button></div></header>
   <div className="page-wrap">{page!=='Inventory'&&page!=='Sales Orders'&&<div className="page-top"><div><div className="eyebrow">Za by Zach <span>·</span> {page==='Dashboard'?new Date(today()+'T12:00:00').toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'}).toUpperCase():page.toUpperCase()}</div><h1>{page==='Dashboard'?'Good morning, '+((profile.email.split('@')[0]||role).replace(/[._-]+/g,' ').replace(/\b\w/g,c=>c.toUpperCase())):page}</h1><p>{pageDescription(page)}</p></div>{page==='Dashboard'&&<div className="page-top-actions"><LocationSelect value={location} onChange={setLocation}/><button className="button primary" onClick={()=>navigatePage('POS')}><Plus size={16}/> New sale</button></div>}</div>}
    {page==='Dashboard'&&<SharedDashboard role={role} location={location} setPage={navigatePage}/>}
    {page==='POS'&&<POSView state={state} location={location} setLocation={setLocation} onCommit={mutate} flash={flash}/>}
    {page==='Sales Orders'&&<SalesOrdersTabs flash={flash} onStartReturn={id=>{setReturnSaleId(id);navigatePage('Returns');}}/>}
    {page==='Returns'&&<ReturnsPageView flash={flash} initialSaleId={returnSaleId} onInitialSaleUsed={()=>setReturnSaleId(null)}/>}
    {page==='Inventory'&&<ConnectedInventoryPage userId={profile.userId} canManage={role==='Manager'} search={search} onSearchChange={setSearch} flash={flash} safetyDays={state.settings.safetyDays} onOpenLabels={()=>navigatePage('Barcode Labels')}/>}
    {page==='Barcode Labels'&&<ConnectedBarcodeLabels state={state} flash={flash} onReceive={role==='Manager'?code=>{setReceivingCode(code);navigatePage('Purchase Orders');}:undefined}/>}
    {page==='Transfers & Counts'&&<ConnectedMovements userId={profile.userId} flash={flash}/>}
    {page==='Production'&&<ConnectedProductionPage userId={profile.userId} flash={flash}/>}
    {role==='Manager'&&page==='Suppliers'&&<SharedPurchasingScreen view="Suppliers" flash={flash}/> }
    {role==='Manager'&&page==='Inventory Review'&&<SharedPurchasingScreen view="Inventory Review" flash={flash} onOpenSettings={()=>navigatePage('Settings')}/> }
    {page==='Help & Support'&&<HelpSupportScreen role={role} onNavigate={helpNavigate}/> }
    {role==='Manager'&&page==='Purchase Orders'&&<SharedPurchasingScreen view="Purchase Orders" flash={flash} onOpenInventory={()=>navigatePage('Inventory')} onOpenFinancials={()=>navigatePage('Financials')} initialScan={receivingCode} onScanHandled={()=>setReceivingCode('')} onOpenLabels={()=>navigatePage('Barcode Labels')}/>}
    {role==='Manager'&&page==='Supplier Scorecards'&&<SharedPurchasingScreen view="Supplier Scorecards" flash={flash}/>}
    {page==='MRP'&&<SharedMrpScreen flash={flash} onPurchase={()=>navigatePage('Purchase Orders')} onTransfers={()=>navigatePage('Transfers & Counts')} onProduction={()=>navigatePage('Production')} onOrders={()=>navigatePage('Sales Orders')} onSuppliers={()=>navigatePage('Suppliers')}/>}
    {role==='Manager'&&page==='Financials'&&<><SharedReporting view="financials"/><SharedPurchasingScreen view="Payables" flash={flash}/></>}
    {role==='Manager'&&page==='Reports'&&<SharedReporting view="reports"/>}
    {page==='Settings'&&<SettingsPageView state={state} onCommit={mutate} flash={flash} userId={profile.userId} canManage={role==='Manager'}/>}
    {page==='About'&&<AboutView state={state} onCommit={mutate} flash={flash} role={role}/>}
   </div>
  </main><PizzaGuide state={state} role={role} onNavigate={helpNavigate}/>{toast&&<div className="toast"><Check size={17}/>{toast}<button onClick={()=>setToast('')}><X size={14}/></button></div>}
 </div>;
}
type WelcomePrize={label:string;short:string;discountPct?:number;discountAmount?:number;redeemed?:boolean};
function stockBadge(status:CustomerStockStatus){return <span className={'customer-stock-badge '+(status==='Available'?'is-available':status==='Low stock'?'is-low':'is-unavailable')}>{status}</span>;}
const welcomePrizeOptions:WelcomePrize[]=[{label:'5% off',short:'5%',discountPct:5},{label:'8% off',short:'8%',discountPct:8},{label:'10% off',short:'10%',discountPct:10},{label:'12% off',short:'12%',discountPct:12},{label:'15% off',short:'15%',discountPct:15},{label:'18% off',short:'18%',discountPct:18},{label:'20% off',short:'20%',discountPct:20},{label:'25% off',short:'25%',discountPct:25},{label:'$2 off',short:'$2',discountAmount:2},{label:'$3 off',short:'$3',discountAmount:3}];
const welcomePrizeKey='zbyZach-welcome-prize-v1:demo-customer';
const welcomeSeenKey='zbyZach-welcome-popup-seen-v1:demo-customer';
function loadWelcomePrize():WelcomePrize|null{try{return JSON.parse(localStorage.getItem(welcomePrizeKey)||'null') as WelcomePrize|null;}catch{return null;}}
function CustomerStorefront({userId,state,onCommit,flash,onSignOut}:{userId:string;state:AppState;onCommit:(s:AppState)=>void;flash:(m:string)=>void;onSignOut:()=>void}){
 const [cart,setCart]=useState<{sku:string;qty:number}[]>([]);
 const rewards=useCustomerRewards(userId);const [redeemRewards,setRedeemRewards]=useState(false);
 useEffect(()=>{setRedeemRewards(false);},[userId]);
 const [replacementChoices,setReplacementChoices]=useState<Record<string,Record<string,string>>>({});
 const [replacementPopupOpen,setReplacementPopupOpen]=useState(false);
 const [pendingPizzaSku,setPendingPizzaSku]=useState<string|null>(null);
 const [location,setLocation]=useState<Location>('Provo Campus Store');
 const [fulfillment,setFulfillment]=useState<FulfillmentType>('pickup');
 const [deliveryAddress,setDeliveryAddress]=useState<DeliveryAddress>({street:'',unit:'',city:'',state:'UT',postalCode:''});
 const [deliveryQuote,setDeliveryQuote]=useState<DeliveryQuote|null>(null);
 const [deliveryLoading,setDeliveryLoading]=useState(false);const [deliveryError,setDeliveryError]=useState('');
 const [storeInfoOpen,setStoreInfoOpen]=useState(false);
 const [pickupLocations,setPickupLocations]=useState<string[]>([]);
 const [pickupLocationError,setPickupLocationError]=useState('');
 const [availability,setAvailability]=useState<CustomerAvailability|null>(null);
 const [availabilityState,setAvailabilityState]=useState<'loading'|'refreshing'|'ready'|'error'>('loading');
 const [availabilityError,setAvailabilityError]=useState('');
 const [cartAvailabilityError,setCartAvailabilityError]=useState('');
 const availabilityRequest=useRef(0);
 const hasAvailabilitySnapshot=useRef(false);
 const [pickup,setPickup]=useState(businessDate(new Date(Date.now()+86400000)));
 const [requestedPickupTime,setPickupTime]=useState('17:00');const [checkoutError,setCheckoutError]=useState('');
 const [confirmed,setConfirmed]=useState<SharedOrderConfirmation|null>(null);const [stockPopup,setStockPopup]=useState<string|null>(null);
 const [checkoutPage,setCheckoutPage]=useState<'menu'|'checkout'|'confirmation'>('menu');
 const navigateCheckout=(page:'menu'|'checkout'|'confirmation')=>{setCheckoutPage(page);try{window.history.pushState(null,'',page==='menu'?'#menu':page==='checkout'?'#checkout':'#order-confirmation');}catch{}window.scrollTo(0,0);};
 useEffect(()=>{const back=()=>{if(window.location.hash==='#checkout'&&cart.length)setCheckoutPage('checkout');else if(window.location.hash==='#order-confirmation'&&confirmed)setCheckoutPage('confirmation');else setCheckoutPage('menu');};window.addEventListener('popstate',back);return()=>window.removeEventListener('popstate',back);},[cart.length,confirmed]);
 const refreshAvailability=useCallback(async(requestedLocation:string)=>{
  const request=++availabilityRequest.current;
  setAvailabilityState(hasAvailabilitySnapshot.current?'refreshing':'loading');setAvailabilityError('');
  try{
   const {data,error}=await supabase.rpc('erp_customer_availability',{p_location_name:requestedLocation});
   if(error)throw error;
   if(!isCustomerAvailability(data))throw new Error('The availability response could not be verified.');
   if(request!==availabilityRequest.current)return;
   setAvailability(data);hasAvailabilitySnapshot.current=true;setAvailabilityState('ready');setAvailabilityError('');
  }catch(error){
   if(request!==availabilityRequest.current)return;
   setAvailabilityState('error');setAvailabilityError(error instanceof Error?error.message:'Availability could not be refreshed.');
  }
 },[]);
 const loadPickupLocations=useCallback(async()=>{
  try{
   const {data,error}=await supabase.rpc('erp_customer_pickup_locations',{});
   if(error)throw error;
   if(!Array.isArray(data))throw new Error('Pickup stores are unavailable.');
   const names=(data as unknown[]).flatMap(row=>row&&typeof row==='object'&&typeof (row as Record<string,unknown>).name==='string'?[(row as {name:string}).name]:[]);
   if(!names.length)throw new Error('No pickup stores are currently available.');
   setPickupLocations(names);setPickupLocationError('');
   setLocation(current=>(names.includes(current)?current:(names.includes('Provo Campus Store')?'Provo Campus Store':names[0])) as Location);
  }catch(error){setPickupLocations([]);setPickupLocationError(error instanceof Error?error.message:'Pickup stores could not be loaded.');}
 },[]);
 useEffect(()=>{void loadPickupLocations();},[loadPickupLocations,userId]);
 useEffect(()=>{void refreshAvailability(location);return()=>{availabilityRequest.current++;};},[location,refreshAvailability]);
 useEffect(()=>{
  const refreshWhenVisible=()=>{if(document.visibilityState==='visible')void refreshAvailability(location);};
  const timer=window.setInterval(refreshWhenVisible,15000);
  document.addEventListener('visibilitychange',refreshWhenVisible);
  window.addEventListener('pageshow',refreshWhenVisible);
  return()=>{window.clearInterval(timer);document.removeEventListener('visibilitychange',refreshWhenVisible);window.removeEventListener('pageshow',refreshWhenVisible);};
 },[location,refreshAvailability]);
 const savedPrize=loadWelcomePrize();
 const [prize,setPrize]=useState<WelcomePrize|null>(savedPrize);
 const [showWheel,setShowWheel]=useState(()=>!savedPrize&&!localStorage.getItem(welcomeSeenKey));
 const [spinning,setSpinning]=useState(false);
 const [rotation,setRotation]=useState(0);
 const menu=items.filter(i=>i.price>0&&i.category==='Pizza');
 const extras=items.filter(i=>i.price>0&&(i.category==='Sides'||i.category==='Beverage'));
 const count=cart.reduce((n,l)=>n+l.qty,0);
 const subtotal=cart.reduce((n,l)=>n+itm(l.sku).price*l.qty,0);
 const activePrize=prize&&!prize.redeemed?prize:null;
 const welcomeDiscount=Math.min(subtotal,subtotal*(activePrize?.discountPct||0)/100+(activePrize?.discountAmount||0));
 const rewardDiscount=fulfillment==='pickup'&&redeemRewards?5:0;
 const discount=Math.min(subtotal,welcomeDiscount+rewardDiscount);
 const tax=(subtotal-discount)*state.settings.tax;
 const deliveryFee=fulfillment==='delivery'?(deliveryQuote?.fee??0):0;
 const total=subtotal-discount+tax+deliveryFee;
 const {minDate:minPickupDate,options:pickupOptions}=pickupSchedule(pickup);const pickupTime=pickupOptions.includes(requestedPickupTime)?requestedPickupTime:(pickupOptions[0]??'');
 const productBySku=new Map<string,CustomerAvailability['products'][number]>((availability?.location===location?availability.products:[]).map(product=>[product.sku,product] as const));
 const replacementLines=cart.map(line=>({...line,substitutions:replacementChoices[line.sku]??{}}));
 const cartPlan=availability?.location===location?customerCartPlan(replacementLines,availability.products,location,sku=>itm(sku)?.name??sku):{hardIssue:'Current availability is not confirmed. Refresh stock before checking out.',shortages:[]};
 const cartConflict=cartPlan.hardIssue;
 const pendingPizzaCart=pendingPizzaSku?(cart.some(line=>line.sku===pendingPizzaSku)?cart.map(line=>line.sku===pendingPizzaSku?{...line,qty:line.qty+1}:line):[...cart,{sku:pendingPizzaSku,qty:1}]):cart;
 const replacementPopupPlan= pendingPizzaSku&&availability?.location===location
  ?customerCartPlan(pendingPizzaCart.map(line=>({...line,substitutions:replacementChoices[line.sku]??{}})),availability.products,location,sku=>itm(sku)?.name??sku)
  :cartPlan;
 const keepChoicesFor=(lines:{sku:string;qty:number}[])=>setReplacementChoices(previous=>Object.fromEntries(Object.entries(previous).filter(([sku])=>lines.some(line=>line.sku===sku))));
 const changeQty=(sku:string,by:number)=>{
  if(by>0&&(availabilityState==='loading'||availabilityState==='error'||!availability||availability.location!==location)){
   setCartAvailabilityError('Current shared stock could not be confirmed. Refresh availability before adding items.');return;
  }
  const found=cart.find(x=>x.sku===sku);const next=found?cart.map(x=>x.sku===sku?{...x,qty:x.qty+by}:x).filter(x=>x.qty>0):by>0?[...cart,{sku,qty:1}]:cart;
  if(by>0){const issue=customerCartPlan(next.map(line=>({...line,substitutions:replacementChoices[line.sku]??{}})),availability!.products,location,code=>itm(code)?.name??code).hardIssue;if(issue){setCartAvailabilityError(issue);return;}}
  setCartAvailabilityError('');setCheckoutError('');setDeliveryQuote(null);setDeliveryError('');keepChoicesFor(next);setCart(next);
 };
 const addPizzaToOrder=(sku:string)=>{
  if(availabilityState==='loading'||availabilityState==='error'||!availability||availability.location!==location){setCartAvailabilityError('Current shared stock could not be confirmed. Refresh availability before adding a pizza.');return;}
  const found=cart.find(line=>line.sku===sku);
  const next=found?cart.map(line=>line.sku===sku?{...line,qty:line.qty+1}:line):[...cart,{sku,qty:1}];
  const plan=customerCartPlan(next.map(line=>({...line,substitutions:replacementChoices[line.sku]??{}})),availability.products,location,code=>itm(code)?.name??code);
  if(plan.hardIssue){setCartAvailabilityError(plan.hardIssue);return;}
  if(plan.shortages.length){setPendingPizzaSku(sku);setCheckoutError('');setReplacementPopupOpen(true);return;}
  changeQty(sku,1);
 };
 const setCartQty=(sku:string,value:number)=>{
  const current=cart.find(line=>line.sku===sku);if(!current)return;
  const quantity=Number.isFinite(value)?Math.max(1,Math.min(99,Math.trunc(value)||1)):1;
  const next=cart.map(line=>line.sku===sku?{...line,qty:quantity}:line);
  if(quantity>current.qty){
   if(availabilityState==='loading'||availabilityState==='error'||!availability||availability.location!==location){setCartAvailabilityError('Current shared stock could not be confirmed. Refresh availability before increasing this item.');return;}
   const issue=customerCartPlan(next.map(line=>({...line,substitutions:replacementChoices[line.sku]??{}})),availability!.products,location,code=>itm(code)?.name??code).hardIssue;if(issue){setCartAvailabilityError(issue);return;}
  }
  setCartAvailabilityError('');setCheckoutError('');setDeliveryQuote(null);setDeliveryError('');keepChoicesFor(next);setCart(next);
 };


 const spinWheel=()=>{if(spinning||prize)return;const index=Math.floor(Math.random()*welcomePrizeOptions.length);const reward=welcomePrizeOptions[index];const normalized=((rotation%360)+360)%360;const delta=(360-((index*36+18+normalized)%360))%360;setSpinning(true);setRotation(rotation+2160+delta);window.setTimeout(()=>{setPrize(reward);setSpinning(false);try{localStorage.setItem(welcomePrizeKey,JSON.stringify(reward));localStorage.setItem(welcomeSeenKey,'true');}catch{}flash('You won '+reward.label+' for your first order!');},4200);};
 const closeWheel=()=>{setShowWheel(false);try{localStorage.setItem(welcomeSeenKey,'true');}catch{}};
 const estimateDelivery=async()=>{
  const address=formatDeliveryAddress(deliveryAddress);
  if(!cart.length){setDeliveryError('Add items to your order first.');return;}
  if(deliveryAddress.street.trim().length<4||deliveryAddress.city.trim().length<2||deliveryAddress.state.trim().length<2||!/^[0-9]{5}(?:-[0-9]{4})?$/.test(deliveryAddress.postalCode.trim())){setDeliveryError('Enter the street, city, state, and five-digit ZIP code.');return;}
  setDeliveryLoading(true);setDeliveryQuote(null);setDeliveryError('');
  try{
   const [route,load]=await Promise.all([
    supabase.functions.invoke('delivery-estimate',{body:{location,address}}),
    supabase.rpc('erp_customer_delivery_load',{p_location_name:location}),
   ]);
   if(route.error)throw Error(route.error.message||'Route estimate is unavailable.');
   if(load.error)throw Error(load.error.message||'Store workload could not be checked.');
   const routeData=route.data as {oneWayMinutes?:number;distanceMiles?:number;error?:string};
   const loadData=load.data as {pendingOrders?:number};
   if(routeData.error)throw Error(routeData.error);
   if(!Number.isFinite(routeData.oneWayMinutes)||!Number.isFinite(routeData.distanceMiles)||!Number.isFinite(loadData?.pendingOrders))throw Error('The estimate response could not be verified.');
   const pizzaCount=cart.reduce((sum,line)=>sum+(itm(line.sku).category==='Pizza'?line.qty:0),0);
   const otherItemCount=cart.reduce((sum,line)=>sum+(itm(line.sku).category==='Pizza'?0:line.qty),0);
  setDeliveryQuote(buildDeliveryQuote({
  oneWayMin: routeData.oneWayMinutes!,
  oneWayMax: routeData.oneWayMinutes!,
  distanceMiles: routeData.distanceMiles!,
  pendingOrders: loadData.pendingOrders!,
  pizzaCount,
  otherItemCount,
}));   } catch (error) {
    setDeliveryQuote(null);
    setDeliveryError(
      error instanceof Error
        ? error.message
        : 'We could not calculate delivery. Check the address and retry.'
    );
  } finally {
    setDeliveryLoading(false);
  }
};
 const continueCheckout=()=>{setCheckoutError('');try{if(!cart.length){setCheckoutError('Add a favorite to your order first.');return;}if(cartConflict){setCheckoutError(cartConflict);return;}if(fulfillment==='delivery'){if(!deliveryQuote){setCheckoutError('Enter a delivery address and calculate the fee and time first.');return;}}else{const schedule=pickupSchedule(pickup);if(!pickup||pickup<schedule.minDate||!schedule.options.includes(pickupTime)){setCheckoutError('Please choose an available pickup date and time above.');return;}}if(cartPlan.shortages.length){setReplacementPopupOpen(true);return;}navigateCheckout('checkout');}catch{setCheckoutError('We couldn’t open checkout. Please try again; your cart is still here.');}};
 const closeReplacementPopup=()=>{setReplacementPopupOpen(false);setPendingPizzaSku(null);setCheckoutError('');};
 const confirmReplacements=()=>{setCheckoutError('');const plan=replacementPopupPlan;if(plan.hardIssue){setCartAvailabilityError(plan.hardIssue);setReplacementPopupOpen(false);setPendingPizzaSku(null);return;}if(plan.shortages.length){setCheckoutError('Choose an in-stock replacement for every unavailable ingredient.');return;}setReplacementPopupOpen(false);setCartAvailabilityError('');if(pendingPizzaSku){setCartAvailabilityError('');setDeliveryQuote(null);setDeliveryError('');keepChoicesFor(pendingPizzaCart);setCart(pendingPizzaCart);setPendingPizzaSku(null);return;}navigateCheckout('checkout');};
 const placeOrder=async(orderName:string,phone:string,card:{brand:string;last4:string})=>{
  if(!cart.length)throw Error('Please review your order.');
  if(fulfillment==='delivery'&&!deliveryQuote)throw Error('Refresh your delivery estimate before placing the order.');
  if(fulfillment==='pickup'&&!pickupTime)throw Error('Please choose an available pickup time.');
  const deliveryAt=deliveryQuote?new Date(Date.now()+deliveryQuote.etaMin*60000).toISOString():null;
  const payload={...(fulfillment==='pickup'?{rewardsVersion:1,redeemRewards}:{}),name:orderName.trim(),phone:phone.trim(),location,pickup:fulfillment==='delivery'?deliveryAt!:pickup+'T'+pickupTime+':00 America/Denver',lines:cart.map(x=>({...x,substitutions:replacementChoices[x.sku]??{}})),discountPct:activePrize?.discountPct??0,discountAmount:activePrize?.discountAmount??0,fulfillmentType:fulfillment,...(fulfillment==='delivery'?{deliveryAddress:formatDeliveryAddress(deliveryAddress),deliveryFee:deliveryQuote!.fee,oneWayMinutes:deliveryQuote!.oneWayMinutes,distanceMiles:deliveryQuote!.distanceMiles,etaMin:deliveryQuote!.etaMin,etaMax:deliveryQuote!.etaMax}: {})};
  const result=await sendPlanningRequest(userId,fulfillment==='delivery'?'delivery-order':'pickup',fulfillment==='delivery'?'erp_checkout_delivery_order':'erp_checkout_order',payload,(name,args)=>supabase.rpc(fulfillment==='pickup'?customerRewardsRpc(args.p_payload):name,args),async requestId=>{const saved=await supabase.rpc('erp_save_order_card',{p_order:requestId,p_brand:card.brand,p_last4:card.last4});if(saved.error)throw Error('Your card details could not be saved: '+saved.error.message);});

  const order=sharedPickupConfirmation(payload,result);
  setConfirmed(order);setCart([]);setReplacementChoices({});setRedeemRewards(false);void rewards.refresh();setCartAvailabilityError('');void refreshAvailability(location);if(activePrize){const redeemed={...activePrize,redeemed:true};setPrize(redeemed);try{localStorage.setItem(welcomePrizeKey,JSON.stringify(redeemed));}catch{}}navigateCheckout('confirmation');
 };
 const orderTotal=(order:SalesOrder)=>{const sale=state.sales.find(s=>s.id===order.saleId);if(sale)return sale.total;if(order.payment)return order.payment.amount;const base=order.lines.reduce((n,l)=>n+itm(l.sku).price*l.qty,0);const off=Math.min(base,base*(order.discountPct||0)/100+(order.discountAmount||0));return base-off+(base-off)*state.settings.tax;};
 const confirmedSale=confirmed?state.sales.find(s=>s.id===confirmed.saleId):undefined;const confirmedAmounts=confirmed?.quotedSubtotal!==undefined?{grossSales:confirmed.quotedSubtotal,discount:confirmed.quotedDiscount??0,tax:confirmed.quotedTax??0}:confirmedSale?saleBreakdown(confirmedSale):undefined;

 const [recovering,setRecovering]=useState(false);
 const recoverPending=async(scope:'pickup'|'delivery-order')=>{if(recovering)return;setRecovering(true);try{const request=pendingPlanningRequest(userId,scope);if(!request)throw Error('No pending order remains.');const endpoint=scope==='delivery-order'?'erp_checkout_delivery_order':'erp_checkout_order';const result=await sendPlanningRequest(userId,scope,endpoint,request.payload,(name,args)=>supabase.rpc(scope==='pickup'?customerRewardsRpc(args.p_payload):name,args));setConfirmed(sharedPickupConfirmation(request.payload,result));setCart([]);setRedeemRewards(false);void rewards.refresh();navigateCheckout('confirmation');}catch(e){flash(e instanceof Error?e.message:'Unable to confirm the saved order.');}finally{setRecovering(false);}};
 const discountLabel=(x:WelcomePrize)=>x.discountPct?x.discountPct+'% off':usd(x.discountAmount||0)+' off';
 const wheelColors=['#e89a43','#dc7042','#a7b86f','#849e7b','#56838d','#b46e89','#df9264','#bc7f42','#8fa9a1','#836a83'];const wheelBackground='conic-gradient('+wheelColors.map((color,index)=>color+' '+(index*36)+'deg '+((index+1)*36)+'deg').join(',')+')';
 if(checkoutPage==='checkout'&&cart.length)return <CustomerCheckout state={state} lines={cart} substitutions={replacementChoices} location={location} fulfillment={fulfillment} deliveryAddress={deliveryAddress} deliveryQuote={deliveryQuote} pickup={pickup} pickupTime={pickupTime} subtotal={subtotal} discount={discount} welcomeDiscount={welcomeDiscount} rewardDiscount={rewardDiscount} rewardsControl={disabled=>fulfillment==='pickup'?<RewardsRedemption data={rewards.data} redeem={redeemRewards} onChange={setRedeemRewards} afterWelcome={subtotal-welcomeDiscount} disabled={disabled}/>:null} tax={tax} total={total} onBack={()=>navigateCheckout('menu')} onPay={placeOrder}/>;
 if(checkoutPage==='confirmation'&&confirmed)return <div className="customer-storefront"><main className="payment-confirmation"><span className="confirmation-check"><CheckCircle2 size={38}/></span><span className="store-kicker">THANK YOU FOR ORDERING</span><h1>{confirmed.status==='Order Placed'?'See you soon, '+confirmed.orderName+'!':confirmed.status==='Fulfilled'?'Your order has been fulfilled.':'Your order is closed.'}</h1><p>{confirmed.status==='Order Placed'?confirmed.fulfillmentType==='delivery'?'Your delivery is on its way to the address below.':'Your pickup order is ready to be picked up.':'This is the current status of your saved order.'}</p><strong className="confirmation-number">Order {confirmed.orderNumber??confirmed.id}</strong><span className="demo-paid-badge">{confirmed.status==='Order Placed'?'Order confirmed':confirmed.status} · simulated payment</span><section className="checkout-card"><h2>{confirmed.fulfillmentType==='delivery'?'Delivery details':'Pickup details'}</h2><p><b>{confirmed.location}</b></p>{confirmed.fulfillmentType==='delivery'?<><p>Deliver to: <b>{confirmed.deliveryAddress}</b></p><p>Estimated arrival: {confirmed.deliveryEtaMin}–{confirmed.deliveryEtaMax} minutes</p><p>Delivery fee: {usd(confirmed.deliveryFee??0)}</p></>:<p>{dateLabel(confirmed.pickup)} at {pickupTimeLabel(confirmed.pickupTime)}</p>}<p>Order name: <b>{confirmed.orderName}</b></p>{confirmed.customerPhone&&<p>Phone: <b>{formatCustomerPhone(confirmed.customerPhone)}</b></p>}{confirmed.pickupNumber&&<p>Pickup call: <b>#{String(confirmed.pickupNumber).padStart(3,'0')}</b></p>}{(confirmed.quotedLines??confirmedSale?.lines??confirmed.lines.map(l=>({...l,price:itm(l.sku).price}))).map((l,index)=><div className="checkout-summary-row" key={index}><span>{l.qty} × {itm(l.sku).name}</span><b>{usd(l.qty*l.price)}</b></div>)}{confirmed.lines.flatMap(line=>Object.entries(line.substitutions??{}).map(([from,to])=>({sku:line.sku,from,to}))).map((swap,index)=><div className="checkout-summary-row" key={'sub-'+index}><span>{itm(swap.sku).name}: {itm(swap.from).name} → {itm(swap.to).name} (free replacement)</span><b>$0.00</b></div>)}{confirmedAmounts&&<><div className="checkout-summary-row"><span>Subtotal</span><b>{usd(confirmedAmounts.grossSales)}</b></div>{confirmedAmounts.discount>0&&<div className="checkout-summary-row"><span>Discount</span><b>−{usd(confirmedAmounts.discount)}</b></div>}<div className="checkout-summary-row"><span>Sales tax</span><b>{usd(confirmedAmounts.tax)}</b></div></>}{confirmed.fulfillmentType==='delivery'&&<div className="checkout-summary-row"><span>Delivery fee</span><b>{usd(confirmed.deliveryFee??0)}</b></div>}<div className="checkout-summary-row"><span>Order total (tax and discounts included)</span><b>{usd(confirmed.payment?.amount??orderTotal(confirmed))}</b></div><small>Receipt: {confirmed.payment?.reference}</small></section><button className="store-checkout" onClick={()=>{setConfirmed(null);navigateCheckout('menu');}}>Back to menu</button></main></div>;
 return <div className="customer-storefront">
  <header className="store-topbar"><a className="store-brand" href="#top"><span className="store-logo"><img src={zaLogo} alt="" className="logo-img"/></span><span><b>Za by Zach</b><small>GOOD FOOD. GOOD MOOD.</small></span></a><div className="store-top-actions"><span className="store-welcome">Welcome back!</span><button className="store-info-trigger" onClick={()=>setStoreInfoOpen(true)}><MapPin size={15}/> About / Store Info</button><button className="store-account" onClick={onSignOut}><img src={avatarImg} alt="" style={{width:22,height:22,borderRadius:'50%',objectFit:'cover'}}/> My account <LogOut size={14}/></button></div></header>
  {storeInfoOpen&&<div className="delivery-info-backdrop" role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget)setStoreInfoOpen(false);}}><aside className="delivery-info-drawer" role="dialog" aria-modal="true" aria-labelledby="delivery-info-title"><button className="wheel-close" aria-label="Close store information" onClick={()=>setStoreInfoOpen(false)}><X size={18}/></button><span className="store-kicker">VISIT OR CONTACT US</span><h2 id="delivery-info-title">Store information</h2><p className="delivery-demo-note">These addresses and contact details are fictional demo information.</p>{pickupLocations.map(name=>{const store=customerStoreInfo[name as Location];return store?<section className="delivery-store-card" key={name}><h3>{name}</h3><p><MapPin size={15}/>{store.address}</p><p><UserRound size={15}/><a href={'tel:'+store.phone.replace(/[^\d+]/g,'')}>{store.phone}</a></p><p><FileText size={15}/><a href={'mailto:'+store.email}>{store.email}</a></p></section>:null;})}<button className="store-checkout" onClick={()=>setStoreInfoOpen(false)}>Back to ordering</button></aside></div>}
  <main className="store-content" id="top">
   {(hasPendingPlanningRequest(userId,'pickup')||hasPendingPlanningRequest(userId,'delivery-order'))&&<button className="store-checkout" disabled={recovering} onClick={()=>void recoverPending(hasPendingPlanningRequest(userId,'delivery-order')?'delivery-order':'pickup')}>{recovering?'Confirming saved order…':'Recover pending order confirmation'}</button>}
   <section className="store-hero store-hero-oven"><img className="store-hero-image" src={brickOvenHero} alt="A chef baking pizza in a brick oven"/><div className="store-hero-copy"><h1>Za by Zach</h1><p>Fresh made pizzas from Dr. Wright’s kitchen.</p><a href="#menu" className="store-cta">Explore the menu <ArrowUpRight size={16}/></a>{!prize&&<button className="wheel-promo-link" onClick={()=>setShowWheel(true)}><Sparkles size={14}/> Spin for a first-order treat</button>}<div className="store-perks"><span><CheckCircle2 size={15}/> Fresh from our kitchen</span><span><CheckCircle2 size={15}/> Pickup or local delivery</span></div></div></section>
   {activePrize&&<div className="reward-banner"><Sparkles size={17}/><span><b>Your welcome treat is ready: {activePrize.label}.</b> It will be applied to this order automatically.</span><button onClick={()=>setShowWheel(true)}>View prize</button></div>}
   <section className="customer-stock-panel" aria-labelledby="customer-stock-title">
   <div className="customer-pickup-select"><label htmlFor="pickup-location"><MapPin size={16}/> SELECTED STORE</label><select id="pickup-location" value={location} disabled={!pickupLocations.length} onChange={e=>{setCartAvailabilityError('');setDeliveryQuote(null);setDeliveryError('');setReplacementChoices({});setLocation(e.target.value as Location);}}>{pickupLocations.map(name=><option key={name} value={name}>{name}</option>)}</select><strong>Availability and delivery estimates use {location}.</strong></div>
    <div className="customer-stock-summary"><div className="customer-stock-summary-head"><div><span className="store-kicker">LIVE STORE AVAILABILITY</span><h2 id="customer-stock-title">Current stock at {location}</h2></div><button type="button" className="customer-stock-refresh" onClick={()=>void refreshAvailability(location)} disabled={availabilityState==='loading'}>Refresh</button></div>
     <p className="customer-stock-freshness" role="status">{availabilityState==='loading'?'Checking shared store stock…':availabilityState==='refreshing'?'Refreshing shared store stock…':availabilityState==='error'?`Couldn’t refresh stock. ${availability?'Showing the last saved update, which may be out of date.':'Availability is not confirmed yet.'}`:`Updated ${availability?.as_of?new Date(availability.as_of).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}):'recently'}. Stock refreshes about every 15 seconds while this page is visible.`}</p>
     {availabilityError&&<p className="customer-stock-error" role="alert">{availabilityError}</p>}
     {availability?.location===location&&<><h3>Pizza toppings, sauces & ingredients</h3><div className="customer-ingredient-list">{availability.ingredients.map(part=><div className="customer-ingredient" key={part.sku}><span>{part.name}</span>{stockBadge(part.status)}<small>{part.used_in?.length?`Used in ${part.used_in.join(', ')}`:'Pizza ingredient'}</small></div>)}{!availability.ingredients.length&&<p>No pizza ingredients were returned for this pickup store.</p>}</div><p className="customer-stock-rule">Low stock uses the store’s reorder point where available. If demand data is missing, the manager’s configured minimum recipe-serving or unit threshold is used.</p></>}
    {!pickupLocations.length&&<p className="customer-stock-error" role="alert">{pickupLocationError||'Pickup stores could not be loaded.'} <button type="button" className="customer-stock-refresh" onClick={()=>void loadPickupLocations()}>Retry</button></p>}
    </div>
   </section>
   <div className="store-section-heading" id="menu"><div><span className="store-kicker">THE Za by Zach MENU</span><h2>Pick your favorites</h2><p>Made to share. Or absolutely not.</p></div><span className="menu-count"><Pizza size={17}/>{menu.length} fresh favorites</span></div>
   <div className="store-order-layout"><div className="store-menu-area"><div className="customer-menu-grid">{menu.map((item,index)=>{const current=productBySku.get(item.sku);const pizzaPlan=current&&item.category==='Pizza'?customerCartPlan([{sku:item.sku,qty:1}],availability?.products??[],location,code=>itm(code)?.name??code):null;const doughIssue=pizzaPlan?.hardIssue??null;const missingTopping=item.category==='Pizza'&&!!current?.components.some(component=>component.category==='Ingredient'&&component.sku!=='1030'&&component.status==='Unavailable');const disabled=availabilityState==='loading'||availabilityState==='error'||!current||(item.category==='Pizza'?!!doughIssue:current.status==='Unavailable');return <article className={'customer-menu-card menu-card-'+(index%4)} key={item.sku}><div className="menu-card-art" style={{overflow:'hidden'}}>{pizzaImages[item.sku]&&<img src={pizzaImages[item.sku]} alt={item.name} style={{position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'cover'}}/>}<span style={pizzaImages[item.sku]?{display:'none'}:undefined}>{['🍕','🍕','🍍','🍕','🥬','🍗'][index%6]}</span><i className="menu-card-stamp">ZA<br/>FAVE</i></div><div className="menu-card-body"><div className="menu-card-title"><h3>{item.name.replace('Large ','')}</h3><b>{usd(item.price)}</b></div><p>{['A classic, melty and made for any mood.','Loaded with savory pepperoni and bubbling cheese.','Sweet pineapple meets savory ham. A fan favorite.','A little bit of everything, all on one pie.','Garden fresh, colorful, and full of flavor.','Smoky BBQ, tender chicken, and a sweet kick.'][index%6]}</p><div className="customer-product-availability">{item.category==='Pizza'?(missingTopping?<span className="customer-stock-badge is-missing-topping">Missing topping</span>:null):current?stockBadge(current.status):<span className="customer-stock-badge is-checking">Checking stock</span>}</div><button className="add-menu-button" disabled={disabled} onClick={()=>item.category==='Pizza'?addPizzaToOrder(item.sku):changeQty(item.sku,1)}>{item.category==='Pizza'&&doughIssue?(doughIssue.toLowerCase().includes('dough')?'Dough unavailable':'Temporarily unavailable'):item.category!=='Pizza'&&current?.status==='Unavailable'?'Currently unavailable':<><Plus size={16}/> Add to order</>}</button></div></article>;})}</div>
    <section className="extras-section"><div className="extras-heading"><span className="extras-spark"><Sparkles size={17}/></span><div><h2>Make it a little extra</h2><p>Choose a side, a dipping sauce, or a Coca-Cola can.</p></div></div>{['Sides','Beverage'].map(category=><div className="store-extra-group" key={category}><h3>{category==='Beverage'?'Coca-Cola cans · 12 oz':'Sides & dipping sauces'}</h3><div className="extras-grid">{extras.filter(i=>i.category===category).map(item=>{const current=productBySku.get(item.sku);const disabled=availabilityState==='loading'||availabilityState==='error'||!current||current.status==='Unavailable';return <article className="extra-card" key={item.sku}><span className="extra-emoji">{pizzaImages[item.sku]?<img src={pizzaImages[item.sku]} alt="" style={{width:'100%',height:'100%',objectFit:'cover',borderRadius:8,display:'block'}}/>:category==='Beverage'?'🥤':item.sku==='2007'?'🥖':'🥣'}</span><div><b>{item.name.replace(/ \([^)]*\)/,'')}</b><small>{category==='Beverage'?'Chilled 12 oz can':item.sku==='2007'?'Golden, buttery and shareable':'A little extra flavor on the side'}</small>{current&&stockBadge(current.status)}</div><b className="extra-price">{usd(item.price)}</b><button className="extra-add" disabled={disabled} onClick={()=>changeQty(item.sku,1)} aria-label={(current?.status==='Unavailable'?'Unavailable: ':'Add ')+item.name}>{current?.status==='Unavailable'?<X size={15}/>:<Plus size={16}/>}</button></article>;})}</div></div>)}</section>
   </div><aside className="store-cart-panel"><div className="store-cart-heading"><div><span className="store-kicker">ORDER FROM {location.toUpperCase()}</span><h2>Your order <span>{count}</span></h2></div><ShoppingCart size={20}/></div><div className="fulfillment-choice" role="group" aria-label="Choose pickup or delivery"><button type="button" className={fulfillment==='pickup'?'active':''} aria-pressed={fulfillment==='pickup'} onClick={()=>{setFulfillment('pickup');setDeliveryQuote(null);setDeliveryError('');setCheckoutError('');}}>Pickup</button><button type="button" className={fulfillment==='delivery'?'active':''} aria-pressed={fulfillment==='delivery'} onClick={()=>{setFulfillment('delivery');setDeliveryQuote(null);setDeliveryError('');setCheckoutError('');}}>Delivery</button></div>{fulfillment==='pickup'?<div className="pickup-choice"><label htmlFor="pickup-date"><CalendarClock size={15}/> PICKUP DATE</label><input id="pickup-date" type="date" min={minPickupDate} value={pickup} onChange={e=>{setPickup(e.target.value);setCheckoutError('');}}/><label htmlFor="pickup-time"><Clock3 size={15}/> PICKUP TIME</label><select id="pickup-time" value={pickupTime} onChange={e=>{setPickupTime(e.target.value);setCheckoutError('');}}>{pickupOptions.map(t=><option key={t} value={t}>{pickupTimeLabel(t)}</option>)}</select></div>:<section className="delivery-fields"><span className="store-kicker">DELIVER TO</span><label htmlFor="delivery-street">Street address</label><input id="delivery-street" autoComplete="street-address" maxLength={120} value={deliveryAddress.street} onChange={e=>{setDeliveryAddress(a=>({...a,street:e.target.value}));setDeliveryQuote(null);setDeliveryError('');}} placeholder="123 Main Street"/><label htmlFor="delivery-unit">Apartment or unit <span className="checkout-optional">Optional</span></label><input id="delivery-unit" maxLength={40} value={deliveryAddress.unit} onChange={e=>{setDeliveryAddress(a=>({...a,unit:e.target.value}));setDeliveryQuote(null);setDeliveryError('');}} placeholder="Apt 4B"/><div className="delivery-address-row"><div><label htmlFor="delivery-city">City</label><input id="delivery-city" autoComplete="address-level2" maxLength={60} value={deliveryAddress.city} onChange={e=>{setDeliveryAddress(a=>({...a,city:e.target.value}));setDeliveryQuote(null);setDeliveryError('');}} placeholder="Provo"/></div><div><label htmlFor="delivery-state">State</label><input id="delivery-state" autoComplete="address-level1" maxLength={2} value={deliveryAddress.state} onChange={e=>{setDeliveryAddress(a=>({...a,state:e.target.value.toUpperCase()}));setDeliveryQuote(null);setDeliveryError('');}} placeholder="UT"/></div><div><label htmlFor="delivery-zip">ZIP</label><input id="delivery-zip" autoComplete="postal-code" inputMode="numeric" maxLength={10} value={deliveryAddress.postalCode} onChange={e=>{setDeliveryAddress(a=>({...a,postalCode:e.target.value}));setDeliveryQuote(null);setDeliveryError('');}} placeholder="84601"/></div></div><button type="button" className="delivery-estimate-button" onClick={()=>void estimateDelivery()} disabled={deliveryLoading||!cart.length}>{deliveryLoading?'Calculating…':'Estimate time & fee'}</button>{deliveryError&&<p className="checkout-error" role="alert">{deliveryError}</p>}{deliveryQuote&&<div className="delivery-quote" role="status"><b>Estimated arrival: {deliveryQuote.etaMin}–{deliveryQuote.etaMax} minutes</b><span>{deliveryQuote.distanceMiles} road miles · {deliveryQuote.oneWayMinutes} min each way</span><span>Round-trip delivery: {deliveryQuote.roundTripMinutes} min × $0.50 = <strong>{usd(deliveryQuote.fee)}</strong></span></div>}<p className="delivery-privacy-note">Delivery is limited to {deliveryLimitMinutes} minutes each way. Your address is sent to Google to calculate the driving estimate.</p></section>}
    {cart.length?<div className="store-cart-items">{cart.map(line=>{const item=itm(line.sku);return <div className="store-cart-row" key={line.sku}><span className="cart-item-emoji">{pizzaImages[item.sku]?<img src={pizzaImages[item.sku]} alt="" style={{width:34,height:34,borderRadius:8,objectFit:'cover',display:'block'}}/>:item.category==='Pizza'?'🍕':item.category==='Beverage'?'🥤':item.sku==='2007'?'🥖':'🥣'}</span><div className="cart-item-name"><b>{item.name.replace('Large ','')}</b><small>{usd(item.price)} each</small><div className="quantity-control"><button onClick={()=>changeQty(line.sku,-1)} aria-label={'Remove one '+item.name}><Minus size={12}/></button><NumberInput aria-label={'Quantity of '+item.name} type="number" min="1" max="99" step="1" value={line.qty} onChange={e=>setCartQty(line.sku,Number(e.target.value))}/><button onClick={()=>changeQty(line.sku,1)} aria-label={'Add one '+item.name}><Plus size={12}/></button></div></div><b className="cart-item-total">{usd(item.price*line.qty)}</b></div>;})}</div>:<div className="store-cart-empty"><span>🧀</span><b>Your order starts here</b><p>Add a pizza or a little extra and we’ll save it right here.</p></div>}
    <div className="store-cart-totals"><div><span>Subtotal</span><b>{usd(subtotal)}</b></div>{activePrize&&<div className="discount-line"><span>Welcome treat · {discountLabel(activePrize)}</span><b>−{usd(discount)}</b></div>}<div><span>Estimated tax</span><b>{usd(tax)}</b></div>{fulfillment==='delivery'&&<div><span>Delivery fee</span><b>{deliveryQuote?usd(deliveryFee):'Calculate first'}</b></div>}<div className="store-total"><span>Total</span><b>{usd(total)}</b></div></div>{cartAvailabilityError&&<p className="checkout-error" role="alert">{cartAvailabilityError}</p>}{cartConflict&&<p className="checkout-error" role="alert">{cartConflict}</p>}{checkoutError&&<p className="checkout-error" role="alert">{checkoutError}</p>}<button className="store-checkout" disabled={!cart.length||!!cartConflict||(fulfillment==='delivery'&&!deliveryQuote)||hasPendingPlanningRequest(userId,fulfillment==='delivery'?'delivery-order':'pickup')} onClick={continueCheckout}>{fulfillment==='delivery'?'Continue to delivery checkout':'Continue to pickup checkout'} <ArrowUpRight size={17}/></button><p className="checkout-note"><CheckCircle2 size={13}/>{fulfillment==='delivery'&&deliveryQuote?`Estimated delivery in ${deliveryQuote.etaMin}–${deliveryQuote.etaMax} minutes. Stock is checked again when you place the order.`:`Pickup at ${pickupTimeLabel(pickupTime)} on ${dateLabel(pickup)}. Stock is checked again when you place the order.`}</p></aside></div>

  </main><footer className="store-footer"><a className="store-brand" href="#top"><span className="store-logo"><img src={zaLogo} alt="" className="logo-img"/></span><span><b>Za by Zach</b><small>GOOD FOOD. GOOD MOOD.</small></span></a><span>Thanks for making us part of your day. 🍕</span><span>Freshly made in Utah</span></footer>
  {showWheel&&<div className="wheel-backdrop" role="dialog" aria-modal="true" aria-labelledby="welcome-wheel-title"><div className="wheel-modal"><button className="wheel-close" onClick={closeWheel} aria-label="Close discount wheel"><X size={18}/></button><span className="store-kicker"><Sparkles size={14}/> A LITTLE WELCOME SURPRISE</span><h2 id="welcome-wheel-title">{prize?'You got a Za by Zach treat!':'Spin the Za wheel!'}</h2><p>{prize?'Your first-order reward is '+prize.label+'.':'One spin, one first-order reward. Give it a whirl!'}</p><div className="wheel-stage"><span className="wheel-pointer">▼</span><div className={'prize-wheel '+(spinning?'spinning':'')} style={{transform:'rotate('+rotation+'deg)',background:wheelBackground}}>{welcomePrizeOptions.map((option,index)=><span className="wheel-label" key={option.label} style={{transform:'rotate('+(index*36+18)+'deg) translateY(-82px) rotate(-'+(index*36+18)+'deg)'}}>{option.short}</span>)}<div className="wheel-center">ZA<br/><small>SPIN</small></div></div></div>{prize&&!prize.redeemed?<button className="wheel-action" onClick={closeWheel}>Use my {discountLabel(prize)} reward</button>:!prize?<button className="wheel-action" disabled={spinning} onClick={spinWheel}>{spinning?'Your treat is on the way…':'Spin for your discount'}</button>:<button className="wheel-action" onClick={closeWheel}>Let’s order</button>}<small className="wheel-fine-print">{prize?.redeemed?'This welcome reward has already been used.':'One welcome reward per customer. Applies to one pickup order.'}</small></div></div>}
 {replacementPopupOpen&&<div className="replacement-popup-backdrop" role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget)closeReplacementPopup();}}><section className="replacement-popup" role="dialog" aria-modal="true" aria-labelledby="replacement-title"><button className="wheel-close" aria-label="Close ingredient replacement options" onClick={closeReplacementPopup}><X size={18}/></button><span className="store-kicker">A QUICK MENU UPDATE</span><h2 id="replacement-title">Choose a free ingredient replacement</h2><p>{pendingPizzaSku?<><b>{itm(pendingPizzaSku).name.replace('Large ','')}</b> has a missing topping. Choose an in-stock replacement to add it to your order. The replacement is free and uses the same amount.</>:'These ingredients are short for your order. Choose an in-stock replacement for each one. The replacement is free and will be used in the same amount.'}</p>{replacementPopupPlan.shortages.map(shortage=>{const options=toppingOptions.filter(option=>option.sku!==shortage.componentSku&&availability?.ingredients.some(ingredient=>ingredient.sku===option.sku&&ingredient.category==='Ingredient'&&(ingredient.used_in?.length??0)>0&&ingredient.status!=='Unavailable'&&ingredient.available_units>=shortage.required));const selected=replacementChoices[shortage.productSku]?.[shortage.componentSku]??'';return <label className="replacement-choice" key={shortage.productSku+'-'+shortage.componentSku}><span><b>{shortage.productName}</b><small>{shortage.componentName} is unavailable at {location}.</small></span><select value={selected} onChange={e=>setReplacementChoices(previous=>({...previous,[shortage.productSku]:{...previous[shortage.productSku],[shortage.componentSku]:e.target.value}}))}><option value="">Choose a free replacement</option>{options.map(option=><option value={option.sku} key={option.sku}>{option.name}</option>)}</select>{!options.length&&<small className="replacement-none">No suitable in-stock replacement is available right now.</small>}</label>;})}{checkoutError&&<p className="checkout-error" role="alert">{checkoutError}</p>}<p className="replacement-dough-note">Dough cannot be replaced. If the store doesn’t have enough dough, that pizza can’t be ordered.</p><div className="replacement-popup-actions"><button className="button secondary" onClick={closeReplacementPopup}>Back to order</button><button className="store-checkout" onClick={confirmReplacements} disabled={replacementPopupPlan.shortages.some(shortage=>!replacementChoices[shortage.productSku]?.[shortage.componentSku])}>{pendingPizzaSku?'Add pizza to order':'Continue to checkout'}</button></div></section></div>}
 {stockPopup&&<SoldOutPopup name={stockPopup} onClose={()=>setStockPopup(null)}/>}
 </div>;
}
function SoldOutPopup({name,onClose}:{name:string;onClose:()=>void}){const button=useRef<HTMLButtonElement>(null);useEffect(()=>{const previous=document.activeElement as HTMLElement|null;button.current?.focus();const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')onClose();if(event.key==='Tab'){event.preventDefault();button.current?.focus();}};document.addEventListener('keydown',escape);return()=>{document.removeEventListener('keydown',escape);previous?.focus();};},[onClose]);return <div className="sold-out-backdrop"><section className="sold-out-popup" role="dialog" aria-modal="true" aria-labelledby="sold-out-title"><span className="sold-out-emoji">🍕💨</span><span className="store-kicker">GONE WITH THE DOUGH</span><h2 id="sold-out-title">Well, that was a popular slice!</h2><p><b>{name.replace('Large ','')}</b> is sold out at this pickup spot, or your cart has the last of it. Our kitchen is working on its comeback.</p><p>Try another favorite or switch pickup locations. Your next great bite is waiting!</p><button ref={button} className="store-checkout" onClick={onClose}>Find another favorite</button></section></div>;}
function CustomerCheckout({state,lines,substitutions,location,fulfillment,deliveryAddress,deliveryQuote,pickup,pickupTime,subtotal,discount,welcomeDiscount=discount,rewardDiscount=0,rewardsControl,tax,total,onBack,onPay}:{state:AppState;lines:{sku:string;qty:number}[];substitutions:Record<string,Record<string,string>>;location:Location;fulfillment:FulfillmentType;deliveryAddress:DeliveryAddress;deliveryQuote:DeliveryQuote|null;pickup:string;pickupTime:string;subtotal:number;discount:number;welcomeDiscount?:number;rewardDiscount?:number;rewardsControl?:(disabled:boolean)=>import('react').ReactNode;tax:number;total:number;onBack:()=>void;onPay:(name:string,phone:string,card:{brand:string;last4:string})=>Promise<void>}){
 const [name,setName]=useState('');const [phone,setPhone]=useState('');const matchedCustomer=findLoyaltyCustomer(state,phone);const phoneValid=!!normalizeCustomerPhone(phone);const changePhone=(value:string)=>{const match=findLoyaltyCustomer(state,value);if(match&&normalizeCustomerPhone(value)!==normalizeCustomerPhone(phone))setName(match.name);setPhone(value);};const [cardName,setCardName]=useState('');const [card,setCard]=useState('');const [expiry,setExpiry]=useState('');const [security,setSecurity]=useState('');const [zip,setZip]=useState('');const [submitting,setSubmitting]=useState(false);
 const [paymentError,setPaymentError]=useState('');
 return <div className="customer-storefront"><header className="checkout-top"><b>Za by Zach</b><span>Menu → <b>Checkout</b> → Confirmation</span></header><main className="checkout-container"><button className="checkout-back" onClick={onBack}>← Back to your order</button><span className="store-kicker">ONE LAST STEP</span><h1>Make it yours.</h1><p>Your favorites are almost yours. Review your {fulfillment} details and add a name and phone number.</p><div className="checkout-layout"><form className="checkout-card checkout-form" autoComplete="off" onSubmit={async e=>{e.preventDefault();if(submitting||!name.trim()||!cardName.trim()||!card.trim()||!expiry.trim()||!security.trim()||!zip.trim())return;if(phone.trim()&&!phoneValid){setPaymentError('Please enter a 10-digit phone number or leave the field blank.');return;}if(fulfillment==='delivery'&&!deliveryQuote){setPaymentError('Refresh the delivery estimate before placing the order.');return;}const cardProblem=cardError({name:cardName,number:card,expiry,cvc:security,zip:zip.trim()});if(cardProblem){setPaymentError(cardProblem);return;}setSubmitting(true);setPaymentError('');try{await onPay(name,phone,cardSummary(card));}catch(error){setPaymentError((error as Error).message);setSubmitting(false);}}}><h2>{fulfillment==='delivery'?'Who should receive the order?':'Who’s picking up?'}</h2><label htmlFor="order-name">Name for the order</label><input id="order-name" required maxLength={60} value={name} onChange={e=>setName(e.target.value)} placeholder="e.g. Zach or Friday study group"/><label htmlFor="checkout-phone">Phone number <span className="checkout-optional">Optional</span></label><input id="checkout-phone" type="tel" inputMode="tel" autoComplete="tel-national" maxLength={24} value={phone} onChange={e=>updateFormattedPaymentInput(e.currentTarget,formatCustomerPhone,changePhone)} onBlur={()=>{if(phoneValid)setPhone(formatCustomerPhone(phone));}} placeholder="(801) 555-0123" aria-describedby="checkout-phone-help"/><p id="checkout-phone-help" className="checkout-demo-help" role="status">{matchedCustomer?'Welcome back, '+matchedCustomer.name+'. Your details will be saved with your order.':phoneValid?'Your name and phone will be saved with your order.':'Add a phone number so the store can contact you about your order.'}</p><h2>Payment information</h2><label htmlFor="card-name">Name on card</label><input id="card-name" required maxLength={60} value={cardName} onChange={e=>setCardName(e.target.value)} placeholder="Name as shown on card"/><label htmlFor="demo-card">Card number</label><input id="demo-card" required inputMode="numeric" autoComplete="cc-number" maxLength={23} value={card} onChange={e=>updateFormattedPaymentInput(e.currentTarget,formatCardNumber,setCard)} placeholder="4242 4242 4242 4242"/><div className="checkout-field-row"><div><label htmlFor="demo-expiry">Expiration</label><input id="demo-expiry" required inputMode="numeric" autoComplete="cc-exp" maxLength={5} value={expiry} onChange={e=>updateFormattedPaymentInput(e.currentTarget,formatCardExpiry,setExpiry)} placeholder="MM/YY"/></div><div><label htmlFor="demo-cvc">Security code</label><input id="demo-cvc" required type="password" inputMode="numeric" maxLength={4} value={security} onChange={e=>setSecurity(e.target.value)} placeholder="123"/></div><div><label htmlFor="demo-zip">Billing ZIP code</label><input id="demo-zip" required inputMode="numeric" autoComplete="postal-code" maxLength={5} pattern="[0-9]{5}" title="5-digit ZIP code" value={zip} onChange={e=>setZip(e.target.value.replace(/\D/g,'').slice(0,5))} placeholder="84601"/></div></div><p className="checkout-error" role="alert">{paymentError}</p><button className="store-checkout" type="submit" disabled={submitting}>{submitting?'Placing order…':'Pay & place order · '+usd(total)}</button><p className="checkout-demo-help">Online payments are simulated in this ERP demo. Do not enter real payment information.</p></form><aside className="checkout-card checkout-recap"><h2>Your {fulfillment} order</h2>{rewardsControl?.(submitting)}<p><MapPin size={14}/> {location}<br/>{fulfillment==='delivery'&&deliveryQuote?<>Deliver to {formatDeliveryAddress(deliveryAddress)}<br/>Estimated arrival: {deliveryQuote.etaMin}–{deliveryQuote.etaMax} minutes</>:<>{dateLabel(pickup)} at {pickupTimeLabel(pickupTime)}</>}</p>{lines.map(l=><div className="checkout-summary-row" key={l.sku}><span>{l.qty} × {itm(l.sku).name}{Object.entries(substitutions[l.sku]??{}).map(([from,to])=><small className="line-substitution" key={from}>Replace {itm(from).name} with {itm(to).name} · free</small>)}</span><b>{usd(l.qty*itm(l.sku).price)}</b></div>)}<div className="checkout-summary-row"><span>Subtotal</span><b>{usd(subtotal)}</b></div>{welcomeDiscount>0&&<div className="checkout-summary-row discount-line"><span>Welcome discount</span><b>−{usd(welcomeDiscount)}</b></div>}{rewardDiscount>0&&<div className="checkout-summary-row discount-line"><span>Shared rewards discount</span><b>−{usd(rewardDiscount)}</b></div>}<div className="checkout-summary-row"><span>Tax</span><b>{usd(tax)}</b></div>{fulfillment==='delivery'&&<div className="checkout-summary-row"><span>Delivery fee</span><b>{usd(deliveryQuote?.fee??0)}</b></div>}<div className="checkout-summary-row checkout-total"><span>Total</span><b>{usd(total)}</b></div><p className="checkout-demo-help">Your confirmation will include your order number and {fulfillment==='delivery'?'delivery address and estimate':'pickup name and time'}.</p></aside></div></main></div>;
}
function pageDescription(p:Page){return({'Barcode Labels':'Find incoming-item SKUs and print scannable labels for receiving.',Suppliers:'Manage supplier contacts, delivery promises, payment terms, and item assignments.','Inventory Review':'Review reorder points and EOQ, approve draft orders, and record your review.','Help & Support':'Find a screen or follow a step-by-step guide.',Dashboard:'Here’s what’s happening across your stores today.',POS:'Ring up an order, apply a discount, and keep inventory in sync.', 'Sales Orders':'Track catering and pickup orders from placement through fulfillment.',Returns:'Reverse a sale, choose a disposition, and record the reason.',Inventory:'A live view of stock, replenishment signals, and item costs.','Transfers & Counts':'Move stock between locations or reconcile a cycle count.',Production:'Prepare fresh dough and other items in house; record good units and scrap.','Purchase Orders':'Receive stock, update weighted average cost, and review open orders.','Supplier Scorecards':'Compare supplier delivery, fill rates, and invoices from purchase history.',MRP:'Plan confirmed shared orders against dated supply at each location.',Financials:'Follow sales, cost of goods, inventory value, and operating results.',Reports:'Explore sales pace, item mix, and stock availability.',Settings:'Update the assumptions used by replenishment and checkout.',About:'How this demo works and which system behaviors it demonstrates.'} as Record<Page,string>)[p];}
function Login({onLogin,error}:{onLogin:(email:string,password:string)=>Promise<void>;error:string}){const [email,setEmail]=useState('');const [password,setPassword]=useState('');const [submitting,setSubmitting]=useState(false);const submit=async(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();setSubmitting(true);try{await onLogin(email,password);}finally{setSubmitting(false);}};return <div className="login-screen"><div className="login-panel"><div className="brand big"><div className="brand-mark"><img src={zaLogo} alt="Za by Zach" className="logo-img"/></div><div><b>Za by Zach</b><small>RESTAURANT OPERATIONS</small></div></div><div className="login-heading"><span className="eyebrow">WELCOME BACK</span><h1>Sign in to your workspace</h1><p>Sign in with your Supabase Auth account.</p></div><form onSubmit={event=>void submit(event)}><label className="field-label" htmlFor="login-email">Email address</label><div className="input-wrap"><UserRound size={16}/><input id="login-email" type="email" autoComplete="email" required value={email} onChange={event=>setEmail(event.target.value)}/></div><label className="field-label mt" htmlFor="login-password">Password</label><div className="input-wrap"><ShieldCheck size={16}/><input id="login-password" type="password" autoComplete="current-password" required value={password} onChange={event=>setPassword(event.target.value)}/></div>{error&&<p className="login-error" role="alert">{error}</p>}<button className="button primary login-btn" type="submit" disabled={submitting}>{submitting?'Signing in…':'Continue to Za by Zach'} <ArrowUpRight size={16}/></button></form><div className="login-foot">Secure workspace <span>·</span> ERP course project</div></div><div className="login-art"><div className="art-orbit orbit-a"/><div className="art-orbit orbit-b"/><div className="pizza-art">🍕</div><div className="art-copy"><span>BUILT FOR THE BUSY MOMENTS</span><h2>One kitchen.<br/>Everything in sync.</h2><p>From first order to last ingredient, your operation moves together.</p></div><div className="art-stat"><div className="stat-bubble"><PackageCheck size={18}/></div><div><small>INVENTORY ACCURACY</small><b>Ledger-backed tracking</b></div><span className="green-pill">REAL TIME</span></div></div></div>}
function LocationSelect({value,onChange}:{value:Location;onChange:(x:Location)=>void}){return <div className="select-wrap location-select"><Warehouse size={15} aria-hidden="true"/><select aria-label="Store location" value={value} onChange={e=>onChange(e.target.value as Location)}>{locations.map(l=><option key={l}>{l}</option>)}</select><ChevronDown size={13} aria-hidden="true"/></div>}
function StatCard({label,value,change,icon:Icon,accent='blue',sub}:{label:string;value:string;change?:string;icon:any;accent?:string;sub?:string}){return <div className="stat-card"><div className="stat-head"><span>{label}</span><span className={`stat-icon ${accent}`}><Icon size={17}/></span></div><div className="stat-value">{value}</div><div className="stat-foot">{change&&<span className="trend-up"><ArrowUpRight size={13}/>{change}</span>}<span>{sub}</span></div></div>}
function Dashboard({state,location,setPage}:{state:AppState;location:Location;setPage:(p:Page)=>void}){const todaySales=state.sales.filter(s=>s.date===today()&&s.location===location&&s.status==='Completed').reduce((n,s)=>n+s.lines.reduce((v,l)=>v+l.qty*l.price,0)-s.discount,0);const week=state.sales.filter(s=>new Date(s.date)>=new Date(Date.now()-7*86400000)&&s.status==='Completed'&&s.location===location);const gross=week.reduce((a,s)=>a+s.lines.reduce((x,l)=>x+l.qty*(l.price-l.cost),0)-s.discount,0);const lows=items.filter(i=>!i.recipe&&inventory(state,i.sku)<reorderPoint(state,i)).length;const open=state.purchaseOrders.filter(isOpenPO);const late=open.filter(p=>p.expected<today());const due=0;const waste=state.ledger.filter(t=>t.type==='Waste'&&t.date>=today()).reduce((a,t)=>a+Math.abs(t.qty*t.unitCost),0);const chart=Array.from({length:7},(_,idx)=>{const d=new Date(Date.now()-(6-idx)*86400000),key=businessDate(d);return{day:d.toLocaleDateString('en-US',{weekday:'short'}),sales:state.sales.filter(s=>s.date===key&&s.location===location).reduce((a,s)=>a+s.lines.reduce((v,l)=>v+l.qty*l.price,0),0)};});const max=items.filter(i=>i.recipe).map(i=>({item:i,qty:maxMake(state,i.sku,location)}));const recent=state.sales.slice(0,5);return <>
 <div className="stats-grid"><StatCard label="Net sales today" value={usd(todaySales)} icon={CircleDollarSign} change="Live" sub="after discounts · before tax"/><StatCard label="Gross profit · 7 days" value={usd(gross)} icon={Activity} change="Computed" accent="green" sub="after discounts"/><StatCard label="Below reorder point" value={String(lows)} icon={AlertTriangle} accent={lows?'amber':'green'} sub="ingredients & supplies"/><StatCard label="Open purchase orders" value={String(open.length)} icon={Truck} sub={`${late.length} past expected date`}/></div>
 <div className="dashboard-grid"><section className="panel sales-panel"><div className="panel-head"><div><h2>Sales performance</h2><p>Gross sales · last 7 days</p></div><button className="small-select" onClick={()=>setPage('Reports')}>View reports <ArrowUpRight size={14}/></button></div><div className="chart-box"><ResponsiveContainer width="100%" height="100%"><LineChart data={chart} margin={{top:10,right:12,left:-18,bottom:0}}><CartesianGrid strokeDasharray="4 4" vertical={false} stroke="#edf1f5"/><XAxis dataKey="day" axisLine={false} tickLine={false} tick={{fontSize:11,fill:'#8894a2'}} dy={9}/><YAxis axisLine={false} tickLine={false} tick={{fontSize:11,fill:'#8894a2'}} tickFormatter={v=>`$${Math.round(v/1000)}k`}/><Tooltip formatter={(v:any)=>usd(v)} contentStyle={{borderRadius:9,border:'1px solid #e4e9ef',fontSize:12}}/><Line type="monotone" dataKey="sales" stroke="#1d67a6" strokeWidth={2.7} dot={{r:3,fill:'#fff',strokeWidth:2}} activeDot={{r:5}}/></LineChart></ResponsiveContainer></div><div className="chart-foot"><span><i className="legend-dot blue-dot"/>Gross sales</span><span>Net sales reflect discounts and tax separately</span></div></section>
 <section className="panel make-panel"><div className="panel-head"><div><h2>What can we make?</h2><p>Buildable right now · {location}</p></div><Pizza size={17} className="muted-icon"/></div><div className="make-list">{max.map(({item,qty})=><div className="make-row" key={item.sku}><div className="pizza-thumb">{item.sku==='2002'?'🍕':item.sku==='2006'?'🍗':'🧀'}</div><div className="make-name"><b>{item.name.replace('Large ','')}</b><span>SKU {item.sku}</span></div><span className={`stock-pill ${qty<8?'low':''}`}>{qty} ready</span></div>)}</div><button className="panel-link" onClick={()=>setPage('Inventory')}>View inventory <ArrowUpRight size={14}/></button></section>
 <section className="panel recent-panel"><div className="panel-head"><div><h2>Recent sales</h2><p>Latest completed tickets across locations</p></div><button className="small-select" onClick={()=>setPage('POS')}>Open POS <ArrowUpRight size={14}/></button></div><div className="table-scroll"><table><thead><tr><th>RECEIPT</th><th>LOCATION</th><th>ITEMS</th><th>STATUS</th><th className="right">TOTAL</th></tr></thead><tbody>{recent.map(s=><tr key={s.id}><td><b className="mono">{s.id}</b><small className="cell-sub">{dateLabel(s.date)}</small></td><td>{s.location.replace(' Store','')}</td><td>{s.lines.reduce((a,l)=>a+l.qty,0)} items</td><td><span className="status-chip good">Completed</span></td><td className="right"><b>{usd(s.total)}</b></td></tr>)}</tbody></table></div></section>
 <section className="panel task-panel"><div className="panel-head"><div><h2>Needs attention</h2><p>Prioritized operations tasks</p></div><span className="task-count">{Math.min(99,lows+late.length+due)}</span></div><div className="attention-list">{lows>0&&<button onClick={()=>setPage('Inventory')}><span className="attention-icon amber"><AlertTriangle size={15}/></span><span><b>{lows} items below reorder point</b><small>Review suggested quantities</small></span><ArrowUpRight size={14}/></button>}{late.length>0&&<button onClick={()=>setPage('Purchase Orders')}><span className="attention-icon red"><Clock3 size={15}/></span><span><b>{late.length} purchase orders are late</b><small>Check expected receipts</small></span><ArrowUpRight size={14}/></button>}{due>0&&<button onClick={()=>setPage('MRP')}><span className="attention-icon blue"><CalendarClock size={15}/></span><span><b>{due} MRP actions to review</b><small>Open demand in the next four weeks</small></span><ArrowUpRight size={14}/></button>}{lows===0&&late.length===0&&due===0&&<div className="empty-inline">Everything is on track for now.</div>}</div></section></div>
 <div className="dashboard-bottom"><span><span className="live-dot"/>Inventory sync active</span><span>Sample operating history + recorded transactions · 2 sales locations</span><span>Role: Manager</span></div></>}
function POS({state,location,setLocation,onCommit,flash}:{state:AppState;location:Location;setLocation:(v:Location)=>void;onCommit:(s:AppState)=>void;flash:(m:string)=>void}){
 const [cart,setCart]=useState<(SaleInput&{id:string})[]>([]),[discount,setDiscount]=useState(0),[rewardsPhone,setRewardsPhone]=useState(''),[redeemReward,setRedeemReward]=useState(false),[pickupName,setPickupName]=useState(''),[scan,setScan]=useState(''),[lastSale,setLastSale]=useState<(PosReceipt&{rewardsEarned?:number;rewardsBalance?:number|null})|null>(null),[camera,setCamera]=useState(false),[type,setType]=useState('All'),[query,setQuery]=useState(''),[editing,setEditing]=useState<string|null>(null),[draft,setDraft]=useState<Record<string,number>>({}),[draftSauce,setDraftSauce]=useState<string|undefined>(),[checkoutBusy,setCheckoutBusy]=useState(false),[checkoutUncertain,setCheckoutUncertain]=useState(false);
 const [cardName,setCardName]=useState(''),[cardNumber,setCardNumber]=useState(''),[cardExpiry,setCardExpiry]=useState(''),[cardCvc,setCardCvc]=useState(''),[cardZip,setCardZip]=useState('');
 const checkoutLock=useRef(false);
 const [matchedCustomer,setMatchedCustomer]=useState<PosCustomer|null>(null),[customerLoading,setCustomerLoading]=useState(false),[customerError,setCustomerError]=useState(''),[savingCustomer,setSavingCustomer]=useState(false);
 const [pending,setPending]=useState(readPendingPosSale),[lastPaymentMethod,setLastPaymentMethod]=useState('Cash'),[paymentMethod,setPaymentMethod]=useState<'Cash'|'Card (simulated)'>('Cash');
 const phoneValid=!!normalizeCustomerPhone(rewardsPhone),account=matchedCustomer?{points:matchedCustomer.points,availablePoints:Math.max(0,matchedCustomer.points)}:null;
 const lookupVersion=useRef(0);const [lookupRetry,setLookupRetry]=useState(0);
 const changeRewardsPhone=(value:string)=>{lookupVersion.current++;setMatchedCustomer(null);setCustomerError('');setRedeemReward(false);setPickupName('');setRewardsPhone(value);};
 useEffect(()=>{const version=++lookupVersion.current;setMatchedCustomer(null);setRedeemReward(false);setCustomerError('');if(!phoneValid){setCustomerLoading(false);return;}setCustomerLoading(true);
  const timer=window.setTimeout(()=>{loadPosCustomer(rewardsPhone).then(customer=>{if(version!==lookupVersion.current)return;setMatchedCustomer(customer);if(customer)setPickupName(customer.name);}).catch(error=>{if(version===lookupVersion.current)setCustomerError(error.message);}).finally(()=>{if(version===lookupVersion.current)setCustomerLoading(false);});},300);
  return()=>{clearTimeout(timer);lookupVersion.current++;};
 },[normalizeCustomerPhone(rewardsPhone),lookupRetry]);
 const saveProfile=async()=>{const version=lookupVersion.current;setSavingCustomer(true);setCustomerError('');try{const profile=await loadPosCustomer(rewardsPhone,pickupName);if(version!==lookupVersion.current)return;setMatchedCustomer(profile);flash('Customer saved to shared rewards.');}catch(e){if(version===lookupVersion.current)setCustomerError((e as Error).message);}finally{setSavingCustomer(false);}};
 const menu=items.filter(i=>i.price>0);const sold=(sku:string)=>state.sales.reduce((sum,s)=>sum+s.lines.filter(l=>l.sku===sku).reduce((n,l)=>n+l.qty,0),0);
 const order=['Pizza','Sides','Beverage'];const sorted=[...menu].sort((a,b)=>order.indexOf(a.category)-order.indexOf(b.category)||sold(b.sku)-sold(a.sku)||a.name.localeCompare(b.name));
 const visible=sorted.filter(i=>(type==='All'||i.category===type)&&i.name.toLowerCase().includes(query.toLowerCase()));
 const add=(sku:string)=>{if(!menu.some(i=>i.sku===sku)){flash('Only menu items can be sold at the POS.');return;}setCart(c=>{const found=c.find(x=>x.sku===sku&&!customizedItem(x.sku,x.adjustments,x.sauceSku).modifiers.length);return found?c.map(x=>x.id===found.id?{...x,qty:x.qty+1}:x):[...c,{id:crypto.randomUUID(),sku,qty:1}];});};
 const qty=(id:string,change:number)=>setCart(c=>c.map(l=>l.id===id?{...l,qty:l.qty+change}:l).filter(l=>l.qty>0));const setLineQty=(id:string,value:number)=>setCart(c=>c.map(l=>l.id===id?{...l,qty:Number.isFinite(value)?Math.max(1,Math.min(999,value)):1}:l));
 const subtotal=cart.reduce((sum,l)=>sum+l.qty*customizedItem(l.sku,l.adjustments,l.sauceSku).price,0),disc=subtotal*discount/100,rewardsCredit=redeemReward&&!!matchedCustomer&&matchedCustomer.points>=100&&subtotal-disc>=5?5:0,tax=Math.max(0,subtotal-disc-rewardsCredit)*state.settings.tax,total=Math.max(0,subtotal-disc-rewardsCredit)+tax;
 const canRedeem=!!matchedCustomer&&!customerLoading&&!customerError&&(account?.availablePoints??0)>=100&&subtotal-disc>=5,estimatedPoints=phoneValid?Math.floor(Math.max(0,subtotal-disc-rewardsCredit)+1e-8):0;
 useEffect(()=>{if(!canRedeem)setRedeemReward(false);},[canRedeem]);
 const scanSubmit=(value=scan)=>{const i=menu.find(x=>x.barcode===value||x.sku===value);if(i){add(i.sku);setScan('');}else flash('No sellable menu item matches that barcode or SKU.');};
 const acceptReceipt=(data:RecordSaleResult&{rewards_earned?:number;rewards_balance?:number|null},ticket:{location:Location;lines:{sku:string;qty:number}[];cardBrand?:string;cardLast4?:string})=>{
  setLastPaymentMethod((data as RecordSaleResult&{payment_method?:string}).payment_method||paymentMethod);setLastSale({receiptNo:data.receipt_no,saleId:data.sale_id,date:today(),location:ticket.location,lines:ticket.lines,subtotal:data.subtotal,discount:data.discount,tax:data.tax,total:data.total,rewardsEarned:data.rewards_earned,rewardsBalance:data.rewards_balance,cardBrand:ticket.cardBrand,cardLast4:ticket.cardLast4});setCardName('');setCardNumber('');setCardExpiry('');setCardCvc('');setCardZip('');
  setCart([]);setDiscount(0);setPickupName('');setRewardsPhone('');setRedeemReward(false);setPaymentMethod('Cash');setPending(null);setCheckoutUncertain(false);
  window.dispatchEvent(new Event('erp-inventory-updated'));window.dispatchEvent(new Event('erp-reports-updated'));
  flash(`Sale recorded · ${data.receipt_no}`);
 };
 const recover=async()=>{if(checkoutLock.current||!pending)return;checkoutLock.current=true;setCheckoutBusy(true);try{const data=await recoverPosSale();acceptReceipt(data,pending);}catch(error){const saved=readPendingPosSale();setPending(saved);setCheckoutUncertain(!!saved);flash((error as Error).message);}finally{checkoutLock.current=false;setCheckoutBusy(false);}};
 const finish=async()=>{
  if(checkoutBusy||checkoutLock.current||checkoutUncertain||pending)return;
  if(!cart.length)return;
  if(!Number.isFinite(discount)||discount<0||discount>100){flash('Enter a discount between 0 and 100 percent.');return;}
  if(rewardsPhone.trim()&&(!phoneValid||customerLoading||customerError)){flash(customerError||'Enter a valid phone and wait for customer lookup.');return;}
  if(phoneValid&&!pickupName.trim()){flash('Enter the rewards customer’s name.');return;}
   if(paymentMethod==='Card (simulated)'){if(!pickupName.trim()){flash('Enter the customer’s name for the order.');return;}const problem=cardError({name:cardName,number:cardNumber,expiry:cardExpiry,cvc:cardCvc,zip:cardZip});if(problem){flash(problem);return;}}
  if(redeemReward&&!canRedeem){setRedeemReward(false);flash('This order is no longer eligible for a reward.');return;}
  if(cart.some(line=>customizedItem(line.sku,line.adjustments,line.sauceSku).modifiers.length>0)){flash('Customized items are not supported by Supabase checkout. Remove customizations to continue.');return;}
  checkoutLock.current=true;setCheckoutBusy(true);
  try{
   const lines=cart.map(({sku,qty})=>({sku,qty}));
   const data=await postPosSale({location,lines,discount,phone:rewardsPhone,name:pickupName,redeem:redeemReward,paymentMethod,...(paymentMethod==='Card (simulated)'?{cardBrand:cardSummary(cardNumber).brand,cardLast4:cardSummary(cardNumber).last4}:{})});
   acceptReceipt(data,{location,lines});
  }catch(error){const saved=readPendingPosSale();setPending(saved);setCheckoutUncertain(!!saved);flash((error as Error).message);}
  finally{setCheckoutBusy(false);checkoutLock.current=false;}
 };
 const editLine=cart.find(l=>l.id===editing),editItem=editLine?itm(editLine.sku):null;
 const openCustomization=(line:SaleInput&{id:string})=>{setEditing(line.id);setDraft({...line.adjustments});setDraftSauce(line.sauceSku??sauceOptions.find(s=>(itm(line.sku).recipe?.[s.sku]??0)>0)?.sku);};
 const emoji=(i:Item)=>i.category==='Pizza'?'🍕':i.category==='Beverage'?'🥤':i.sku==='2007'?'🥖':'🥣';
 return <div className="pos-layout" aria-busy={checkoutBusy}><section className="panel pos-menu" inert={checkoutBusy||!!pending}><div className="pos-toolbar"><LocationSelect value={location} onChange={setLocation}/><div className="scan-input"><ScanLine size={16}/><input aria-label="Barcode or SKU" value={scan} onChange={e=>setScan(e.target.value)} onKeyDown={e=>e.key==='Enter'&&scanSubmit()} placeholder="Scan menu item barcode…"/><button onClick={()=>scanSubmit()}>Add</button></div><button className="icon-button border" aria-label="Camera scanner" onClick={()=>setCamera(true)}><ScanLine size={17}/></button></div><div className="menu-heading"><div><h2>Menu</h2><p>Popular picks first within each product type</p></div><span className="muted-label">{menu.length} items</span></div><div className="pos-browse"><div className="pos-type-tabs">{['All',...order].map(t=><button key={t} className={type===t?'active':''} onClick={()=>setType(t)}>{t==='Pizza'?'Pizzas':t==='Beverage'?'Drinks':t}</button>)}</div><label className="pos-search"><Search size={15}/><input aria-label="Search menu" placeholder="Find a menu item" value={query} onChange={e=>setQuery(e.target.value)}/></label></div><div className="pos-menu-scroll" tabIndex={0} aria-label="Menu items">{order.map(category=>{const group=visible.filter(i=>i.category===category);return group.length>0&&<div className="pos-product-section" key={category}><h3>{category==='Pizza'?'Pizzas':category==='Beverage'?'Coca-Cola cans':'Sides & dips'}<small>{group.length} items</small></h3><div className="product-grid">{group.map((i,index)=><button className="product-tile" key={i.sku} onClick={()=>add(i.sku)}><div className={`product-art art-${i.sku}`} style={pizzaImages[i.sku]?{overflow:'hidden',padding:0,height:'auto',aspectRatio:'2 / 1'}:undefined}>{pizzaImages[i.sku]?<img src={pizzaImages[i.sku]} alt={i.name} style={{width:'100%',height:'100%',objectFit:'cover',objectPosition:'50% 60%',display:'block'}}/>:emoji(i)}</div><div className="product-tile-info"><b>{i.name}</b><span>{category==='Pizza'&&index===0?'Popular pick':category==='Pizza'?'Fresh pizza':'Add to your order'}</span></div><strong>{usd(i.price)}</strong><span className="plus-bubble" style={pizzaImages[i.sku]?{top:'auto',bottom:38}:undefined}><Plus size={15}/></span></button>)}</div></div>})}{!visible.length&&<div className="empty-inline">No menu items match your search.</div>}
</div></section>
 <aside className="panel cart-panel"><div className="cart-head"><div><h2>Current order</h2><p>{cart.reduce((sum,l)=>sum+l.qty,0)} items on this ticket</p></div><span className="cart-icon"><ShoppingCart size={18}/></span></div><details className="pos-customer-details" inert={checkoutBusy||!!pending}><summary>Customer & rewards <span>{matchedCustomer?matchedCustomer.name:rewardsPhone||'Guest checkout'}</span></summary><div className="pos-pickup-details"><label htmlFor="pos-rewards-phone">Rewards phone <span>Optional</span></label><input id="pos-rewards-phone" type="tel" inputMode="tel" autoComplete="tel-national" maxLength={24} value={rewardsPhone} onChange={e=>updateFormattedPaymentInput(e.currentTarget,formatCustomerPhone,changeRewardsPhone)} onBlur={()=>{if(phoneValid)setRewardsPhone(formatCustomerPhone(rewardsPhone));}} placeholder="(801) 555-0123"/><small className="pos-phone-helper" role="status">{customerLoading?'Looking up shared rewards…':customerError?customerError:matchedCustomer?'Customer found · name filled in below':phoneValid?'New rewards customer · enter their name below':rewardsPhone.trim()?'Enter a 10-digit US phone number':'Enter a phone number to find or enroll a customer.'}</small>{customerError&&<button className="table-action" onClick={()=>setLookupRetry(n=>n+1)}>Retry rewards lookup</button>}<label htmlFor="pos-pickup-name">Name to call <span>{paymentMethod==='Card (simulated)'||phoneValid&&!matchedCustomer?'Required':'Optional'}</span></label><input id="pos-pickup-name" autoComplete="given-name" maxLength={60} value={pickupName} onChange={e=>setPickupName(e.target.value)} placeholder="e.g. Andrew"/></div>{rewardsPhone.trim()&&<section className="pos-rewards-panel" aria-label="Customer rewards">{phoneValid?<><div className="pos-rewards-heading"><span><b>{matchedCustomer?matchedCustomer.name:'New rewards customer'}</b><small>{matchedCustomer?.enrolled?'Shared rewards account':'Enroll by saving or completing this sale.'}</small></span><strong>{account?.points??0}<small>points</small></strong></div><div className="pos-rewards-actions"><button className="table-action" disabled={savingCustomer||customerLoading||!!customerError||!pickupName.trim()||(!!matchedCustomer&&matchedCustomer.enrolled&&pickupName.trim()===matchedCustomer.name)} onClick={()=>void saveProfile()}>{matchedCustomer?'Save name to profile':'Save customer'}</button></div><label className="pos-rewards-redeem"><input type="checkbox" checked={redeemReward&&canRedeem} disabled={!canRedeem} onChange={e=>setRedeemReward(e.target.checked)}/><span><b>Use 100 points for $5 off</b><small>{!matchedCustomer?'Available after earning 100 points.':(account?.availablePoints??0)<100?`${100-(account?.points??0)} more points needed`:subtotal-disc<5?'Add at least $5 after other discounts to redeem.':'Redeem on this order before tax.'}</small></span></label><p>Earn <b>{estimatedPoints} points</b> on this order. 1 point per full $1 before tax, after discounts.</p></>:<p>Add a complete phone number to link rewards. Clear it to continue as a guest.</p>}</section>}</details><div className="cart-lines" inert={checkoutBusy||!!pending} tabIndex={0} aria-label="Current order items">{!cart.length?<div className="cart-empty"><div>🧾</div><b>Your order is empty</b><span>Choose an item from the menu.</span></div>:cart.map(line=>{const i=itm(line.sku),custom=customizedItem(line.sku,line.adjustments,line.sauceSku);return <div className="cart-line pos-custom-line" key={line.id}><div className="line-thumb" style={pizzaImages[i.sku]?{overflow:'hidden',padding:0}:undefined}>{pizzaImages[i.sku]?<img src={pizzaImages[i.sku]} alt="" style={{width:'100%',height:'100%',objectFit:'cover',display:'block'}}/>:emoji(i)}</div><div className="line-copy"><b>{i.name}</b><span>{usd(custom.price)} each</span>{custom.modifiers.map(m=><small className="pos-modifier-label" key={m}>{m}</small>)}</div><div className="qty-control"><button aria-label={'Remove one '+i.name} onClick={()=>qty(line.id,-1)}><Minus size={12}/></button><NumberInput aria-label={'Quantity of '+i.name} className="pos-qty-input" type="number" min="1" max="999" step="1" value={line.qty} onChange={e=>setLineQty(line.id,Number(e.target.value))}/><button aria-label={'Add one '+i.name} onClick={()=>qty(line.id,1)}><Plus size={12}/></button></div><b className="line-total">{usd(line.qty*custom.price)}</b></div>})}</div><div className="pos-checkout-footer"><div className="cart-options" inert={checkoutBusy||!!pending}><label className="field-label">Discount</label><div className="discount-input"><NumberInput aria-label="Discount percentage" type="number" min="0" max="100" value={discount} onChange={e=>setDiscount(Math.max(0,Math.min(100,Number(e.target.value))))}/><span>% discount</span></div></div><div className="pos-tender"><label className="field-label" htmlFor="pos-payment-method">Payment method</label><select id="pos-payment-method" value={paymentMethod} onChange={e=>setPaymentMethod(e.target.value as 'Cash'|'Card (simulated)')}><option value="Cash">Cash</option><option value="Card (simulated)">Card</option></select><small>{paymentMethod==='Card (simulated)'?'Demo only: nothing is charged. Only the card type and last 4 digits are saved with the sale.':'Cash sale: no card details needed.'}</small>{paymentMethod==='Card (simulated)'&&<div className="pos-card-box"><label className="field-label">Payment card <span style={{opacity:.6}}>{cardNumber?detectCardBrand(cardNumber):''}</span></label><input id="pos-card-name" autoComplete="off" maxLength={60} value={cardName} onChange={e=>setCardName(e.target.value)} placeholder="Name on card"/><input id="pos-card-number" autoComplete="off" inputMode="numeric" maxLength={23} value={cardNumber} onChange={e=>updateFormattedPaymentInput(e.currentTarget,formatCardNumber,setCardNumber)} placeholder="Card number" style={{marginTop:6}}/><div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:6,marginTop:6}}><input id="pos-card-expiry" autoComplete="off" inputMode="numeric" maxLength={5} value={cardExpiry} onChange={e=>updateFormattedPaymentInput(e.currentTarget,formatCardExpiry,setCardExpiry)} placeholder="MM/YY"/><input id="pos-card-cvc" type="password" autoComplete="off" inputMode="numeric" maxLength={4} value={cardCvc} onChange={e=>setCardCvc(e.target.value.replace(/\D/g,'').slice(0,4))} placeholder="Code"/><input id="pos-card-zip" autoComplete="off" inputMode="numeric" maxLength={5} value={cardZip} onChange={e=>setCardZip(e.target.value.replace(/\D/g,'').slice(0,5))} placeholder="ZIP"/></div></div>}</div><div className="totals"><div><span>Subtotal</span><b>{usd(subtotal)}</b></div><div><span>Discount</span><b>− {usd(disc)}</b></div>{redeemReward&&<div className="pos-rewards-discount"><span>Rewards · 100 points</span><b>− {usd(rewardsCredit)}</b></div>}<div><span>Tax</span><b>{usd(tax)}</b></div><div className="total-row"><strong>Total due</strong><strong>{usd(total)}</strong></div></div><button className="button primary checkout-btn" disabled={!cart.length||checkoutBusy||!!pending||customerLoading||savingCustomer||!!customerError||!!rewardsPhone.trim()&&(!phoneValid||!pickupName.trim())||paymentMethod==='Card (simulated)'&&(!pickupName.trim()||!!cardError({name:cardName,number:cardNumber,expiry:cardExpiry,cvc:cardCvc,zip:cardZip}))} onClick={()=>void finish()}>{checkoutBusy?'Saving sale…':'Complete sale'} <ArrowUpRight size={16}/></button><div className="payment-note">Estimated totals · final amounts confirmed on receipt</div>{pending&&<div className="pos-pending" role="alert"><p>Checkout confirmation pending. Recover the saved request before starting another sale.</p><button className="button secondary full" disabled={checkoutBusy} onClick={()=>void recover()}>{checkoutBusy?'Checking sale…':'Recover checkout confirmation'}</button></div>}</div></aside>
 {editLine&&editItem&&<div className="modal-backdrop"><div className="modal pos-customizer" role="dialog" aria-modal="true" aria-labelledby="custom-title"><button className="modal-x" aria-label="Close customization" onClick={()=>setEditing(null)}><X size={18}/></button><span className="eyebrow">MAKE IT YOURS</span><h2 id="custom-title">{editItem.name}</h2><p>Choose ingredients for all {editLine.qty} of these items. Removals are free; additions show their price below.</p>{editItem.category==='Pizza'&&<label className="pos-sauce-picker"><span><b>Pizza sauce base</b><small>Swap the standard sauce at no extra charge.</small></span><select aria-label="Pizza sauce base" value={draftSauce??'1002'} onChange={e=>{setDraftSauce(e.target.value);setDraft(d=>Object.fromEntries(Object.entries(d).filter(([sku])=>!sauceOptions.some(s=>s.sku===sku))));}}>{sauceOptions.map(s=><option value={s.sku} key={s.sku}>{s.name}</option>)}</select></label>}<div className="pos-ingredient-list">{toppingOptions.map(t=>{const base=customizedItem(editItem.sku,{},editItem.category==='Pizza'?draftSauce:undefined).recipe[t.sku]??0,change=draft[t.sku]??0,value=change<0?'none':change===0?(base?'regular':'none'):change===toppingPortion(t.sku)?'add':'extra';return <label className="pos-ingredient-row" key={t.sku}><span><b>{t.name}</b><small>{base?'Included in recipe':'Optional addition'} · {usd(toppingCharge(t.sku))} / extra {toppingPortion(t.sku)} oz</small></span><select aria-label={t.name} value={value} onChange={e=>{const choice=e.target.value;setDraft(d=>({...d,[t.sku]:choice==='none'?-base:choice==='regular'?0:toppingPortion(t.sku)*(choice==='extra'?2:1)}));}}><option value="none">{base?'Remove':'None'}</option>{base>0&&<option value="regular">Regular</option>}<option value="add">{base?'Extra':'Add'} (+{usd(toppingCharge(t.sku))})</option><option value="extra">Double extra (+{usd(2*toppingCharge(t.sku))})</option></select></label>})}</div><div className="pos-custom-total"><span>Customized price per item</span><b>{usd(customizedItem(editLine.sku,draft,editItem.category==='Pizza'?draftSauce:undefined).price)}</b></div><div className="modal-actions"><button className="button secondary" onClick={()=>{setDraft({});setDraftSauce(sauceOptions.find(s=>(editItem.recipe?.[s.sku]??0)>0)?.sku);}}>Reset recipe</button><button className="button primary" onClick={()=>{setCart(c=>c.map(l=>l.id===editing?{...l,sauceSku:editItem.category==='Pizza'?draftSauce:undefined,adjustments:Object.fromEntries(Object.entries(draft).filter(([,q])=>q!==0))}:l));setEditing(null);}}>Save customization</button></div></div></div>}
 {lastSale&&<div className="modal-backdrop"><div className="modal receipt-modal"><button className="modal-x" aria-label="Close receipt" onClick={()=>setLastSale(null)}><X size={18}/></button><span className="eyebrow">SALE COMPLETE · {lastPaymentMethod}</span><div className="pos-receipt-call"><span>Supabase receipt</span><strong>{lastSale.receiptNo}</strong></div><div className="receipt-paper"><div className="receipt-brand">Za by Zach<small>{lastSale.location}</small></div>{lastSale.lines.map((l,index)=><div className="receipt-row" key={`${l.sku}-${index}`}><span>{l.qty} × {itm(l.sku).name}</span></div>)}<div className="receipt-row"><span>Subtotal</span><b>{usd(lastSale.subtotal)}</b></div><div className="receipt-row"><span>Discount</span><b>−{usd(lastSale.discount)}</b></div><div className="receipt-row"><span>Tax</span><b>{usd(lastSale.tax)}</b></div><div className="receipt-row receipt-grand"><b>Total</b><b>{usd(lastSale.total)}</b></div>{lastSale.cardLast4&&<div className="receipt-row"><span>Paid with</span><b>{lastSale.cardBrand} ending {lastSale.cardLast4}</b></div>}{lastSale.rewardsBalance!=null&&<p className="receipt-rewards">Earned {lastSale.rewardsEarned??0} points · Balance {lastSale.rewardsBalance} points</p>}<small>Sale {lastSale.saleId} · {lastSale.date}</small></div><button className="button secondary full" onClick={()=>window.print()}><Printer size={16}/> Print receipt</button></div></div>}{camera&&<CameraScanner onClose={()=>setCamera(false)} onResult={value=>{scanSubmit(value);setCamera(false);}}/>}</div>;
}

function Orders({state,onCommit,flash}:{state:AppState;onCommit:(s:AppState)=>void;flash:(s:string)=>void}){
 const [showNew,setShowNew]=useState(false),[customer,setCustomer]=useState(customers[6]),[sku,setSku]=useState('2002'),[qty,setQty]=useState(40),[pickup,setPickup]=useState(new Date(Date.now()+7*86400000).toISOString().slice(0,10)),[pickupTime,setPickupTime]=useState('17:00'),[location,setLocation]=useState<Location>('Provo Campus Store');
 const create=()=>{const order:SalesOrder={id:'SO-'+Date.now().toString().slice(-6),customer,location,pickup,pickupTime,status:'Order Placed',lines:[{sku,qty}],notes:'Pickup order'};onCommit({...state,salesOrders:[order,...state.salesOrders]});setShowNew(false);flash(order.id+' created and added to MRP demand.');};
 const fulfill=(o:SalesOrder)=>{try{onCommit(fulfillSalesOrder(loadState(),o.id));flash(o.id+' marked as picked up.');}catch(e){flash((e as Error).message);}};
 return <><div className="stats-grid compact-stats"><StatCard label="Open orders" value={String(state.salesOrders.filter(o=>o.status==='Order Placed').length)} icon={ClipboardList} sub="Awaiting pickup"/><StatCard label="Next 4 weeks" value={String(state.salesOrders.filter(o=>o.status==='Order Placed'&&o.pickup>=today()).reduce((a,o)=>a+o.lines.reduce((n,l)=>n+l.qty,0),0))} icon={CalendarClock} accent="purple" sub="Units on confirmed demand"/><StatCard label="Fulfilled" value={String(state.salesOrders.filter(o=>o.status==='Fulfilled').length)} icon={PackageCheck} accent="green" sub="Orders completed"/><StatCard label="Locations" value="2" icon={Warehouse} sub="Pickup stores"/></div>
 <section className="panel"><div className="panel-head table-header"><div><h2>Sales orders</h2><p>Confirmed demand feeds the material requirements plan.</p></div><button className="button primary" onClick={()=>setShowNew(true)}><Plus size={15}/> Create order</button></div><div className="table-scroll"><table><thead><tr><th>ORDER</th><th>CUSTOMER</th><th>PICKUP</th><th>LOCATION</th><th>ITEMS</th><th>STATUS</th><th></th></tr></thead><tbody>{state.salesOrders.map(o=><tr key={o.id}><td><b className="mono">{o.id}</b><small className="cell-sub">{(o.notes||'Pickup')+(o.saleId?' · '+o.saleId:'')}{(o.discountPct||o.discountAmount)?' · '+(o.discountPct?o.discountPct+'% off':usd(o.discountAmount||0)+' off'):''}</small></td><td>{o.orderName||o.customer}{o.customerPhone&&<small className="cell-sub">{formatCustomerPhone(o.customerPhone)}</small>}{o.pickupNumber&&<small className="cell-sub">Pickup #{String(o.pickupNumber).padStart(3,'0')}</small>}{o.payment&&<small className="cell-sub">Paid · {usd(o.payment.amount)}</small>}</td><td>{dateLabel(o.pickup)}<small className="cell-sub">{pickupTimeLabel(o.pickupTime)} · {Math.max(0,Math.ceil((new Date(o.pickup).getTime()-Date.now())/86400000))} days</small></td><td>{o.location.split(' ')[0]}</td><td>{o.lines.reduce((a,l)=>a+l.qty,0)} {o.lines.length===1?itm(o.lines[0].sku).name:''}</td><td><span className={'status-chip '+(o.status==='Fulfilled'?'good':o.status==='Cancelled'?'bad':'info')}>{o.status}</span></td><td className="right">{o.status==='Order Placed'&&<button className="table-action" onClick={()=>fulfill(o)}><Check size={14}/> Mark picked up</button>}</td></tr>)}</tbody></table></div></section>
 {showNew&&<div className="modal-backdrop"><div className="modal form-modal"><button className="modal-x" onClick={()=>setShowNew(false)}><X size={18}/></button><span className="eyebrow">SALES ORDER</span><h2>Create a pickup order</h2><p>Confirmed orders become visible to MRP immediately.</p><label className="field-label">Customer</label><select value={customer} onChange={e=>setCustomer(e.target.value)}>{customers.map(c=><option key={c}>{c}</option>)}</select><div className="form-grid two"><div><label className="field-label">Pickup location</label><select value={location} onChange={e=>setLocation(e.target.value as Location)}>{locations.slice(0,2).map(x=><option key={x}>{x}</option>)}</select></div><div><label className="field-label">Pickup date</label><input type="date" min={today()} value={pickup} onChange={e=>setPickup(e.target.value)}/></div></div><div className="form-grid two"><div><label className="field-label">Pickup time</label><select value={pickupTime} onChange={e=>setPickupTime(e.target.value)}>{pickupSlots.map(t=><option key={t} value={t}>{pickupTimeLabel(t)}</option>)}</select></div><div><label className="field-label">Menu item</label><select value={sku} onChange={e=>setSku(e.target.value)}>{items.filter(i=>i.price>0).map(i=><option value={i.sku} key={i.sku}>{i.name}</option>)}</select></div></div><div className="form-grid two"><div><label className="field-label">Quantity</label><NumberInput type="number" min="1" value={qty} onChange={e=>setQty(Number(e.target.value))}/></div></div><div className="modal-actions"><button className="button secondary" onClick={()=>setShowNew(false)}>Cancel</button><button className="button primary" onClick={create}>Create order</button></div></div></div>}</>;
}
function SalesProfitLedger({state}:{state:AppState}){const [page,setPage]=useState(0);const rows=[...state.sales].sort((a,b)=>b.date.localeCompare(a.date));const fullDate=(value:string)=>new Date(value+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});const historyRange=rows.length?fullDate(rows[rows.length-1].date)+' – '+fullDate(rows[0].date):'No sales recorded yet';const pageCount=Math.max(1,Math.ceil(rows.length/15));const activePage=Math.min(page,pageCount-1);return <section className="panel table-panel sales-profit-ledger"><div className="panel-head"><div><h2>Sales & profit by order</h2><p>Original sale amounts. Returns and refunds are included in Profit & loss above.</p></div><div className="profit-history-range"><b>All recorded sales · {rows.length} records</b><span>{historyRange}</span></div></div><div className="table-scroll"><table><thead><tr><th>ORDER / CUSTOMER</th><th>DATE / STORE</th><th className="right">CUSTOMER PAID</th><th className="right">TAX</th><th className="right">NET SALES</th><th className="right">FOOD COST</th><th className="right">GROSS PROFIT</th></tr></thead><tbody>{rows.slice(activePage*15,activePage*15+15).map(sale=>{const amounts=saleBreakdown(sale),order=state.salesOrders.find(o=>o.saleId===sale.id);return <tr key={sale.id}><td><b>{order?.orderName||sale.pickupName||sale.customer||'Walk-in'}</b><small className="cell-sub">{order?.id||sale.id}</small></td><td>{dateLabel(sale.date)}<small className="cell-sub">{sale.location}</small></td><td className="right">{usd(amounts.total)}</td><td className="right">{usd(amounts.tax)}</td><td className="right">{usd(amounts.netSales)}</td><td className="right">{usd(amounts.cogs)}</td><td className="right"><b>{usd(amounts.grossProfit)}</b></td></tr>;})}</tbody></table></div>{!rows.length&&<div className="empty-inline">Your completed orders will appear here.</div>}<div className="profit-ledger-pages"><span>{rows.length} records · Page {activePage+1} of {pageCount}</span><button className="button secondary" disabled={activePage===0} onClick={()=>setPage(0)}>First</button><button className="button secondary" disabled={activePage===0} onClick={()=>setPage(activePage-1)}>Previous</button><button className="button secondary" disabled={activePage+1>=pageCount} onClick={()=>setPage(activePage+1)}>Next</button><button className="button secondary" disabled={activePage+1>=pageCount} onClick={()=>setPage(pageCount-1)}>Last</button></div></section>;}
function LatestCheckoutSummary({state}:{state:AppState}){const order=state.salesOrders.find(o=>o.saleId&&state.sales.some(s=>s.id===o.saleId));const sale=order?state.sales.find(s=>s.id===order.saleId):undefined;if(!sale||!order)return null;const gross=sale.lines.reduce((n,l)=>n+l.price*l.qty,0),net=gross-sale.discount,cost=sale.lines.reduce((n,l)=>n+l.cost*l.qty,0);return <section className="panel checkout-posted"><div className="panel-head"><div><h2>Latest local demo online sale</h2><p>{order.orderName||order.customer} · {order.id} · {sale.location}</p></div><span className="status-chip good">Local demo</span></div><div className="checkout-posted-grid">{[['Net sales',usd(net)],['Cost of goods sold',usd(cost)],['Gross profit',usd(net-cost)],['Sales tax',usd(sale.tax)]].map(([label,value])=><div key={label}><span>{label}</span><b>{value}</b></div>)}</div><p className="checkout-posted-note">{sale.id} · Browser-local checkout summary; excluded from Supabase totals below.</p></section>;}
type ReportSaleLine={id:string;sale_id:string;item_sku:string;quantity:number;unit_cost:number};
type ReportReturnLine={id:string;return_id:string;original_sale_id:string;original_sale_line_id:string;item_sku:string;quantity:number;disposition:'Restock'|'Waste';refund_subtotal:number;refund_tax:number;refund_total:number;cost_amount:number};
type ReportSale={id:string;location_id:string;location_name:string;subtotal:number;discount:number;tax:number;total:number;created_at:string;lines:ReportSaleLine[]};
type ReportReturn={id:string;transaction_type:'Return'|'Exchange';original_sale_id:string;replacement_sale_id:string|null;refund_subtotal:number;refund_tax:number;refund_total:number;replacement_total:number;created_at:string;lines:ReportReturnLine[]};
type SupabaseReportData={sales:ReportSale[];returns:ReportReturn[]};
async function loadSupabaseReportData():Promise<SupabaseReportData>{
 const pageSize=1000;
 async function readAllPages<T>(fetchPage:(from:number,to:number)=>PromiseLike<{data:T[]|null;error:{message:string}|null}>):Promise<T[]>{
  const rows:T[]=[];
  for(let from=0;;from+=pageSize){
   const {data,error}=await fetchPage(from,from+pageSize-1);
   if(error)throw new Error(error.message);
   const page=data??[];
   rows.push(...page);
   if(page.length<pageSize)return rows;
  }
 }
 type SaleRow=Omit<ReportSale,'location_name'|'lines'>;
 type SaleLineRow=ReportSaleLine;
 type ReturnRow=Omit<ReportReturn,'lines'>;
 type LocationRow={id:string;name:string};
 const salesRows=await readAllPages<SaleRow>((from,to)=>supabase.from('sales')
  .select('id,location_id,subtotal,discount,tax,total,created_at')
  .eq('status','Completed').order('created_at',{ascending:false}).order('id',{ascending:false}).range(from,to));
 const saleLines:SaleLineRow[]=[];
 for(let offset=0;offset<salesRows.length;offset+=100){
  const ids=salesRows.slice(offset,offset+100).map(row=>row.id);
  saleLines.push(...await readAllPages<SaleLineRow>((from,to)=>supabase.from('sale_lines')
   .select('id,sale_id,item_sku,quantity,unit_cost').in('sale_id',ids).order('id',{ascending:true}).range(from,to)));
 }
 const [returnRows,locationRows]=await Promise.all([
  readAllPages<ReturnRow>((from,to)=>supabase.from('sales_returns')
   .select('id,transaction_type,original_sale_id,replacement_sale_id,refund_subtotal,refund_tax,refund_total,replacement_total,created_at')
   .order('created_at',{ascending:false}).order('id',{ascending:false}).range(from,to)),
  readAllPages<LocationRow>((from,to)=>supabase.from('locations').select('id,name').order('id',{ascending:true}).range(from,to))
 ]);
 const returnLines:ReportReturnLine[]=[];
 for(let offset=0;offset<returnRows.length;offset+=100){
  const ids=returnRows.slice(offset,offset+100).map(row=>row.id);
  returnLines.push(...await readAllPages<ReportReturnLine>((from,to)=>supabase.from('sales_return_lines')
   .select('id,return_id,original_sale_id,original_sale_line_id,item_sku,quantity,disposition,refund_subtotal,refund_tax,refund_total,cost_amount')
   .in('return_id',ids).order('id',{ascending:true}).range(from,to)));
 }
 const linesBySale=new Map<string,ReportSaleLine[]>();
 for(const line of saleLines){
  const grouped=linesBySale.get(line.sale_id)??[];
  grouped.push({...line,quantity:Number(line.quantity),unit_cost:Number(line.unit_cost)});
  linesBySale.set(line.sale_id,grouped);
 }
 const locationsById=new Map(locationRows.map(row=>[row.id,row.name]));
 const sales:ReportSale[]=salesRows.map(row=>({
  ...row,subtotal:Number(row.subtotal),discount:Number(row.discount),tax:Number(row.tax),total:Number(row.total),
  location_name:locationsById.get(row.location_id)??row.location_id,lines:linesBySale.get(row.id)??[]
 }));
 const linesByReturn=new Map<string,ReportReturnLine[]>();
 for(const line of returnLines){
  const grouped=linesByReturn.get(line.return_id)??[];
  grouped.push({...line,quantity:Number(line.quantity),refund_subtotal:Number(line.refund_subtotal),refund_tax:Number(line.refund_tax),refund_total:Number(line.refund_total),cost_amount:Number(line.cost_amount)});
  linesByReturn.set(line.return_id,grouped);
 }
 const returns:ReportReturn[]=returnRows.map(row=>({
  ...row,refund_subtotal:Number(row.refund_subtotal),refund_tax:Number(row.refund_tax),refund_total:Number(row.refund_total),
  replacement_total:Number(row.replacement_total),lines:linesByReturn.get(row.id)??[]
 }));
 return{sales,returns};
}
function useSupabaseReportData(){
 const [data,setData]=useState<SupabaseReportData|null>(null);
 const [loading,setLoading]=useState(true);
 const [error,setError]=useState('');
 const [revision,setRevision]=useState(0);
 const retry=()=>{setData(null);setLoading(true);setError('');setRevision(value=>value+1);};
 useEffect(()=>{
  let active=true;
  void loadSupabaseReportData().then(result=>{
   if(active)setData(result);
  }).catch(reason=>{
   if(active)setError(reason instanceof Error?reason.message:'Unable to load Supabase sales and returns.');
  }).finally(()=>{
   if(active)setLoading(false);
  });
  return()=>{active=false;};
 },[revision]);
 return{data,loading,error,retry};
}
function Financials({state}:{state:AppState}){
 const {data,loading,error,retry}=useSupabaseReportData();
 const [dateRange,setDateRange]=useState<'All dates'|'Last 30 days'|'Last 7 days'>('All dates');
 if(loading)return <div className="panel"><div className="empty-inline">Loading sales and returns from Supabase…</div></div>;
 if(error||!data)return <div className="panel"><div className="login-error" role="alert">Unable to load financial sales and returns: {error||'No report data was returned.'}<button className="table-action" onClick={retry}>Retry</button></div></div>;
 const daysBack=dateRange==='Last 7 days'?6:dateRange==='Last 30 days'?29:null;
 const cutoff=new Date(`${today()}T12:00:00`);
 if(daysBack!==null)cutoff.setDate(cutoff.getDate()-daysBack);
 const cutoffKey=`${cutoff.getFullYear()}-${String(cutoff.getMonth()+1).padStart(2,'0')}-${String(cutoff.getDate()).padStart(2,'0')}`;
 const localDateKey=(createdAt:string)=>{
  const date=new Date(createdAt);
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
 };
 const inRange=(createdAt:string)=>{
  if(dateRange==='All dates')return true;
  const localDate=localDateKey(createdAt);
  return localDate>=cutoffKey&&localDate<=today();
 };
 const sales=data.sales.filter(sale=>inRange(sale.created_at));
 const returns=data.returns.filter(record=>inRange(record.created_at));
 const returnLines=returns.flatMap(record=>record.lines);
 const toCents=(amount:number)=>Math.round(amount*100);
 const formatCents=(cents:number)=>{
  const absolute=Math.abs(cents);
  return `${cents<0?'-':''}$${Math.floor(absolute/100).toLocaleString('en-US')}.${String(absolute%100).padStart(2,'0')}`;
 };
 const grossCents=sales.reduce((sum,sale)=>sum+toCents(sale.subtotal),0);
 const discountCents=sales.reduce((sum,sale)=>sum+toCents(sale.discount),0);
 const refundCents=returnLines.reduce((sum,line)=>sum+toCents(line.refund_subtotal),0);
 const netCents=grossCents-discountCents-refundCents;
 const taxCents=sales.reduce((sum,sale)=>sum+toCents(sale.tax),0)-returnLines.reduce((sum,line)=>sum+toCents(line.refund_tax),0);
 const originalCogsCents=sales.reduce((sum,sale)=>sum+sale.lines.reduce((lineSum,line)=>lineSum+toCents(line.quantity*line.unit_cost),0),0);
 const restockCostCents=returnLines.filter(line=>line.disposition==='Restock').reduce((sum,line)=>sum+toCents(line.cost_amount),0);
 const cogsCents=originalCogsCents-restockCostCents;
 const grossProfitCents=netCents-cogsCents;
 const localWasteCents=state.ledger.filter(entry=>entry.type==='Waste').reduce((sum,entry)=>sum+toCents(Math.abs(entry.qty*entry.unitCost)),0)+state.productionOrders.reduce((sum,order)=>sum+toCents(order.scrap*recipeCost(itm(order.sku))),0);
 const localLossCents=state.ledger.filter(entry=>entry.type==='Adjustment'&&entry.qty<0).reduce((sum,entry)=>sum+toCents(Math.abs(entry.qty*entry.unitCost)),0);
 const value=items.filter(item=>!item.recipe||item.makeToStock).reduce((sum,item)=>sum+inventory(state,item.sku)*(item.recipe?recipeCost(item):item.cost),0);
 const margin=netCents?grossProfitCents/netCents*100:0;
 const categories=['Ingredient','Packaging','Beverage','Sides'];
 return <><LatestCheckoutSummary state={state}/><div className="finance-banner"><div><span className="eyebrow">SUPABASE SALES & RETURNS</span><h2>All completed transactions</h2><p>Revenue and cost use persisted Supabase sales and returns. Local demo expenses and inventory are shown separately and excluded from this P&amp;L.</p></div><div className="range-select"><CalendarClock size={15}/><select value={dateRange} onChange={event=>setDateRange(event.target.value as typeof dateRange)}><option>All dates</option><option>Last 30 days</option><option>Last 7 days</option></select></div></div><div className="finance-grid"><section className="panel pnl-panel"><div className="panel-head"><div><h2>Profit & loss</h2><p>Supabase gross margin; local expenses excluded from operating income</p></div><span className="computed-tag"><Activity size={14}/> Live</span></div><div className="pnl-lines"><div className="pnl-line major"><span>Gross sales <small>Before discounts, excluding tax</small></span><b>{formatCents(grossCents)}</b></div><div className="pnl-line indent"><span>Discounts</span><b>− {formatCents(discountCents)}</b></div><div className="pnl-line indent"><span>Returns (subtotal)</span><b>− {formatCents(refundCents)}</b></div><div className="pnl-line total"><span>Net sales</span><b>{formatCents(netCents)}</b></div><div className="pnl-line"><span>Sales tax <small>Net of returned tax; not revenue</small></span><b>{formatCents(taxCents)}</b></div><div className="pnl-line"><span>Cost of goods sold</span><b>− {formatCents(cogsCents)}</b></div><div className="pnl-line gross-profit"><span>Gross profit <small>{margin.toFixed(1)}% margin</small></span><b>{formatCents(grossProfitCents)}</b></div><div className="pnl-line"><span>Local demo waste (not included)</span><b>{formatCents(localWasteCents)}</b></div><div className="pnl-line"><span>Local demo adjustment losses (not included)</span><b>{formatCents(localLossCents)}</b></div><div className="pnl-line operating"><span>Gross profit before local demo expenses</span><b>{formatCents(grossProfitCents)}</b></div></div></section><section className="panel valuation-panel"><div className="panel-head"><div><h2>Inventory valuation</h2><p>Browser-local demo on-hand × estimated cost</p></div><Warehouse size={17} className="muted-icon"/></div><div className="value-total"><span>Total local inventory value</span><b>{usd(value)}</b></div><div className="category-values">{categories.map(category=>{const categoryValue=items.filter(item=>item.category===category&&(!item.recipe||item.makeToStock)).reduce((sum,item)=>sum+inventory(state,item.sku)*(item.recipe?recipeCost(item):item.cost),0);return <div key={category}><span>{category}</span><div className="value-track"><i style={{width:`${value?Math.max(2,categoryValue/value*100):0}%`}}/></div><b>{usd(categoryValue)}</b></div>})}</div><div className="valuation-note"><Activity size={14}/> Local demo ledger only; not reconciled to Supabase returns.</div></section></div><section className="panel table-panel"><div className="panel-head"><div><h2>Value by location</h2><p>Browser-local inventory valuation, not Supabase</p></div></div><div className="table-scroll"><table><thead><tr><th>LOCATION</th><th className="right">UNITS ON HAND</th><th className="right">INVENTORY VALUE</th><th className="right">SHARE</th></tr></thead><tbody>{locations.map(location=>{const locationValue=items.filter(item=>!item.recipe||item.makeToStock).reduce((sum,item)=>sum+inventory(state,item.sku,location)*(item.recipe?recipeCost(item):item.cost),0);const units=items.filter(item=>!item.recipe||item.makeToStock).reduce((sum,item)=>sum+inventory(state,item.sku,location),0);return <tr key={location}><td><b>{location}</b></td><td className="right">{Math.round(units).toLocaleString()}</td><td className="right"><b>{usd(locationValue)}</b></td><td className="right">{value?(locationValue/value*100).toFixed(1):'0.0'}%</td></tr>})}</tbody></table></div></section></>;
}
function Reports({state,location}:{state:AppState;location:Location}){
 const {data,loading,error,retry}=useSupabaseReportData();
 if(loading)return <div className="panel"><div className="empty-inline">Loading sales and returns from Supabase…</div></div>;
 if(error||!data)return <div className="panel"><div className="login-error" role="alert">Unable to load sales and returns for reports: {error||'No report data was returned.'}<button className="table-action" onClick={retry}>Retry</button></div></div>;
 const returnedByLine=new Map<string,number>();
 for(const record of data.returns)for(const line of record.lines){
  returnedByLine.set(line.original_sale_line_id,(returnedByLine.get(line.original_sale_line_id)??0)+line.quantity);
 }
 const salesById=new Map(data.sales.map(sale=>[sale.id,sale]));
 const returnSubtotalByDay=new Map<string,number>();
 for(const record of data.returns){
  if(salesById.get(record.original_sale_id)?.location_name!==location)continue;
  const date=record.created_at.slice(0,10);
  const subtotal=record.lines.reduce((sum,line)=>sum+line.refund_subtotal,0);
  returnSubtotalByDay.set(date,(returnSubtotalByDay.get(date)??0)+subtotal);
 }
 const chart=Array.from({length:7},(_,index)=>{
  const day=new Date(Date.now()-(6-index)*86400000);
  const key=day.toISOString().slice(0,10);
  const daySales=data.sales.filter(sale=>sale.created_at.slice(0,10)===key&&sale.location_name===location);
  const net=daySales.reduce((sum,sale)=>sum+sale.subtotal-sale.discount,0)-(returnSubtotalByDay.get(key)??0);
  return{date:day.toLocaleDateString('en-US',{weekday:'short'}),net};
 });
 const top=items.filter(item=>item.price>0).map(item=>({
  item,
  units:Math.max(0,data.sales.reduce((sum,sale)=>sum+sale.lines.filter(line=>line.item_sku===item.sku).reduce((lineSum,line)=>lineSum+line.quantity-(returnedByLine.get(line.id)??0),0),0))
 })).sort((a,b)=>b.units-a.units).slice(0,6);
 const lows=items.filter(item=>!item.recipe&&inventory(state,item.sku)<reorderPoint(state,item));
 const localWaste=state.ledger.filter(entry=>entry.type==='Waste').reduce((sum,entry)=>sum+Math.abs(entry.qty*entry.unitCost),0);
 return <><div className="report-controls"><span className="computed-tag">{location} · Supabase net sales through {dateLabel(today())}</span><span className="computed-tag">Sales, discounts, returns and returned units from Supabase; inventory remains local</span></div><div className="reports-grid"><section className="panel report-chart"><div className="panel-head"><div><h2>Sales by day</h2><p>Net sales before tax, after discounts and returns · past 7 days</p></div><BarChart3 size={17} className="muted-icon"/></div><div className="chart-box tall"><ResponsiveContainer width="100%" height="100%"><BarChart data={chart} margin={{top:8,right:8,left:-20,bottom:0}}><CartesianGrid strokeDasharray="4 4" vertical={false} stroke="#edf1f5"/><XAxis dataKey="date" axisLine={false} tickLine={false} tick={{fontSize:10,fill:'#8894a2'}}/><YAxis axisLine={false} tickLine={false} tick={{fontSize:10,fill:'#8894a2'}} tickFormatter={value=>`$${Math.round(value/1000)}k`}/><Tooltip formatter={(value:any)=>usd(value)}/><Bar dataKey="net" fill="#1d67a6" radius={[4,4,0,0]}/></BarChart></ResponsiveContainer></div></section><section className="panel report-top"><div className="panel-head"><div><h2>Top-selling items</h2><p>Net units after returns · all recorded history</p></div><span className="computed-tag">Ranked</span></div><div className="top-items">{top.map(({item,units},index)=><div className="top-item" key={item.sku}><span className="top-rank">{String(index+1).padStart(2,'0')}</span><div className="top-item-copy"><b>{item.name}</b><small>{units.toLocaleString()} units</small></div><div className="top-bar"><i style={{width:`${top[0]?.units?units/top[0].units*100:0}%`}}/></div></div>)}</div></section><section className="panel report-low"><div className="panel-head"><div><h2>Low stock</h2><p>Browser-local demo inventory below calculated reorder point</p></div><AlertTriangle size={17} className="amber-text"/></div>{lows.length?lows.map(item=><div className="low-row" key={item.sku}><div><b>{item.name}</b><small>ROP {Math.ceil(reorderPoint(state,item)).toLocaleString()} {item.unit}</small></div><span className="text-red">{Math.round(inventory(state,item.sku)).toLocaleString()} on hand</span><b>{Math.ceil(eoq(state,item)/item.factor)} {item.pack}</b></div>):<div className="empty-inline">All local demo items are at or above their reorder points.</div>}</section><section className="panel report-waste"><div className="panel-head"><div><h2>Waste & quality</h2><p>Browser-local demo losses posted by reason code</p></div><RotateCcw size={17} className="muted-icon"/></div><div className="waste-summary"><b>{usd(localWaste)}</b><span>Local demo waste cost; not in Supabase P&amp;L</span></div><div className="reason-chips">{['Spoiled/Expired','Damaged','Cycle count correction'].map(reason=><div key={reason}><span>{reason}</span><b>{state.ledger.filter(entry=>entry.reason===reason).length}</b></div>)}</div></section></div></>;
}
function FinancialsPage({state}:{state:AppState}){return <><Financials state={state}/><SharedPurchasingScreen view="Payables" flash={()=>{}}/><details className="panel p-note"><summary><b>Browser project history (separate demo records)</b></summary><p>These records are stored in this browser. They are separate from, and excluded from, the Supabase financial totals above.</p><SalesProfitLedger state={state}/></details></>;}
function CustomerAvailabilitySettings({userId}:{userId:string}){
 const [settings,setSettings]=useState<{revision:number;minimum_recipe_servings:number;minimum_standalone_units:number}|null>(null);
 const [error,setError]=useState('');const [busy,setBusy]=useState(false);const [saved,setSaved]=useState(false);
 const refresh=useCallback(async()=>{const {data,error}=await supabase.rpc('erp_customer_availability_options_read',{});if(error){setError(error.message);return;}if(data&&typeof data==='object'&&typeof (data as Record<string,unknown>).revision==='number'){setSettings(data as typeof settings);setError('');}},[]);
 useEffect(()=>{void refresh();},[refresh,userId]);
 const save=async(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();if(!settings||busy)return;const form=new FormData(event.currentTarget),servings=Number(form.get('minimum_recipe_servings')),units=Number(form.get('minimum_standalone_units'));if(!Number.isFinite(servings)||!Number.isFinite(units)){setError('Enter valid minimum thresholds.');return;}setBusy(true);setError('');setSaved(false);try{const {data,error}=await supabase.rpc('erp_customer_availability_options_save',{p_revision:settings.revision,p_minimum_recipe_servings:servings,p_minimum_standalone_units:units});if(error)throw error;if(!data||typeof data!=='object')throw new Error('The settings response could not be verified.');setSettings(data as typeof settings);setSaved(true);}catch(error){setError(error instanceof Error?error.message:'Availability settings could not be saved.');}finally{setBusy(false);}};
 return <section className="panel settings-panel customer-availability-settings"><div className="panel-head"><div><h2>Customer availability · fallback low-stock thresholds</h2><p>Managers can set a shared fallback used only when the store’s usage history cannot produce a reorder point.</p></div></div>{settings?<form key={settings.revision} onSubmit={save}><div className="settings-grid"><label className="setting-row"><span><b>Minimum recipe servings</b><small>For recipe components, the largest amount required by one pizza recipe is multiplied by this setting.</small></span><span className="setting-control"><input name="minimum_recipe_servings" type="number" min="0.25" max="100" step="0.25" defaultValue={settings.minimum_recipe_servings} required/><span>servings</span></span></label><label className="setting-row"><span><b>Minimum standalone units</b><small>Used for sellable items without an applicable reorder point.</small></span><span className="setting-control"><input name="minimum_standalone_units" type="number" min="0.25" max="100" step="0.25" defaultValue={settings.minimum_standalone_units} required/><span>units</span></span></label></div><p className="p-muted">Zero stock is always Unavailable. Any positive stock at or below the calculated threshold is Low stock.</p><button className="button primary" disabled={busy}>{busy?'Saving thresholds…':'Save customer thresholds'}</button>{saved&&<p role="status" className="review-success">Shared customer availability thresholds saved.</p>}</form>:<p>Loading shared availability thresholds…</p>}{error&&<p className="checkout-error" role="alert">{error} <button className="button secondary" type="button" onClick={()=>void refresh()}>Retry</button></p>}</section>;
}
function SettingsPage({state,onCommit,flash,userId,canManage}:{state:AppState;onCommit:(s:AppState)=>void;flash:(m:string)=>void;userId:string;canManage:boolean}){const [tax,setTax]=useState(state.settings.tax*100);const [order,setOrder]=useState(state.settings.orderCost);const [holding,setHolding]=useState(state.settings.holding*100);const [safety,setSafety]=useState(state.settings.safetyDays);const [reviewDays,setReviewDays]=useState(state.settings.reviewDays??7);const save=()=>{if(![tax,order,holding,safety,reviewDays].every(Number.isFinite)||tax<0||tax>20||order<0||holding<=0||holding>100||safety<0||!Number.isInteger(safety)||reviewDays<1||!Number.isInteger(reviewDays)){flash('Use a holding rate above 0%, nonnegative costs, and whole-day safety/review intervals.');return;}onCommit({...state,settings:{...state.settings,tax:tax/100,orderCost:order,holding:holding/100,safetyDays:safety,reviewDays}});flash('Browser operating assumptions saved. Shared ordering options are saved separately above.');};return <>{canManage&&<CustomerAvailabilitySettings key={userId} userId={userId}/>}<SharedPurchasingScreen view="Ordering options" flash={flash}/><div className="settings-layout"><section className="panel settings-panel"><div className="panel-head"><div><h2>Operating assumptions · browser demo</h2><p>These browser values drive checkout and legacy demo calculations. Shared Inventory Review uses the ordering options above.</p></div><Settings2 size={18} className="muted-icon"/></div><div className="settings-grid"><div className="setting-row"><div><b>Sales tax rate</b><small>Applied to each completed ticket after discounts</small></div><div className="setting-control"><NumberInput type="number" step=".01" min="0" max="20" value={tax} onChange={e=>setTax(Number(e.target.value))}/><span>%</span></div></div><div className="setting-row"><div><b>Ordering cost per PO</b><small>Used as S in the EOQ calculation</small></div><div className="setting-control"><span>$</span><NumberInput type="number" min="0" value={order} onChange={e=>setOrder(Number(e.target.value))}/></div></div><div className="setting-row"><div><b>Annual holding cost</b><small>Percentage of current weighted average cost</small></div><div className="setting-control"><NumberInput type="number" min="0" max="100" value={holding} onChange={e=>setHolding(Number(e.target.value))}/><span>%</span></div></div><div className="setting-row"><div><b>Safety stock coverage</b><small>Additional average usage days in reorder point</small></div><div className="setting-control"><NumberInput type="number" min="0" max="90" value={safety} onChange={e=>setSafety(Number(e.target.value))}/><span>days</span></div></div></div><div className="setting-row"><div><b>Manual inventory review interval</b><small>How often the manager reviews purchase recommendations</small></div><div className="setting-control"><NumberInput type="number" min="1" max="90" value={reviewDays} onChange={e=>setReviewDays(Number(e.target.value))}/><span>days</span></div></div><div className="settings-formula"><b>Current formulas</b><span>Reorder point = average daily usage × (lead time + safety stock days)</span><span>EOQ = √(2 × annual demand × ordering cost ÷ annual holding cost)</span><span>Perishable cap = daily usage × shelf life</span></div><button className="button primary" onClick={save}>Save assumptions <Check size={15}/></button></section><section className="panel reason-panel"><div className="panel-head"><div><h2>Reason codes</h2><p>Recorded on stock loss and quality events</p></div></div><div className="reason-group"><b>Adjustments</b>{['Cycle count correction','Spoiled/Expired','Damaged','Dropped/Spilled','Theft/Unknown loss'].map(x=><span key={x}><Check size={13}/>{x}</span>)}</div><div className="reason-group"><b>Returns</b>{['Burnt','Undercooked','Wrong order','Cold on pickup','Damaged packaging','Customer changed mind'].map(x=><span key={x}><Check size={13}/>{x}</span>)}</div></section></div></>;}
function About({state,onCommit,flash,role}:{state:AppState;onCommit:(s:AppState)=>void;flash:(m:string)=>void;role:Role}){const integrity=items.filter(i=>!i.recipe||i.makeToStock).flatMap(i=>locations.map(l=>({sku:i.sku,loc:l,ledger:inventory(state,i.sku,l)})));const runIntegrity=()=>{const bad=integrity.filter(x=>!Number.isFinite(x.ledger));flash(bad.length?'Integrity check found a quantity issue.':'Integrity check passed: on-hand is calculated directly from ledger entries.');};const reset=()=>{if(role!=='Manager'){flash('Only a manager can reset demo data.');return;}if(window.confirm('Reset all demo transactions and reload the seeded data? This clears changes saved in this browser.')){const fresh=resetState();onCommit(fresh);flash('Demo data reset to the seeded opening state.');}};return <><div className="about-banner"><div className="about-brand-mark">Z<span>+</span></div><div><span className="eyebrow">SYSTEM OVERVIEW</span><h2>Za by Zach ERP</h2><p>A connected restaurant operations demo built for ERP coursework and live scenario walkthroughs.</p></div><span className="version-pill">DEMO · 1.0</span></div><div className="about-grid"><section className="panel about-card"><span className="about-icon blue"><Boxes size={18}/></span><h3>Integrated data model</h3><p>Nested bills of material connect sales, in-house dough production, component usage, stock balances, purchase receipts, and cost rollups. The inventory transaction ledger is the source used to calculate on-hand quantity.</p><div className="about-tags"><span>{items.length} items</span><span>{items.filter(i=>i.recipe).length} recipes</span><span>{locations.length} locations</span><span>{suppliers.length} suppliers</span></div></section><section className="panel about-card"><span className="about-icon green"><Activity size={18}/></span><h3>Calculation rules</h3><p>Menu-item cost rolls through nested bills of material, including the current in-house dough recipe. Reorder points use trailing demand and supplier lead time; EOQ includes editable ordering and holding costs and a shelf-life cap.</p><div className="about-tags"><span>Weighted average</span><span>Ledger-derived stock</span><span>Four-week dough + ingredient MRP</span></div></section><section className="panel about-card"><span className="about-icon purple"><ShieldCheck size={18}/></span><h3>Tools & libraries</h3><p>The demo UI uses React, TypeScript, Vite, Recharts, and Lucide icons. It generates Code 128 labels directly and uses the browser BarcodeDetector API for camera scans where supported. Purchasing includes supplier records, per-delivery receipts, invoices, payments, and review history. Pizza Guide uses built-in help and live app records. A Supabase schema and RPC migration is included as a starting backend.</p><div className="about-tags"><span>React</span><span>Recharts</span><span>Code 128</span><span>Supabase SQL</span></div></section><section className="panel about-card"><span className="about-icon amber"><Activity size={18}/></span><h3>Demo data & persistence</h3><p>This published demo stores its working dataset in this browser’s local storage, including at least six full calendar months of sample history and estimated daily counter sales and replenishments for recent trading days. Your orders and purchases are added to the same records; refreshing does not replace them. These browser records are separate from the connected Inventory, Transfers & Counts, and Production screens. They are not synchronized across devices.</p><div className="about-tags"><span>Browser-local demo</span><span>{state.ledger.length.toLocaleString()} ledger rows</span><span>Multi-tab sync</span></div></section></div><section className="panel admin-tools"><div><span className="eyebrow">MANAGER TOOLS</span><h2>Verify and restore demo data</h2><p>Run the stock balance check or return the browser demo to its original scenario.</p></div><div className="admin-actions"><button className="button secondary" onClick={runIntegrity}><ShieldCheck size={15}/> Run integrity check</button><button className="button danger-outline" onClick={reset}><RotateCcw size={15}/> Reset demo data</button></div></section><div className="about-note"><AlertTriangle size={16}/><span>Supabase sign-in, POS checkout, Returns & Exchanges, Inventory, Transfers & Counts, and Production use your existing database connections. Financials and Reports use shared Supabase sales, returns, expenses, inventory ledger and purchasing records, with automatic refresh. Purchasing, supplier scorecards, payments, and inventory reviews use shared Supabase records. Pickup orders and MRP use shared confirmed demand. Online payments remain simulated; ingredients leave stock at preparation or fulfillment. Historical browser planning records remain separate. POS rewards use shared customer accounts and server-validated redemption. Customized server checkout remains unsupported.</span></div></>}


const BarcodeLabelsView=memo(BarcodeLabelsScreen);
const DashboardView=memo(Dashboard);
const POSView=memo(POS);
const OrdersView=memo(Orders);
function SalesOrdersTabs({flash,onStartReturn}:{flash:(message:string)=>void;onStartReturn:(saleId:string)=>void}){
 const [tab,setTab]=useState<'orders'|'history'>('orders');
 return <><div className="p-row-actions" style={{marginBottom:12}}><button className={tab==='orders'?'button primary':'button secondary'} onClick={()=>setTab('orders')}>Pickup orders &amp; fulfillment</button><button className={tab==='history'?'button primary':'button secondary'} onClick={()=>setTab('history')}>All orders &amp; receipts</button></div>{tab==='orders'?<SharedOrdersScreen flash={flash}/>:<OrderHistory flash={flash} onStartReturn={onStartReturn}/>}</>;
}
const ReturnsPageView=memo(SupabaseReturnsPage);
const SuppliersScreenView=memo(SuppliersScreen);
const InventoryReviewScreenView=memo(InventoryReviewScreen);
const PurchaseOrdersScreenView=memo(PurchaseOrdersScreen);
const SupplierScorecardsScreenView=memo(SupplierScorecardsScreen);

const FinancialsView=memo(FinancialsPage);
const ReportsView=memo(Reports);
const SettingsPageView=memo(SettingsPage);
const AboutView=memo(About);
function SupabaseReturnsPage({flash,initialSaleId,onInitialSaleUsed}:{flash:(message:string)=>void;initialSaleId?:string|null;onInitialSaleUsed?:()=>void}){
 type ReturnRequestDetails={transactionType:'Return'|'Exchange';saleLineId:string;quantity:number;reason:string;disposition:'Restock'|'Waste';replacementLines:{sku:string;qty:number}[]|null};
 type PendingReturnRequest={requestId:string;signature:string;details:ReturnRequestDetails};
 const pendingStorageKey='zbyZach-pending-returns-v1';
 const [sales,setSales]=useState<ReturnSale[]>([]);
 const [history,setHistory]=useState<ReturnHistory[]>([]);
 const [saleId,setSaleId]=useState('');
 const [saleLineId,setSaleLineId]=useState('');
 const [transactionType,setTransactionType]=useState<'Return'|'Exchange'>('Return');
 const [quantity,setQuantity]=useState(1);
 const [reason,setReason]=useState('Burnt');
 const [disposition,setDisposition]=useState<'Restock'|'Waste'>('Waste');
 const [replacementSku,setReplacementSku]=useState(items.find(item=>item.price>0)?.sku??'');
 const [replacementQuantity,setReplacementQuantity]=useState(1);
 const [loading,setLoading]=useState(true);
 const [submitting,setSubmitting]=useState(false);
 const [loadError,setLoadError]=useState('');
 const [actionError,setActionError]=useState('');
 const [requestStorageReady,setRequestStorageReady]=useState(false);
 const [requestStorageError,setRequestStorageError]=useState('');
 const [lastResult,setLastResult]=useState<ReturnRpcResult|null>(null);
 const loadVersion=useRef(0);
 const pendingRequests=useRef(new Map<string,PendingReturnRequest>());

 const refreshData=useCallback(async()=>{
  const version=++loadVersion.current;
  setLoading(true);
  setLoadError('');
  try{
   const pageSize=1000;
   async function readAllPages<T>(fetchPage:(from:number,to:number)=>PromiseLike<{data:T[]|null;error:{message:string}|null}>):Promise<T[]>{
    const rows:T[]=[];
    for(let from=0;;from+=pageSize){
     const {data,error}=await fetchPage(from,from+pageSize-1);
     if(error)throw new Error(error.message);
     const page=data??[];
     rows.push(...page);
     if(page.length<pageSize)return rows;
    }
   }
   type SaleRow={id:string;receipt_no:string;location_id:string;customer_id:string|null;total:number;status:string;created_at:string};
   type SaleLineRow={id:string;sale_id:string;item_sku:string;quantity:number};
   type ReturnRow={id:string;transaction_type:'Return'|'Exchange';original_sale_id:string;replacement_sale_id:string|null;refund_total:number;replacement_total:number;settlement_net:number;settlement_mode:string;created_at:string};
   type LocationRow={id:string;name:string};
   const saleRows=await readAllPages<SaleRow>((from,to)=>supabase.from('sales')
    .select('id,receipt_no,location_id,customer_id,total,status,created_at')
    .eq('status','Completed').order('created_at',{ascending:false}).order('id',{ascending:false}).range(from,to));
   const lineRows:SaleLineRow[]=[];
   for(let index=0;index<saleRows.length;index+=100){
    const saleIds=saleRows.slice(index,index+100).map(row=>row.id);
    lineRows.push(...await readAllPages<SaleLineRow>((from,to)=>supabase.from('sale_lines')
     .select('id,sale_id,item_sku,quantity').in('sale_id',saleIds).order('id',{ascending:true}).range(from,to)));
   }
   const [returnRows,locationRows]=await Promise.all([
    readAllPages<ReturnRow>((from,to)=>supabase.from('sales_returns')
     .select('id,transaction_type,original_sale_id,replacement_sale_id,refund_total,replacement_total,settlement_net,settlement_mode,created_at')
     .order('created_at',{ascending:false}).order('id',{ascending:false}).range(from,to)),
    readAllPages<LocationRow>((from,to)=>supabase.from('locations').select('id,name').order('id',{ascending:true}).range(from,to))
   ]);
   const returnLineRows:ReturnHistoryLine[]=[];
   for(let index=0;index<returnRows.length;index+=100){
    const returnIds=returnRows.slice(index,index+100).map(row=>row.id);
    returnLineRows.push(...await readAllPages<ReturnHistoryLine>((from,to)=>supabase.from('sales_return_lines')
     .select('id,return_id,original_sale_id,original_sale_line_id,item_sku,quantity,reason_code,disposition,refund_total,cost_amount')
     .in('return_id',returnIds).order('id',{ascending:true}).range(from,to)));
   }
   const linesBySale=new Map<string,ReturnSaleLine[]>();
   for(const row of lineRows){
    const lines=linesBySale.get(row.sale_id)??[];
    lines.push({id:row.id,item_sku:row.item_sku,quantity:Number(row.quantity)});
    linesBySale.set(row.sale_id,lines);
   }
   const locationNames=new Map(locationRows.map(row=>[row.id,row.name]));
   const refreshedSales:ReturnSale[]=saleRows.map(row=>({
    ...row,location_name:locationNames.get(row.location_id)??row.location_id,
    lines:linesBySale.get(row.id)??[]
   }));
   const linesByReturn=new Map<string,ReturnHistoryLine[]>();
   for(const row of returnLineRows){
    const lines=linesByReturn.get(row.return_id)??[];
    lines.push({...row,quantity:Number(row.quantity),refund_total:Number(row.refund_total),cost_amount:Number(row.cost_amount)});
    linesByReturn.set(row.return_id,lines);
   }
   const refreshedHistory:ReturnHistory[]=returnRows.map(row=>({
    ...row,refund_total:Number(row.refund_total),replacement_total:Number(row.replacement_total),
    settlement_net:Number(row.settlement_net),lines:linesByReturn.get(row.id)??[]
   }));
   if(version===loadVersion.current){
    setSales(refreshedSales);
    setHistory(refreshedHistory);
   }
   return true;
  }catch(error){
   if(version===loadVersion.current)setLoadError(`Unable to load Supabase returns data: ${error instanceof Error?error.message:String(error)}`);
   return false;
  }finally{
   if(version===loadVersion.current)setLoading(false);
  }
 },[]);
 useEffect(()=>{void refreshData();return()=>{loadVersion.current++;};},[refreshData]);
 useEffect(()=>{
  try{
   const serialized=sessionStorage.getItem(pendingStorageKey);
   if(serialized){
    const parsed:unknown=JSON.parse(serialized);
    if(!Array.isArray(parsed))throw new Error('Pending request storage is not a list.');
    for(const entry of parsed){
     if(!entry||typeof entry!=='object')throw new Error('Pending request storage contains an invalid entry.');
     const stored=entry as Record<string,unknown>;
     const details=stored.details as Record<string,unknown>|null;
     const replacements=details?.replacementLines;
     const validReplacements=replacements===null||(Array.isArray(replacements)&&replacements.every(line=>
      !!line&&typeof line==='object'&&typeof (line as Record<string,unknown>).sku==='string'&&
      typeof (line as Record<string,unknown>).qty==='number'&&Number.isFinite((line as Record<string,unknown>).qty)
     ));
     if(typeof stored.requestId!=='string'||typeof stored.signature!=='string'||!details||
        (details.transactionType!=='Return'&&details.transactionType!=='Exchange')||
        typeof details.saleLineId!=='string'||typeof details.quantity!=='number'||!Number.isFinite(details.quantity)||
        typeof details.reason!=='string'||(details.disposition!=='Restock'&&details.disposition!=='Waste')||
        !validReplacements||JSON.stringify(details)!==stored.signature){
      throw new Error('Pending request storage contains invalid or mismatched request details.');
     }
     pendingRequests.current.set(stored.signature,entry as PendingReturnRequest);
    }
   }
  }catch(error){
   setRequestStorageError(`Unable to restore pending return requests: ${error instanceof Error?error.message:String(error)}`);
  }finally{
   setRequestStorageReady(true);
  }
 },[]);

 const returnedByLine=useMemo(()=>{
  const quantities=new Map<string,number>();
  for(const record of history)for(const line of record.lines)
   quantities.set(line.original_sale_line_id,(quantities.get(line.original_sale_line_id)??0)+line.quantity);
  return quantities;
 },[history]);
 const remaining=(line:ReturnSaleLine)=>Math.max(0,line.quantity-(returnedByLine.get(line.id)??0));
 const returnableSales=useMemo(()=>sales.filter(sale=>sale.lines.some(line=>remaining(line)>0)),[sales,returnedByLine]);
 const sale=returnableSales.find(row=>row.id===saleId);
 const returnableLines=useMemo(()=>sale?.lines.filter(line=>remaining(line)>0)??[],[sale,returnedByLine]);
 const selectedLine=returnableLines.find(line=>line.id===saleLineId);
 const availableQuantity=selectedLine?remaining(selectedLine):0;
 const catalogItem=items.find(item=>item.sku===selectedLine?.item_sku);
 const restockable=catalogItem?.sku==='1017'||catalogItem?.category==='Beverage';
 useEffect(()=>{
  if(!returnableSales.some(row=>row.id===saleId)){
   const firstSale=returnableSales[0];
   setSaleId(firstSale?.id??'');
   setSaleLineId(firstSale?.lines.find(line=>remaining(line)>0)?.id??'');
   setQuantity(1);
  }else if(!returnableLines.some(line=>line.id===saleLineId)){
   setSaleLineId(returnableLines[0]?.id??'');
   setQuantity(1);
  }else if(selectedLine&&quantity>availableQuantity){
   setQuantity(availableQuantity);
  }
 },[returnableSales,returnableLines,saleId,saleLineId,selectedLine,quantity,availableQuantity,returnedByLine]);

 const initialSaleHandled=useRef<string|null>(null);
 useEffect(()=>{if(!initialSaleId||initialSaleHandled.current===initialSaleId)return;if(returnableSales.some(row=>row.id===initialSaleId)){initialSaleHandled.current=initialSaleId;chooseSale(initialSaleId);onInitialSaleUsed?.();}},[initialSaleId,returnableSales]); // eslint-disable-line react-hooks/exhaustive-deps
 const chooseSale=(id:string)=>{
  const chosen=returnableSales.find(row=>row.id===id);
  setSaleId(id);
  setSaleLineId(chosen?.lines.find(line=>remaining(line)>0)?.id??'');
  setQuantity(1);
  setLastResult(null);
 };
 const chooseLine=(id:string)=>{
  setSaleLineId(id);
  setQuantity(1);
  setLastResult(null);
 };
 const submit=async()=>{
  if(!requestStorageReady||requestStorageError){
   setActionError(requestStorageError||'Pending request IDs are still being restored. Try again shortly.');
   return;
  }
  if(!sale||!selectedLine||!Number.isFinite(quantity)||quantity<=0||quantity>availableQuantity){
   setActionError('Choose a returnable sale line and a quantity within the remaining amount.');
   return;
  }
  if(transactionType==='Exchange'&&(!replacementSku||!Number.isFinite(replacementQuantity)||replacementQuantity<=0)){
   setActionError('Choose a replacement item and a positive quantity.');
   return;
  }
  const effectiveDisposition=restockable?disposition:'Waste';
  const replacementLines=transactionType==='Exchange'?[{sku:replacementSku,qty:replacementQuantity}]:null;
  const details:ReturnRequestDetails={transactionType,saleLineId:selectedLine.id,quantity,reason,disposition:effectiveDisposition,replacementLines};
  const signature=JSON.stringify(details);
  const request=pendingRequests.current.get(signature)??{requestId:crypto.randomUUID(),signature,details};
  pendingRequests.current.set(signature,request);
  try{
   sessionStorage.setItem(pendingStorageKey,JSON.stringify([...pendingRequests.current.values()]));
  }catch(error){
   setActionError(`Unable to persist the pending request ID; no RPC was sent: ${error instanceof Error?error.message:String(error)}`);
   return;
  }
  setSubmitting(true);
  setActionError('');
  try{
   const response=transactionType==='Exchange'
    ?await supabase.rpc('process_exchange',{
      p_request_id:request.requestId,p_sale_line_id:selectedLine.id,p_quantity:quantity,
      p_reason_code:reason,p_disposition:effectiveDisposition,p_replacement_lines:replacementLines
     })
    :await supabase.rpc('process_return',{
      p_request_id:request.requestId,p_sale_line_id:selectedLine.id,p_quantity:quantity,
      p_reason_code:reason,p_disposition:effectiveDisposition
     });
   if(response.error)throw response.error;
   if(!isReturnRpcResult(response.data)){
    setActionError('The server response was unclear. Retry without changing the request details to safely reuse its request ID.');
    return;
   }
   pendingRequests.current.delete(signature);
   let requestStorageWarning='';
   try{
    sessionStorage.setItem(pendingStorageKey,JSON.stringify([...pendingRequests.current.values()]));
   }catch(error){
    pendingRequests.current.set(signature,request);
    requestStorageWarning=` The RPC succeeded, but its pending request ID could not be cleared from session storage: ${error instanceof Error?error.message:String(error)}.`;
   }
   setLastResult(response.data);
   const refreshed=await refreshData();
   if(refreshed)flash(response.data.transaction_type==='Exchange'?'Exchange recorded with manual/simulated settlement. No payment was processed.':'Return recorded as a manual/simulated refund. No payment was processed.');
   if(requestStorageWarning||!refreshed)setActionError(`${requestStorageWarning}${refreshed?'':' The transaction was recorded, but the page could not refresh. Use Retry to reload the Supabase data.'}`.trim());
  }catch(error){
   const message=error instanceof Error?error.message:String(error);
   setActionError(`Unable to process ${transactionType.toLowerCase()}: ${message}. If the result is uncertain, retry with the same details to reuse the request ID.`);
   flash(`Unable to process ${transactionType.toLowerCase()}: ${message}`);
  }finally{
   setSubmitting(false);
  }
 };
 const returnedQuantity=history.reduce((sum,record)=>sum+record.lines.reduce((lineSum,line)=>lineSum+line.quantity,0),0);
 const refunds=history.reduce((sum,record)=>sum+record.refund_total,0);
 const restockCount=history.reduce((sum,record)=>sum+record.lines.filter(line=>line.disposition==='Restock').length,0);
 const wasteCount=history.reduce((sum,record)=>sum+record.lines.filter(line=>line.disposition==='Waste').length,0);
 const saleLabel=(id:string)=>sales.find(row=>row.id===id)?.receipt_no??id;
 const itemName=(sku:string)=>items.find(item=>item.sku===sku)?.name??sku;
 const settlementLabel=(amount:number)=>amount>0?`Amount due ${usd(amount)}`:amount<0?`Customer credit ${usd(-amount)}`:'No net amount due or credit';
 return <>{loadError&&<div className="login-error" role="alert">{loadError}<button className="table-action" disabled={loading} onClick={()=>void refreshData()}>Retry</button></div>}
  <div className="stats-grid compact-stats">
   <StatCard label="Return / exchange records" value={String(history.length)} icon={RotateCcw} sub="Persisted in Supabase"/>
   <StatCard label="Refunds recorded" value={usd(refunds)} icon={CircleDollarSign} accent="amber" sub="Manual / simulated accounting"/>
   <StatCard label="Waste lines" value={String(wasteCount)} icon={AlertTriangle} accent="red" sub={`${returnedQuantity} units returned`}/>
   <StatCard label="Restock lines" value={String(restockCount)} icon={PackageCheck} accent="green" sub="Inventory returned through RPC"/>
  </div>
  <div className="movement-layout">
   <section className="panel movement-form">
    <div className="form-section-title"><span className="step-index">01</span><div><h2>Process a return or exchange</h2><p>Select a completed Supabase sale line and record its reason and disposition.</p></div></div>
    <div className="tab-switch">{(['Return','Exchange'] as const).map(value=><button type="button" key={value} className={transactionType===value?'selected':''} onClick={()=>{setTransactionType(value);setLastResult(null);}}>{value==='Return'?<RotateCcw size={15}/>:<ArrowLeftRight size={15}/>} {value}</button>)}</div>
    <label className="field-label">Original receipt</label>
    <select value={saleId} onChange={event=>chooseSale(event.target.value)} disabled={loading||!returnableSales.length}>
     {returnableSales.map(row=><option key={row.id} value={row.id}>{row.receipt_no} · {row.location_name} · {dateLabel(row.created_at.slice(0,10))} · {usd(row.total)}</option>)}
    </select>
    {sale&&<><div className="return-sale-summary"><span>Original order total</span><b>{usd(sale.total)}</b><small>{sale.customer_id?'Customer sale':'Walk-in sale'} · {sale.location_name}</small></div>
     <label className="field-label mt">Item to return</label>
     <select value={saleLineId} onChange={event=>chooseLine(event.target.value)}>
      {returnableLines.map(line=><option key={line.id} value={line.id}>{itemName(line.item_sku)} · sold {line.quantity} · {remaining(line)} remaining</option>)}
     </select>
     <div className="form-grid two"><div><label className="field-label">Return quantity · up to {availableQuantity}</label><NumberInput type="number" min="1" max={availableQuantity} step="any" value={quantity} onChange={event=>setQuantity(Number(event.target.value))}/></div>
      <div><label className="field-label">Reason code</label><select value={reason} onChange={event=>setReason(event.target.value)}>{['Burnt','Undercooked','Wrong order','Cold on pickup','Damaged packaging','Customer changed mind'].map(value=><option key={value}>{value}</option>)}</select></div>
     </div>
     {transactionType==='Exchange'&&<div className="form-grid two"><div><label className="field-label">Replacement item</label><select value={replacementSku} onChange={event=>setReplacementSku(event.target.value)}>{items.filter(item=>item.price>0).map(item=><option key={item.sku} value={item.sku}>{item.name}</option>)}</select></div><div><label className="field-label">Replacement quantity</label><NumberInput type="number" min="1" step="any" value={replacementQuantity} onChange={event=>setReplacementQuantity(Number(event.target.value))}/></div></div>}
     <label className="field-label mt">Disposition</label>
     <div className="disposition-choice"><button type="button" className={!restockable||disposition==='Waste'?'selected':''} onClick={()=>setDisposition('Waste')}><AlertTriangle size={15}/><span><b>Waste</b><small>Returned item does not go back to stock</small></span></button><button type="button" disabled={!restockable} className={restockable&&disposition==='Restock'?'selected':''} onClick={()=>setDisposition('Restock')}><PackageCheck size={15}/><span><b>Restock</b><small>{restockable?'Add eligible sealed item back to stock':'Only sealed soda / ranch'}</small></span></button></div>
     {(requestStorageError||actionError)&&<div className="login-error" role="alert">{requestStorageError||actionError}</div>}
     {lastResult&&<div className="transfer-note"><CheckCircle2 size={16}/><span>{lastResult.transaction_type==='Exchange'?<>Exchange recorded. Manual/simulated settlement only; no payment was processed. {settlementLabel(lastResult.settlement_net)}.</>:<>Return recorded as a manual/simulated refund; no payment was processed. Refund recorded: {usd(lastResult.refund_total)}.</>}</span></div>}
     <button className="button primary form-submit" disabled={loading||submitting||!requestStorageReady||!!requestStorageError||!availableQuantity||!Number.isFinite(quantity)||quantity<=0||quantity>availableQuantity||(transactionType==='Exchange'&&(!Number.isFinite(replacementQuantity)||replacementQuantity<=0))} onClick={()=>void submit()}>{submitting?'Processing…':transactionType==='Exchange'?'Process exchange':'Process return'} <ArrowUpRight size={16}/></button>
    </>}
    {!loading&&!sale&&<div className="empty-inline">{sales.length?'All completed sale quantities have already been returned.':'No completed sales are available in Supabase.'}</div>}
    {loading&&!sale&&<div className="empty-inline">Loading completed sales and return history…</div>}
   </section>
   <section className="panel movement-side"><div className="panel-head"><div><h2>Recent returns and exchanges</h2><p>Persisted reason, disposition, refund, and settlement history</p></div></div>
    <div className="movement-list">{history.length?history.slice(0,12).map(record=>record.lines.map(line=><div className="movement-item" key={`${record.id}-${line.id}`}><div className={`movement-icon ${line.disposition==='Restock'?'positive':'negative'}`}>{line.disposition==='Restock'?<PackageCheck size={15}/>:<AlertTriangle size={15}/>}</div><div className="movement-copy"><b>{itemName(line.item_sku)}</b><span>{record.transaction_type} · {saleLabel(record.original_sale_id)} · {line.reason_code} · {line.disposition}{record.transaction_type==='Exchange'?' · Manual/simulated settlement':''}</span></div><div className="movement-qty"><b>{usd(line.refund_total)}</b><span>{line.quantity} returned · {dateLabel(record.created_at.slice(0,10))}</span>{record.transaction_type==='Exchange'&&<small>{settlementLabel(record.settlement_net)}</small>}</div></div>)):loading?<div className="empty-inline">Loading persisted return history…</div>:<div className="empty-inline">No returns or exchanges have been recorded yet.</div>}</div>
   </section>
  </div>
 </>;
}


export default App;
