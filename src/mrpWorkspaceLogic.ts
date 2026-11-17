import type {PlanRow, PlanSnapshot} from './sharedMrp.ts';

export const totalRequirement = (row: PlanRow) => row.gross.reduce((sum, qty) => sum + qty, 0);
export const suggestedUnits = (row: PlanRow) => row.actions.reduce((sum, action) => sum + action.quantity, 0);
export const suggestedPacks = (row: PlanRow) => row.actions.reduce((sum, action) => sum + action.packs, 0);
export const rowKey = (row: PlanRow) => row.location + '|' + row.item.sku;
export const hasMrpDraft = (data: PlanSnapshot, row: PlanRow) => (data.purchaseDrafts ?? []).some(draft => draft.location_id === row.location && draft.item_sku === row.item.sku);

export function purchaseBlocker(data: PlanSnapshot, row: PlanRow): string | null {
  if (row.made) return 'Make this item in Production';
  if (!row.actions.length) return 'No purchase is needed';
  if (!row.item.active) return 'Item is inactive';
  if (!Number.isFinite(Number(row.item.unit_cost)) || Number(row.item.unit_cost) < 0) return 'Review this item’s unit cost';
  if (hasMrpDraft(data, row)) return 'An MRP draft is awaiting review';
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

export function buildMrpDrafts(data: PlanSnapshot, rows: PlanRow[]) {
  const groups = new Map<string, {supplierId: string; locationId: string; date: string; send: false; notes: string; lines: {sku: string; qty: number; price: number}[]}>();
  const seen = new Set<string>();
  if (!rows.length) throw Error('Select at least one purchased component with an uncovered requirement.');
  for (const row of rows) {
    const blocker = purchaseBlocker(data, row);
    if (blocker) throw Error(row.item.name + ': ' + blocker + '. Refresh the plan before continuing.');
    if (seen.has(rowKey(row))) throw Error('A component was selected more than once.');
    seen.add(rowKey(row));
    if (!Number.isFinite(Number(row.item.unit_cost)) || Number(row.item.unit_cost) < 0) throw Error('Review the cost of ' + row.item.name + ' before creating its draft.');
    const supplierId = row.item.supplier_id!;
    const key = row.location + '|' + supplierId;
    const group = groups.get(key) ?? {supplierId, locationId: row.location, date: data.today, send: false as const, notes: 'MRP confirmed requirements · ' + data.today, lines: []};
    group.lines.push({sku: row.item.sku, qty: suggestedPacks(row), price: Math.round(Number(row.item.unit_cost) * Number(row.item.conversion_factor) * 100) / 100});
    groups.set(key, group);
  }
  return {orders: [...groups.values()]};
}
