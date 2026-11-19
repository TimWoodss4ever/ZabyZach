const supplier={id:'supplier',name:'Test dairy',contact_name:'Orders',email:'orders@example.test',phone:'',address:'',quoted_lead_days:2,payment_terms_days:30,erp_active:true,erp_notes:'',erp_revision:0};
const po=(id:string,no:string,status='Order Sent')=>({id,po_no:no,status,supplier_id:'supplier',ship_to_location_id:'store',ordered_at:'2026-11-17',expected_at:'2026-11-20',received_at:null,erp_notes:'',erp_revision:0,erp_quoted_lead_days:2,erp_payment_terms_days:30,erp_legacy_received_at:null});
const primary=po('a0186598-bf73-4d89-86d2-a43e41d9555a','PO-DEMO-001'),second=po('b0186598-bf73-4d89-86d2-a43e41d9555a','PO-DEMO-002','Partially Received'),closed=po('c0186598-bf73-4d89-86d2-a43e41d9555a','PO-CLOSED','Closed');
const line=(id:string,order:string,sku:string,received=0)=>({id,purchase_order_id:order,item_sku:sku,quantity_purchase:5,quantity_received_purchase:received,unit_price_purchase:80});
const item=(sku:string,name:string)=>({sku,name,barcode:'ZBZ-'+sku,category:'Ingredient',base_unit:'oz',purchase_unit:'5 lb bag',conversion_factor:80,unit_cost:1,shelf_life_days:null,supplier_id:'supplier',active:true,made:false});
const snapshot={version:1,userId:'fixture-manager',today:'2026-11-17',suppliers:[supplier],items:[item('1003','Mozzarella'),item('1007','Diced ham')],locations:[{id:'store',name:'Provo Campus Store'}],orders:[primary,second,closed],lines:[line('line1',primary.id,'1003'),line('line2',primary.id,'1007'),line('line3',second.id,'1007',1),line('line4',closed.id,'1007',5)],receipts:[] as any[],receiptLines:[] as any[],invoices:[] as any[],payments:[],reviews:[],inventoryReviews:[],audit:[],options:{order_cost:25,holding_rate:.25,safety_days:2,review_days:7,revision:0},stock:{'1003':0,'1007':0} as Record<string,number>,dailyUsage:{}};
let revision=0;const completed=new Map<string,unknown>();
export function createClient(){
 (window as any).poFixture=snapshot;(window as any).poReceiptPosts=0;(window as any).poCalls=[];
 return{rpc:async(name:string,args:any)=>{
  (window as any).poCalls.push({name,args});
  if(name==='erp_purchasing_snapshot_current')return{data:args.p_revision===String(revision)?{unchanged:true,serverRevision:String(revision)}:{...structuredClone(snapshot),serverRevision:String(revision)},error:null};
  if(name!=='erp_purchasing_write')throw Error('Unexpected RPC '+name);
  if(completed.has(args.p_request))return{data:completed.get(args.p_request),error:null};
  if(args.p_action!=='receive_order')throw Error('Unexpected write '+args.p_action);
  const input=args.p_payload,order=snapshot.orders.find(p=>p.id===input.id)!;
  if(order.erp_revision!==input.revision)return{data:null,error:{code:'40001',message:'PO changed; refresh before receiving.'}};
  let amount=0;const receipt='receipt-'+revision;
  for(const incoming of input.lines){if(incoming.qty===0)continue;const target=snapshot.lines.find(l=>l.id===incoming.id)!;if(incoming.qty>target.quantity_purchase-target.quantity_received_purchase)throw Error('Over receipt');target.quantity_received_purchase+=incoming.qty;snapshot.stock[target.item_sku]+=incoming.qty*80;amount+=incoming.qty*incoming.price;snapshot.receiptLines.push({id:receipt+'-'+target.id,receipt_id:receipt,purchase_order_line_id:target.id,quantity_purchase:incoming.qty,unit_price_purchase:incoming.price});}
  snapshot.receipts.push({id:receipt,purchase_order_id:order.id,received_on:input.date,location_id:input.locationId,final_delivery:input.final,tax_amount:input.tax,created_at:input.date});
  snapshot.invoices.push({id:'invoice-'+revision,purchase_order_id:order.id,amount:amount+input.tax,due_at:'2026-12-17',paid_at:null,created_at:input.date,erp_invoice_date:input.date,erp_receipt_id:receipt,erp_revision:0});
  order.erp_revision++;order.status=input.final||snapshot.lines.filter(l=>l.purchase_order_id===order.id).every(l=>l.quantity_received_purchase>=l.quantity_purchase)?'Received':'Partially Received';
  revision++;(window as any).poReceiptPosts++;const result={id:receipt};completed.set(args.p_request,result);
  if((window as any).dropPoReply){(window as any).dropPoReply=false;throw Error('Connection interrupted after posting.');}
  return{data:result,error:null};
 }};
}
