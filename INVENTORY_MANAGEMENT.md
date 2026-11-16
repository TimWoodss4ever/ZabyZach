# Inventory management changes

Based on `main` commit `30281e03c82f88e7798e72fbd012a30dda6b598e`.

## Staff workflow

Inventory retains the existing item-by-location balance table and adds a shared **Backorders & estimated availability** section above it. Choose a location, review items needing attention, or select **All items**. Quantities come from Supabase, never browser sample inventory. The existing catalog seeds Provo Campus Store, Orem Store, and Central Commissary; the screen flags databases with fewer than three locations.

**Record backorder** saves an order/customer reference, item, destination, quantity still owed, and optional notes. The queue records requested, issued, remaining, and cancelled quantities. Recording demand does not change physical stock. **Issue stock** handles partial or complete fulfillment and debits inventory once; **Cancel remainder** retains the issued history and a cancellation reason. These actions do not create sales or payments, so the same stock must not be charged/issued a second time at checkout. Older backorders are considered first when estimating availability and issuing stock. They are planning demand, not a new POS reservation mechanism.

## Availability rules

- Stock at the selected location covers the relevant quantity: available today.
- Future issued/partially received POs cover it: use the date when cumulative remaining receipts cover the quantity, including older open backorders. Ordered packs are converted to base units. Another location's PO does not satisfy this destination.
- No outstanding PO and an active supplier is assigned: show today's date plus that supplier's current quoted calendar-day lead time, explicitly labeled **if ordered today**.
- Overdue deliveries or insufficient scheduled receipts: no confirmed availability date. Show the outstanding deliveries and a separate new-order planning estimate where possible.
- Made-in-house items: show stock or actual inbound receipts; otherwise request a production completion date instead of inventing a supplier date.
- Missing/inactive suppliers: no new-order estimate. Negative on-hand balances require reconciliation before promising an availability date.

Open backorders and current quantities are refreshed every 15 seconds while visible, on focus, and after inventory writes. All open backorders and the most recent 100 closed records are included. Stock can change after a forecast; the server rechecks quantities when issuing it.

## Transfers, counts, and damage

The existing transfer and count screens now use the idempotent inventory write gateway. Transfers still post paired outgoing/incoming ledger entries. Retries retain the original request ID in browser storage, and the server returns the first result rather than issuing stock twice. Unconfirmed requests remain visible for explicit retry. Direct legacy transfer/count RPCs retain their signatures and now share the stricter validation.

Physical counts must be finite and nonnegative. Each-unit items require whole numbers; ounce items permit fractions. Only the five approved reason codes are accepted. Damage/spoilage/loss reasons cannot increase stock and post as Waste; cycle-count corrections post as Adjustment. For damage, staff enter the quantity lost and see the resulting stock before posting. The ledger retains the staff ID, reason, previous quantity and counted quantity. Manufactured-item issues/transfers use nested recipe material cost.

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
