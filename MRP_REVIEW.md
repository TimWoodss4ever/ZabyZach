# MRP changes and review

Pickup orders and MRP now use shared Supabase records. Each location plans its own inventory and receipts. Confirmation does not consume stock. Prepare or Prepare & fulfill posts one sale and the related inventory usage; marking a prepared order collected posts neither again.

## Requirement coverage

| Coursework requirement | Implementation |
| --- | --- |
| At least five BOM parents | Existing catalog includes seven pizza/breadstick parents, house-made dough and additional sauce recipes. MRP's BOM viewer reports the actual shared catalog count. |
| Child quantities per unit | BOM viewer lists each component, its inventory unit, quantity per parent unit and effective lead time. |
| Consume components when making or selling | Starting production issues immediate components. Sales use prepared parent stock first, then consume the immediate recipe for remaining units. Prepared dough is consumed without issuing its flour again. |
| Component lead times | Purchased components use their supplier's current quoted days, with item lead days as fallback. In-house ingredient recipes use item lead days; menu items are prepared for their pickup date, rather than inheriting their former purchasing supplier lead. |
| Confirmed order quantities × BOM | Shared open, unprepared order lines explode through the BOM. Cancelled, fulfilled and already-prepared orders are excluded. |
| Net stock and open POs | Per location, net current ledger stock and remaining quantities on issued/part-received POs, converted to base units and scheduled by receipt date. |
| Suggested order quantity | Date-specific shortages round to whole supplier packs. Leftover quantities carry into later demand. MRP drafts are reviewed and issued through existing purchasing. |
| Order-by date | Actual component requirement date minus calendar-day lead time. Nested in-house preparation offsets child dates first. Past dates show an expedite warning. |
| Four-week view | Four dated seven-day periods starting today in America/Denver. Later orders do not get pushed into Week 4. Overdue open orders remain visible. |

## Workflow

1. Confirm an order in Sales Orders or online customer checkout.
2. Open MRP and choose the order's pickup location.
3. Review the component's dated shortages, source demand, pack rounding and possible transfers. Transfer suggestions are allocated from existing stock remaining after the source location's own four-week demand. They do not automatically reduce purchase suggestions.
4. Post any actual transfers, refresh, then create ingredient PO drafts. Existing pending MRP drafts suppress duplicate drafts for that item/location. Review drafts before issuing; only issued POs count as supply.
5. Create dough batches through Production. Open production needs a completion date before MRP counts its expected output; dates can be assigned under planning exceptions. Planned batches commit ingredients. In-progress batches have already issued them.
6. Prepare the pickup order when the kitchen uses its ingredients, or use Prepare & fulfill together. Later collection never deducts stock a second time.

## Database rollout

Apply **only** `supabase/migrations/202611160004_shared_mrp.sql` to the existing, up-to-date project before deploying the new UI. This adds planning/order columns and RPCs and refines the existing sale/production RPCs without changing their signatures. It does not import browser demo transactions, rewrite historical sales/stock, reseed the catalog or replay previous migrations. Earlier browser demo orders remain saved separately.

Online card processing remains simulated. The shared order stores the simulation marker; revenue and COGS are recorded when prepared. No payment-card fields are sent to the order RPC. Existing POS reward-redemption/customization restrictions remain in place.

Open production is assumed to yield its started quantity until completion reports actual good/scrap output. Completion must account for the full batch; receipt less recorded scrap leaves exactly the good quantity in stock. Existing physical stock has no lot-level expiration model.

The original live-data timestamp correction migration expects eight specific imported UUIDs and intentionally fails against a fresh database. CI omits that dataset-specific correction, retains its production row-count guard unchanged, runs the earlier preservation suites, then applies and exercises this MRP migration twice.

## Verification

- `node tests/run-all.mjs`: existing suites plus dated/location MRP, request-retry and server-rendered planning checks.
- `tests/sql/shared-mrp.sql`: actual disposable PostgreSQL transactions for staff/customer access, immutable confirmation stock, retries, preparation/fulfillment once, stock rollback, prepared-parent consumption, direct-item COGS, production dates and scrap.
- CI runs the production TypeScript/Vite build and the database/preservation suites. Existing dependencies and authentication/POS/returns UI code are preserved.

The branch includes the team's Financials cent-rounding change from `bcc695824fae369403f6295e5077ffd861f7c2ea`. The corresponding preservation snapshot and calculation test now exercise that current implementation.
