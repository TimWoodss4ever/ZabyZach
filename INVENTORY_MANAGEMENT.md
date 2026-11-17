# Inventory management changes

Based on `main` commit `42b3b0da9e7e2ae26124aa0dd3ca12b1acdce725`.

## Staff workflow

Inventory opens on **Stock**, with one tab each for **Stock**, **Backorders**, and **History**. Stock compares physical quantities across Provo Campus Store, Orem Store, and Central Commissary, or a selected location. Backorders are not stacked above the stock table. The shared location filter applies to every tab.

**Choose action** on a stocked item opens the existing validated Transfer, Physical count, or Damage/loss form with that item and a starting location selected. These actions remain Manager-only in the UI. Physical-count inputs start empty; zero is accepted only when explicitly entered. **View item & availability** shows the location balances, incoming PO evidence, recorded backorders, supplier lead time and reorder calculation. **Barcodes & labels** opens the existing printable barcode catalog.

Made-to-order pizzas and sides show physical finished stock separately from **can be made** ingredient capacity at each location. The capacity calculation combines repeated recipe ingredients, expands made-to-order subrecipes, and requires make-to-stock components such as dough to have been produced already. It does not reserve ingredients or promise a preparation time.

Reorder levels use actual Sale, Production/Production Issue and Backorder Fulfillment consumption at that location over 180 days, divided by 180, multiplied by the current supplier lead time plus stored safety days. Waste and transfer withdrawals are excluded from demand. Missing usage or an active supplier lead time produces no invented reorder value. The original historical inventory loader remains preserved, but the active workspace uses the shared snapshot and filtered usage reads instead.

**History** shows up to 100 of the newest matching real ledger records with location, reference, quantity change and reason. Times use America/Denver. It is a read-only view, not a browser demo ledger.

**Record backorder** saves an order/customer reference, item, destination, quantity still owed, and optional notes. The queue records requested, issued, remaining, and cancelled quantities. Recording demand does not change physical stock. **Issue stock** handles partial or complete fulfillment and debits inventory once; **Cancel remainder** retains the issued history and a cancellation reason. These actions do not create sales or payments, so the same stock must not be charged/issued a second time at checkout. Older backorders are considered first when estimating availability and issuing stock. They are planning demand, not a new POS reservation mechanism.

## Availability rules

- Stock at the selected location covers the relevant quantity: available today.
- Future issued/partially received POs cover it: use the date when cumulative remaining receipts cover the quantity, including older open backorders. Ordered packs are converted to base units. Another location's PO does not satisfy this destination.
- No outstanding PO and an active supplier is assigned: show today's date plus that supplier's current quoted calendar-day lead time, explicitly labeled **if ordered today**.
- Overdue deliveries or insufficient scheduled receipts: no confirmed availability date. Show the outstanding deliveries and a separate new-order planning estimate where possible.
- Made-in-house items: show stock or actual inbound receipts; otherwise request a production completion date instead of inventing a supplier date.
- Missing/inactive suppliers: no new-order estimate. Negative on-hand balances require reconciliation before promising an availability date.

Stock and Backorders share one stock snapshot and refresh owner. They refresh together every 15 seconds while visible, on focus, and after inventory writes. A write arriving during a read queues another read; errors retain the last successful data with a visible stale-data warning. History refreshes when that shared refresh completes. All open backorders and the most recent 100 closed records are included. Stock can change after a forecast; the server rechecks quantities when issuing it.

## Transfers, counts, and damage

The existing transfer and count screens now use the idempotent inventory write gateway. Transfers still post paired outgoing/incoming ledger entries. Retries retain the original request ID in browser storage, and the server returns the first result rather than issuing stock twice. Unconfirmed requests remain visible for explicit retry. Direct legacy transfer/count RPCs retain their signatures and now share the stricter validation.

Physical counts must be finite and nonnegative. Each-unit items require whole numbers; ounce items permit fractions. Only the five approved reason codes are accepted. Damage/spoilage/loss reasons cannot increase stock and post as Waste; cycle-count corrections post as Adjustment. For damage, staff enter the quantity lost and see an estimated resulting stock before posting. The server locks and rereads current stock before subtracting that exact loss, so concurrent inventory updates cannot turn a stale preview into an incorrect write-off. The ledger retains the staff ID, reason, previous quantity and counted quantity. Manufactured-item issues/transfers use nested recipe material cost.

Anonymous users, customers, and users without a staff profile cannot read or change inventory through these functions. Direct writes to the new backorder/request/audit tables are denied.

## Database rollout

GitHub Pages deploys frontend code; it does not apply SQL. Apply `supabase/migrations/202611160004_inventory_management.sql` through the team's reviewed Supabase migration process before using the new availability section. Existing inventory, purchasing, sales, authentication, and production records are retained. The migration can be repeated without resetting backorders or inventory history.

The historical `202611130001_in_house_dough.sql` now leaves the modern catalog, costs, stock and PO history unchanged, preventing the dough-to-itself constraint failure on fresh installs. An empty legacy frozen-dough catalog can be upgraded; a legacy catalog with transaction history stops for a reviewed conversion rather than deleting/reinterpreting business records. Already-applied migrations are not rerun merely because the file changed.

The team's seed timestamp repair was renamed to `202611160005_retime_seed_opening_stock.sql` to avoid sharing version `202611160001` with shared reporting. It skips absent fixture IDs on fresh databases, skips an already verified correction, and still rejects partially matched or changed records atomically. Existing databases whose migration history contains the duplicate version should reconcile that history through the team's Supabase process before deployment; no migration repair/reset command is run by this branch.

## Verification

- `node tests/inventory-management.mjs`: quantity/location-aware dates, queue order, forecast labels, unavailable/overdue/production cases, input validation, durable request retries, storage failures and the actual movement submit handler with mocked writes.
- `tests/sql/inventory-management.sql`: real PostgreSQL role/grant checks, migration preservation/repetition, counts, loss reasons, paired transfers, recipe costs, backorder lifecycle, idempotency, PO pack conversion and supplier lead times.
- `tests/sql/inventory-concurrency.mjs`: competing transfers, concurrent retry of the same transfer, and competing backorder fulfillments in separate PostgreSQL connections.
- `tests/sql/dough-migration.sql`: modern/fresh/repeated catalog preservation, empty legacy conversion, and refusal to corrupt legacy transaction history.
- `tests/sql/seed-retiming.mjs`: absent, partial, tampered, matched, and already corrected seed receipts.

The PR workflow runs database fixtures only against disposable PostgreSQL. It never publishes the website or migrates a live database. Existing checkout, reporting, purchasing, and protected-source checks remain enabled. The reviewed baseline and one intentionally changed historical-migration hash are updated explicitly; authentication, POS/returns handlers and the original three database loaders remain preserved.


## Inventory workspace rollout

This UI update adds no migration, table, or RPC. It uses the inventory functions already installed by PR #5. Merge/deploy through the existing GitHub Pages workflow after the PR checks pass. Customer sales-order linking remains a separate integration task: current backorders retain a manual order reference and issuing them changes inventory only, not sales status or payment. Coordinate that work with the MRP/sales-order branch rather than introducing a competing order lifecycle here.

`tests/inventory-workspace.mjs` exercises location-specific recorded usage, zero/missing history, supplier rules, nested recipe capacity, pre-produced dough, paginated data reads, one shared refresh loop, writes arriving during reads, failure preservation, hidden tabs and cleanup. Existing inventory SQL/idempotency/concurrency tests remain unchanged.
