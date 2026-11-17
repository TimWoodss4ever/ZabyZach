const snapshot={
 version:1 as const,userId:'fixture-manager',today:'2026-11-17',
 suppliers:[{id:'supplier',name:'Test supplier',contact_name:null,email:null,phone:null,address:null,quoted_lead_days:2,payment_terms_days:30,erp_active:true,erp_notes:'',erp_revision:1}],
 items:[{sku:'test-item',name:'Synthetic flour',barcode:'000000000001',category:'Ingredient',base_unit:'oz',purchase_unit:'case of 100',conversion_factor:100,unit_cost:.4,shelf_life_days:null,supplier_id:'supplier',active:true,made:false}],
 locations:[{id:'store',name:'Test store'}],orders:[],lines:[],receipts:[],receiptLines:[],invoices:[],payments:[],reviews:[],inventoryReviews:[],audit:[],
 options:{order_cost:25,holding_rate:.25,safety_days:2,review_days:7,revision:1},stock:{'test-item':0},dailyUsage:{'test-item':10}
};
const session={user:{id:'fixture-manager',email:'manager@example.test'}};

export function createClient(){
 (window as typeof window&{qaSnapshot?:typeof snapshot}).qaSnapshot=snapshot;
 return{
  auth:{
   onAuthStateChange(callback:(event:string,session:typeof session)=>void){
    let active=true;queueMicrotask(()=>{if(active)callback('SIGNED_IN',session);});
    return{data:{subscription:{unsubscribe(){active=false;}}}};
   },
   async getSession(){return{data:{session},error:null};},
   async signOut(){return{error:null};}
  },
  from(){
   const query={select(){return query;},eq(){return query;},async maybeSingle(){return{data:{role:'Manager',customer_id:null},error:null};}};
   return query;
  },
  async rpc(name:string,args:Record<string,unknown>={}){
   const calls=(window as typeof window&{qaCalls?:unknown[]}).qaCalls??=((window as typeof window&{qaCalls?:unknown[]}).qaCalls=[]);
   calls.push({name,args});
   if(name==='erp_purchasing_snapshot_with_history')return{data:structuredClone(snapshot),error:null};
   if(name==='erp_purchasing_write'){
    const action=args.p_action,payload=args.p_payload as Record<string,unknown>;
    if(action==='save_options'){
     snapshot.options={order_cost:Number(payload.orderCost),holding_rate:Number(payload.holdingRate),safety_days:Number(payload.safetyDays),review_days:Number(payload.reviewDays),revision:snapshot.options.revision+1};
    }else if(action==='create_orders'){
     const orders=payload.orders as Array<Record<string,unknown>>;
     snapshot.orders.push(...orders.map((order,index)=>({id:'draft-'+index,po_no:'DRAFT-'+index,supplier_id:order.supplierId,ship_to_location_id:order.locationId,ordered_at:String(order.date),expected_at:String(order.date),received_at:null,status:order.send?'Order Sent':'Draft',erp_notes:String(order.notes??''),erp_revision:1,erp_quoted_lead_days:2,erp_payment_terms_days:30,erp_legacy_received_at:null})));
    }else if(action==='inventory_review'){
     snapshot.inventoryReviews.unshift({id:'review-'+snapshot.inventoryReviews.length,notes:String(payload.notes??''),created_at:'2026-11-17T12:00:00Z',created_by:'fixture-manager'});
    }
    return{data:{ok:true},error:null};
   }
   throw Error('Unexpected mocked RPC: '+name);
  }
 };
}
