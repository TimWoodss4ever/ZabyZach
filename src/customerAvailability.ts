export type CustomerStockStatus='Available'|'Low stock'|'Unavailable';
export type CustomerIngredient={sku:string;name:string;category:string;unit:string;quantity_per_item?:number;available_units:number;status:CustomerStockStatus;used_in?:string[]};
export type CustomerProduct={sku:string;name:string;category:string;unit:string;status:CustomerStockStatus;available_units:number;finished_units:number;makeable_units:number;components:CustomerIngredient[]};
export type CustomerAvailability={location:string;as_of:string;refresh_seconds:number;products:CustomerProduct[];ingredients:CustomerIngredient[];low_rule:string};

const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
export function isCustomerAvailability(value:unknown):value is CustomerAvailability{
 if(!value||typeof value!=='object')return false;
 const x=value as Record<string,unknown>;
 if(typeof x.location!=='string'||typeof x.as_of!=='string'||!Array.isArray(x.products)||!Array.isArray(x.ingredients))return false;
 const validIngredient=(value:unknown):boolean=>{
  if(!value||typeof value!=='object')return false;
  const item=value as Record<string,unknown>;
  return typeof item.sku==='string'&&typeof item.name==='string'&&typeof item.category==='string'&&typeof item.unit==='string'&&
   finite(item.available_units)&&['Available','Low stock','Unavailable'].includes(String(item.status));
 };
 return (x.products as unknown[]).every(p=>{
  if(!p||typeof p!=='object')return false;
  const item=p as Record<string,unknown>;
  return typeof item.sku==='string'&&typeof item.name==='string'&&typeof item.unit==='string'&&
   ['Available','Low stock','Unavailable'].includes(String(item.status))&&finite(item.available_units)&&
   finite(item.finished_units)&&finite(item.makeable_units)&&Array.isArray(item.components)&&
   (item.components as unknown[]).every(c=>!!c&&typeof c==='object'&&typeof (c as Record<string,unknown>).sku==='string'&&
    typeof (c as Record<string,unknown>).name==='string'&&typeof (c as Record<string,unknown>).category==='string'&&
    typeof (c as Record<string,unknown>).unit==='string'&&finite((c as Record<string,unknown>).available_units)&&
    finite((c as Record<string,unknown>).quantity_per_item)&&['Available','Low stock','Unavailable'].includes(String((c as Record<string,unknown>).status)));
 })&&(x.ingredients as unknown[]).every(validIngredient);
}

// Mirrors the checkout posting order: consume finished parent stock first, then
// aggregate each direct BOM component across every remaining cart unit.
export function customerCartCapacityIssue(
 lines:{sku:string;qty:number}[],
 products:CustomerProduct[],
 location:string,
 itemName:(sku:string)=>string=sku=>sku,
):string|null{
 const bySku=new Map(products.map(product=>[product.sku,product]));
 const componentStock=new Map<string,{name:string;unit:string;available:number}>();
 const required=new Map<string,number>();
 for(const line of lines){
  if(!Number.isFinite(line.qty)||line.qty<=0)return 'Review the quantities in your cart.';
  const product=bySku.get(line.sku);
  if(!product)return `Current availability for ${itemName(line.sku)} is not confirmed at ${location}. Refresh and try again.`;
  const makeQty=Math.max(0,line.qty-product.finished_units);
  if(makeQty<=0)continue;
  if(!product.components.length)return `Only ${product.finished_units} ${product.unit} of ${product.name} are currently available at ${location}. Your cart is unchanged.`;
  for(const component of product.components){
   const amount=component.quantity_per_item;
   if(!finite(amount)||amount<=0)return `Current recipe availability for ${product.name} is incomplete at ${location}. Refresh before continuing.`;
   componentStock.set(component.sku,{name:component.name,unit:component.unit,available:component.available_units});
   required.set(component.sku,(required.get(component.sku)??0)+amount*makeQty);
  }
 }
 for(const [sku,needed] of required){
  const stock=componentStock.get(sku);
  if(!stock||needed>stock.available+1e-8)return `Your cart needs more ${stock?.name??sku} than is currently available at ${location}. Reduce the quantity or choose another pickup store; your cart is unchanged.`;
 }
 return null;
}
