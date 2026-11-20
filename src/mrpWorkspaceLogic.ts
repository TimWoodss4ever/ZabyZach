import {matchingDrafts,purchasePackPrice,replenishmentPolicy} from './replenishmentPolicy.ts';
import {calculateMrp} from './sharedMrp.ts';
import type {PlanRow, PlanSnapshot} from './sharedMrp.ts';

export const totalRequirement = (row: PlanRow) => row.gross.reduce((sum, qty) => sum + qty, 0);
export const suggestedUnits = (row: PlanRow) => row.actions.reduce((sum, action) => sum + action.quantity, 0);
export const suggestedPacks = (row: PlanRow) => row.actions.reduce((sum, action) => sum + action.packs, 0);
export const rowKey = (row: PlanRow) => row.location + '|' + row.item.sku;
export const existingPurchaseDrafts=(data:PlanSnapshot,row:PlanRow)=>matchingDrafts(data.purchaseDrafts??[],row.location,row.item.sku);
export const hasMrpDraft=(data:PlanSnapshot,row:PlanRow)=>existingPurchaseDrafts(data,row).length>0;

export function purchaseBlocker(data: PlanSnapshot, row: PlanRow): string | null {
  if (row.made) return 'Make this item in Production';
  if (!row.actions.length) return 'No purchase is needed';
  if (!row.item.active) return 'Item is inactive';
  if (!Number.isFinite(Number(row.item.unit_cost)) || Number(row.item.unit_cost) < 0) return 'Review this item’s unit cost';
  if (hasMrpDraft(data, row)) return 'A purchase draft is awaiting review at this location';
  if (!data.suppliers.some(supplier => supplier.id === row.item.supplier_id && supplier.erp_active)) return 'Assign an active supplier';
  return null;
}

export function materialStatus(data: PlanSnapshot, row: PlanRow) {
  if (row.onHand < 0) return {label: 'Check stock', tone: 'warn'};
  if (hasMrpDraft(data, row)) return {label: 'Draft to review', tone: 'info'};
  if (row.actions.some(action => action.orderBy < data.today)) return {label: 'Overdue action', tone: 'bad'};
  if (row.actions.some(action => action.orderBy === data.today)) return {label: 'Due today', tone: 'warn'};
  if (row.actions.length) return {label: row.made ? 'Plan production' : 'Purchase needed', tone: 'info'};
  return totalRequirement(row) > 0 ? {label: 'Covered', tone: 'good'} : {label: 'No demand', tone: 'neutral'};
}

export type PurchaseMode='minimum'|'replenish';
export function mrpPurchaseChoice(data:PlanSnapshot,row:PlanRow,mode:PurchaseMode='minimum'){
 const minimumPacks=suggestedPacks(row),factor=Number(row.item.conversion_factor),price=purchasePackPrice(Number(row.item.unit_cost),factor);
 const policy=data.purchasePolicy,daily=Number(policy?.usage.find(u=>u.location_id===row.location&&u.item_sku===row.item.sku)?.daily??0);
 const routine=policy?replenishmentPolicy({daily,onHand:row.onHand,onOrder:row.onOrder,factor,cost:Number(row.item.unit_cost),lead:row.lead,shelfLife:row.item.shelf_life_days??null,options:policy.options}):null;
 if(mode==='replenish'&&!routine)throw Error('Install the MRP purchasing policy update and refresh before including replenishment.');
 const extraPacks=mode==='replenish'&&(routine?.packs??0)>minimumPacks?(routine!.packs-(row.actions[0]?.packs??0)):0;
 // Top up once at the first requirement, then credit those packs to later dates.
 // Never combine deadlines or reduce the original ability to cover demand.
 let carry=0;
 const actions=row.actions.flatMap((a,index)=>{const packs=Math.max(0,Math.ceil((a.net-carry-1e-8)/factor))+(index===0?extraPacks:0);carry+=packs*factor-a.quantity;return packs?[{...a,packs,quantity:packs*factor}]:[];});
 const packs=actions.reduce((n,a)=>n+a.packs,0),units=packs*factor;
 const shelfWarning=!!row.item.shelf_life_days&&daily>0&&row.onHand+row.onOrder+units>daily*row.item.shelf_life_days;
 return{actions,packs,units,minimumPacks,minimumUnits:minimumPacks*factor,extraPacks:packs-minimumPacks,extraCost:(packs-minimumPacks)*price,cost:packs*price,price,routine,daily,shelfWarning};
}

export function buildMrpDrafts(data: PlanSnapshot, rows: PlanRow[],mode:PurchaseMode='minimum') {
  const groups = new Map<string, {supplierId: string; locationId: string; date: string; requiredOn:string; orderBy:string; send: false; notes: string; lines: {sku: string; qty: number; price: number}[]}>();
  const seen = new Set<string>();
  const current = new Map(calculateMrp(data).rows.map(row => [rowKey(row), row]));
  if (!rows.length) throw Error('Select at least one purchased component with an uncovered requirement.');
  for (const selected of rows) {
    const row = current.get(rowKey(selected));
    if (!row || JSON.stringify(row.actions) !== JSON.stringify(selected.actions)) throw Error('The selected plan changed. Refresh and review the current requirements.');
    const blocker = purchaseBlocker(data, row);
    if (blocker) throw Error(row.item.name + ': ' + blocker + '. Refresh the plan before continuing.');
    if (seen.has(rowKey(row))) throw Error('A component was selected more than once.');
    seen.add(rowKey(row));
    if (!Number.isFinite(Number(row.item.unit_cost)) || Number(row.item.unit_cost) < 0) throw Error('Review the cost of ' + row.item.name + ' before creating its draft.');
    const supplierId = row.item.supplier_id!;
    for (const action of mrpPurchaseChoice(data,row,mode).actions) {
      const key = row.location + '|' + supplierId + '|' + action.date + '|' + action.orderBy;
      const group = groups.get(key) ?? {supplierId, locationId: row.location, date: data.today, requiredOn:action.date, orderBy:action.orderBy, send: false as const, notes: 'MRP confirmed requirements · ' + data.today + ' · Need by ' + action.date + ' · Order by ' + action.orderBy + (mode==='replenish'?' · Includes routine replenishment':' · Covers confirmed demand'), lines: []};
      group.lines.push({sku: row.item.sku, qty: action.packs, price: purchasePackPrice(Number(row.item.unit_cost),Number(row.item.conversion_factor))});
      groups.set(key, group);
    }
  }
  return {revision:data.revision, orders: [...groups.values()]};
}
