-- Inventory management: additive backorders, shared availability, validated stock writes.
begin;
create table if not exists public.erp_inventory_backorders (
 id uuid primary key default gen_random_uuid(), reference text not null check(length(trim(reference)) between 1 and 120),
 item_sku text not null references public.items(sku), location_id uuid not null references public.locations(id),
 quantity_requested numeric not null check(quantity_requested>0 and quantity_requested::text not in ('NaN','Infinity','-Infinity')),
 quantity_fulfilled numeric not null default 0 check(quantity_fulfilled>=0),
 status text not null default 'Open' check(status in ('Open','Fulfilled','Cancelled')),
 notes text not null default '', cancellation_reason text,
 created_by uuid not null references auth.users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check(quantity_fulfilled<=quantity_requested),check(status<>'Fulfilled' or quantity_fulfilled=quantity_requested)
);
create index if not exists erp_inventory_backorders_queue on public.erp_inventory_backorders(item_sku,location_id,created_at,id) where status='Open';
create table if not exists public.erp_inventory_requests (
 id uuid primary key,action text not null,payload jsonb not null,result jsonb not null,
 created_by uuid not null references auth.users(id),created_at timestamptz not null default now()
);
create table if not exists public.erp_inventory_audit (
 id uuid primary key default gen_random_uuid(),request_id uuid not null unique references public.erp_inventory_requests(id) deferrable initially deferred,
 action text not null,resource_id text not null,before_value jsonb,after_value jsonb,
 created_by uuid not null references auth.users(id),created_at timestamptz not null default now()
);
alter table public.erp_inventory_backorders enable row level security;
alter table public.erp_inventory_requests enable row level security;
alter table public.erp_inventory_audit enable row level security;
revoke all on public.erp_inventory_backorders,public.erp_inventory_requests,public.erp_inventory_audit from public,anon,authenticated;

-- A missing identity/profile must fail closed for every legacy caller too.
create or replace function public.require_staff() returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if auth.uid() is null or coalesce(public.current_role(),'') not in ('Manager','Cashier') then
  raise exception 'Manager or Cashier role required' using errcode='42501';
 end if;
end $$;
-- Recipe items carry their rolled-up material cost; purchased items use current cost.
create or replace function public.erp_inventory_unit_cost(p_sku text) returns numeric
language plpgsql stable set search_path=pg_catalog,public as $$
declare result numeric;bad boolean;begin
 with recursive components(sku,quantity,path,cycle) as (
  select p_sku,1::numeric,array[p_sku],false
  union all select b.component_sku,c.quantity*b.quantity,c.path||b.component_sku,b.component_sku=any(c.path)
   from components c join public.bom_lines b on b.parent_sku=c.sku where not c.cycle and cardinality(c.path)<64
 ) select coalesce(sum(c.quantity*i.unit_cost) filter(where not exists(select 1 from public.bom_lines b where b.parent_sku=c.sku)),0),
 coalesce(bool_or(c.cycle or cardinality(c.path)>=64),false) into result,bad from components c join public.items i on i.sku=c.sku;
 if bad then raise exception 'Recipe cycle or excessive recipe depth';end if;return result;
end $$;
revoke all on function public.erp_inventory_unit_cost(text) from public,anon,authenticated;
create or replace function public.post_transfer(p_item_sku text,p_from uuid,p_to uuid,p_quantity numeric)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_id uuid:=gen_random_uuid();v_cost numeric;v_onhand numeric;v_unit text;
begin
 perform public.require_staff();
 if p_from is null or p_to is null or p_from=p_to or p_quantity is null or p_quantity::text in ('NaN','Infinity','-Infinity') or p_quantity<=0 then raise exception 'Choose distinct locations and a positive finite quantity';end if;
 if not exists(select 1 from public.locations where id=p_from) or not exists(select 1 from public.locations where id=p_to) then raise exception 'Choose valid locations';end if;
 select unit_cost,base_unit into v_cost,v_unit from public.items where sku=p_item_sku for update;
 if not found then raise exception 'Item not found';end if;
 if v_unit='each' and p_quantity<>trunc(p_quantity) then raise exception 'Each-unit items require a whole quantity';end if;
 v_cost:=public.erp_inventory_unit_cost(p_item_sku);
 select coalesce(sum(quantity),0) into v_onhand from public.inventory_transactions where item_sku=p_item_sku and location_id=p_from;
 if v_onhand<p_quantity then raise exception 'Insufficient stock: available %, requested %',v_onhand,p_quantity;end if;
 insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type,reference_document,user_id,metadata)
 values(p_item_sku,p_from,-p_quantity,v_cost,'Transfer Out',v_id::text,auth.uid(),jsonb_build_object('counter_location',p_to)),
 (p_item_sku,p_to,p_quantity,v_cost,'Transfer In',v_id::text,auth.uid(),jsonb_build_object('counter_location',p_from));
 return v_id;
end $$;
create or replace function public.post_adjustment(p_item_sku text,p_location uuid,p_counted numeric,p_reason text)
returns numeric language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_onhand numeric;v_delta numeric;v_cost numeric;v_unit text;
begin
 perform public.require_staff();p_reason:=trim(p_reason);
 if p_counted is null or p_counted::text in ('NaN','Infinity','-Infinity') or p_counted<0 then raise exception 'Physical count must be a finite nonnegative quantity';end if;
 if p_reason is null or p_reason not in ('Cycle count correction','Spoiled/Expired','Damaged','Dropped/Spilled','Theft/Unknown loss') then raise exception 'Choose an approved reason code';end if;
 if p_location is null or not exists(select 1 from public.locations where id=p_location) then raise exception 'Choose a valid location';end if;
 select unit_cost,base_unit into v_cost,v_unit from public.items where sku=p_item_sku for update;
 if not found then raise exception 'Item not found';end if;
 if v_unit='each' and p_counted<>trunc(p_counted) then raise exception 'Each-unit items require a whole physical count';end if;
 v_cost:=public.erp_inventory_unit_cost(p_item_sku);
 select coalesce(sum(quantity),0) into v_onhand from public.inventory_transactions where item_sku=p_item_sku and location_id=p_location;
 v_delta:=p_counted-v_onhand;
 if p_reason<>'Cycle count correction' and v_delta>0 then raise exception 'A loss reason cannot increase stock; use Cycle count correction';end if;
 if v_delta<>0 then
  insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type,reason_code,reference_document,user_id,metadata)
  values(p_item_sku,p_location,v_delta,v_cost,case when p_reason='Cycle count correction' then 'Adjustment' else 'Waste' end,p_reason,
   case when p_reason='Cycle count correction' then 'Cycle count' else 'Inventory loss' end,auth.uid(),jsonb_build_object('previous_quantity',v_onhand,'counted_quantity',p_counted));
 end if;
 return v_delta;
end $$;

create or replace function public.erp_inventory_snapshot() returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare result jsonb;begin
 perform public.require_staff();
 -- All sections read the same statement snapshot; no browser-demo quantities are mixed in.
 select jsonb_build_object(
 'version',1,'userId',auth.uid(),'today',(now() at time zone 'America/Denver')::date,
 'items',coalesce((select jsonb_agg(jsonb_build_object('sku',i.sku,'name',i.name,'barcode',i.barcode,'category',i.category,'unit',i.base_unit,'active',i.active,
  'made',exists(select 1 from public.bom_lines b where b.parent_sku=i.sku),'supplier',s.name,'supplierActive',coalesce(s.erp_active,false),'leadDays',s.quoted_lead_days) order by i.sku)
  from public.items i left join public.suppliers s on s.id=i.supplier_id),'[]'::jsonb),
 'locations',coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'name',l.name) order by l.name) from public.locations l),'[]'::jsonb),
 'stock',coalesce((select jsonb_agg(to_jsonb(q)) from(select item_sku,location_id,sum(quantity) as on_hand from public.inventory_transactions group by item_sku,location_id)q),'[]'::jsonb),
 'incoming',coalesce((select jsonb_agg(jsonb_build_object('lineId',pl.id,'poId',po.id,'poNo',po.po_no,'sku',pl.item_sku,'locationId',po.ship_to_location_id,
  'quantity',greatest(0,pl.quantity_purchase-pl.quantity_received_purchase)*i.conversion_factor,'expectedOn',(po.expected_at at time zone 'America/Denver')::date) order by po.expected_at,po.id,pl.id)
  from public.purchase_order_lines pl join public.purchase_orders po on po.id=pl.purchase_order_id join public.items i on i.sku=pl.item_sku
  where po.status in ('Order Sent','Partially Received') and pl.quantity_purchase>pl.quantity_received_purchase),'[]'::jsonb),
 'backorders',coalesce((select jsonb_agg(to_jsonb(b) order by b.created_at,b.id) from public.erp_inventory_backorders b
  where b.status='Open' or b.id in(select id from public.erp_inventory_backorders where status<>'Open' order by updated_at desc,id desc limit 100)),'[]'::jsonb)
 ) into result;return result;
end $$;

create or replace function public.erp_inventory_write(p_request uuid,p_action text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
#variable_conflict use_variable
declare previous public.erp_inventory_requests%rowtype;b public.erp_inventory_backorders%rowtype;i public.items%rowtype;
 id uuid;dest uuid;sku text;qty numeric;have numeric;earlier numeric;variance numeric;before_value jsonb;after_value jsonb;answer jsonb;ref text;note text;
begin
 perform public.require_staff();
 if p_request is null or jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'Request ID and object payload required';end if;
 perform pg_advisory_xact_lock(1179468369,2);
 select * into previous from public.erp_inventory_requests where erp_inventory_requests.id=p_request;
 if found then
  if previous.created_by<>auth.uid() or previous.action<>p_action or previous.payload<>p_payload then raise exception 'Request ID already used with different data';end if;
  return previous.result;
 end if;
 case p_action
 when 'transfer' then
  qty:=public.erp_purchase_number(p_payload,'quantity',0.000001,1000000000);
  id:=public.post_transfer(p_payload->>'sku',(p_payload->>'fromId')::uuid,(p_payload->>'toId')::uuid,qty);
  after_value:=p_payload;
 when 'adjustment' then
  if p_payload ? 'lossQuantity' then
   if coalesce(trim(p_payload->>'reason'),'') not in ('Spoiled/Expired','Damaged','Dropped/Spilled','Theft/Unknown loss') then raise exception 'Choose a loss reason for quantity lost';end if;
   qty:=public.erp_purchase_number(p_payload,'lossQuantity',0.000001,1000000000);
   select * into i from public.items where items.sku=p_payload->>'sku' for update;
   if not found then raise exception 'Item not found';end if;
   if i.base_unit='each' and qty<>trunc(qty) then raise exception 'Each-unit items require a whole loss quantity';end if;
   dest:=(p_payload->>'locationId')::uuid;
   select coalesce(sum(quantity),0) into have from public.inventory_transactions where item_sku=i.sku and location_id=dest;
   if qty>have then raise exception 'Loss quantity exceeds current stock: available %, requested %',have,qty;end if;
   qty:=have-qty;
  else
   qty:=public.erp_purchase_number(p_payload,'counted',0,1000000000);
  end if;
  variance:=public.post_adjustment(p_payload->>'sku',(p_payload->>'locationId')::uuid,qty,p_payload->>'reason');
  id:=p_request;after_value:=p_payload||jsonb_build_object('variance',variance);
 when 'create_backorder' then
  sku:=p_payload->>'sku';dest:=(p_payload->>'locationId')::uuid;ref:=trim(p_payload->>'reference');note:=coalesce(p_payload->>'notes','');
  qty:=public.erp_purchase_number(p_payload,'quantity',0.000001,1000000000);
  if ref is null or length(ref) not between 1 and 120 or length(note)>2000 then raise exception 'Enter an order/customer reference (up to 120 characters) and notes up to 2000 characters';end if;
  select * into i from public.items where items.sku=sku and active for update;
  if not found then raise exception 'Choose an active item';end if;
  if i.base_unit='each' and qty<>trunc(qty) then raise exception 'Each-unit items require a whole quantity';end if;
  if dest is null or not exists(select 1 from public.locations where locations.id=dest) then raise exception 'Choose a valid location';end if;
  insert into public.erp_inventory_backorders(reference,item_sku,location_id,quantity_requested,notes,created_by)
   values(ref,sku,dest,qty,note,auth.uid()) returning * into b;
  id:=b.id;after_value:=to_jsonb(b);
 when 'fulfill_backorder','cancel_backorder' then
  id:=(p_payload->>'id')::uuid;
  select * into b from public.erp_inventory_backorders where erp_inventory_backorders.id=id for update;
  if not found or b.status<>'Open' then raise exception 'Backorder is no longer open; refresh the page';end if;
  before_value:=to_jsonb(b);
  if p_action='cancel_backorder' then
   note:=trim(p_payload->>'reason');if note is null or length(note) not between 1 and 500 then raise exception 'Enter a cancellation reason (up to 500 characters)';end if;
   update public.erp_inventory_backorders set status='Cancelled',cancellation_reason=note,updated_at=now() where erp_inventory_backorders.id=id returning * into b;
  else
   qty:=public.erp_purchase_number(p_payload,'quantity',0.000001,1000000000);
   if qty>b.quantity_requested-b.quantity_fulfilled then raise exception 'Quantity exceeds the remaining backorder';end if;
   select * into i from public.items where items.sku=b.item_sku for update;
   if i.base_unit='each' and qty<>trunc(qty) then raise exception 'Each-unit items require a whole quantity';end if;
   select coalesce(sum(quantity),0) into have from public.inventory_transactions where item_sku=b.item_sku and location_id=b.location_id;
   select coalesce(sum(quantity_requested-quantity_fulfilled),0) into earlier from public.erp_inventory_backorders
    where item_sku=b.item_sku and location_id=b.location_id and status='Open' and (created_at,erp_inventory_backorders.id)<(b.created_at,b.id);
   if have-earlier<qty then raise exception 'Insufficient stock after earlier backorders: available %, requested %',greatest(0,have-earlier),qty;end if;
   insert into public.inventory_transactions(item_sku,location_id,quantity,unit_cost,transaction_type,reference_document,user_id,metadata)
    values(b.item_sku,b.location_id,-qty,public.erp_inventory_unit_cost(b.item_sku),'Backorder Fulfillment',b.reference,auth.uid(),jsonb_build_object('backorder_id',b.id,'request_id',p_request));
   update public.erp_inventory_backorders set quantity_fulfilled=quantity_fulfilled+qty,
    status=case when quantity_fulfilled+qty=quantity_requested then 'Fulfilled' else 'Open' end,updated_at=now()
    where erp_inventory_backorders.id=id returning * into b;
  end if;
  after_value:=to_jsonb(b);
 else raise exception 'Unsupported inventory action';
 end case;
 answer:=jsonb_build_object('requestId',p_request,'action',p_action,'resourceId',id,'variance',variance);
 insert into public.erp_inventory_requests(id,action,payload,result,created_by) values(p_request,p_action,p_payload,answer,auth.uid());
 insert into public.erp_inventory_audit(request_id,action,resource_id,before_value,after_value,created_by) values(p_request,p_action,id::text,before_value,after_value,auth.uid());
 return answer;
end $$;
revoke all on function public.require_staff(),public.post_transfer(text,uuid,uuid,numeric),public.post_adjustment(text,uuid,numeric,text),public.erp_inventory_snapshot(),public.erp_inventory_write(uuid,text,jsonb) from public,anon;
grant execute on function public.require_staff(),public.post_transfer(text,uuid,uuid,numeric),public.post_adjustment(text,uuid,numeric,text),public.erp_inventory_snapshot(),public.erp_inventory_write(uuid,text,jsonb) to authenticated;
commit;
