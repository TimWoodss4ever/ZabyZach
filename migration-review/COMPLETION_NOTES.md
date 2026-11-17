# Consolidated ERP completion — 17 November 2026

Revised against ZabyZach-main(5).zip, Git archive baseline ad4a63a0f896454032f1e5f37c8e97048e05cb41. The repository guard remains enabled to catch newer teammate work.

## Latest teammate changes preserved

Compared all files in ZIP (5) with ZIP (4). The teammate update changed 10 repository paths: stock-first inventory loading, server usage aggregation/indexes, nullable usage guards, timing diagnostics, two inventory regression suites, a SQL performance test, documentation, baseline and workflow. Overlaps were limited to InventoryWorkspace.tsx, the CI workflow and the baseline. The UI combines all new loading/error behavior with the requested neutral history wording; the workflow tests both changes in dependency order; the baseline now matches the latest archive. All other teammate changes are byte-for-byte preserved. Eight additional files are protected by hashes (23 total).

The one Supabase installation file now includes the teammate's unchanged 202611170002_inventory_usage_performance.sql first, followed by 202611170003_erp_completion.sql. Both migrations can be repeated. This covers either case: the teammate has already installed the database speed fix, or has only merged its code. There is still only one manual SQL run. GitHub CI runs inventory-usage-performance.sql before completion.sql; completion additionally checks that purchasing history does not alter either usage aggregate or its reorder inputs.

## Result

- Purchasing now has actual linked historical purchase orders, PO lines, final receipts, receipt lines, stock ledger references, supplier invoices and payments. The existing supplier scorecards and Reports supplier-performance table calculate from these records. No separate substitute scorecard-history table is used.
- Receipt quantities come from the existing six-month material-demand history and item purchase-pack conversions. Supplier delivery cadence, lead-time reliability, short deliveries, frozen quotes/terms, prices and payment timing vary. Packaging represents a poor vendor; meat deliveries are less reliable than water/dairy. Ratings remain calculated from delivery records, not assigned values.
- Paid, partial and outstanding invoices are linked to delivered quantities and saved payment terms. Outstanding bills appear first; payment history is initially limited to 30 rows. Recording a payment continues to track settlement without transferring real money or deducting COGS twice.
- Existing team rows remain in place. Imported historic receipts are reconciled against opening stock with paired zero-valued quantity adjustments. Current quantities and existing recorded valuation/COGS are preserved. Corrections to imported receipt dates move the reconciliation entry with them. Import provenance remains in restricted tables/ledger metadata; no AI-generation wording is added to the interface.
- The original installed menu-history batch is reused, not regenerated or reinstalled. Its six-month revenue and recipe-derived costs remain part of Financials/Reports and its material demand informs replenishment/EOQ. These are coursework histories, not recovered original transactions. True historical inventory turnover is still unavailable where opening valuation is incomplete; the app does not fabricate it.
- Financial reports cache expensive stock replay and invalidate on relevant writes, with a 15-second maximum cache age. Purchasing polls return a compact unchanged token when there are no changes. PO-line/payment indexes avoid repeatedly scanning full histories. Barcode Labels loads catalog/open PO data without downloading the entire stock ledger.
- Dashboard sales/profit now use shared posted sales and history rather than browser-only planning figures. Customer checkout posts inventory, revenue and recipe costs in one database transaction. Stored catalog prices are enforced, insufficient stock rolls back the checkout, and durable retries reuse the same request. Preparation/collection never posts a second sale; the old staff endpoint is guarded too. Posted orders require Returns for cancellation/refund. Staff-created unpaid pickup orders retain their existing prepare-time posting behavior.
- Posted pickup orders leave MRP demand because their stock has already been consumed; unpaid confirmed orders remain planned. The team's new MRP UI, recipes, styling, draft workflow and other planning calculations are preserved.
- The existing menu Barcode Labels page/print renderer/layout is byte-for-byte unchanged from this ZIP: all six pizzas, breadsticks and other active menu items are retained. Authentication, POS/returns handlers, original inventory/production loaders and protected files pass preservation checks.
- Command-K/Ctrl-K opens/focuses search. PO details retain Prepare supplier email and the supplier-copy download. Email opens an email draft; the sender attaches the downloaded copy and sends it. Example supplier addresses must be replaced with an address you control for a delivery demonstration.
- One shared phone-camera scanner works in POS and inventory, and is now available in PO receiving. It uses native Code 128 detection where available and a canvas decoder for this project's printed Code 128 B labels otherwise. It requests a rear camera over HTTPS, handles denied permission and releases the camera on close. Inventory/PO scanning selects an item; a manager still confirms quantity and saves the movement.

## Validation actually completed here

- All 32 Node regression scripts completed successfully, including preserved original checkout/rewards suites. Relevant purchasing, MRP, preservation, menu/search and completion tests were rerun after the last code edits.
- Every printed menu code decoded horizontally/vertically, reversed and with moderate pixel noise; flat/low-contrast and checksum-corrupted input was rejected.
- Mock-camera lifecycle tests passed for missing/broken native detection, native success, denied permissions, delayed permission after closing, stream cleanup and stopped scan loops.
- Large-history index tests passed for 1,000 PO/invoice lookups over 10,000 lines/payments. Paid checkout no longer creates a second MRP requirement.
- Vite source bundling completed using the available local test environment. This is NOT a successful full production build: the local Supabase dependency is a test stub and the available Vite version differs from package-lock.json. The full TypeScript check consequently reports missing test-stub types. Neither test dependencies nor generated dist files are included in this update. The combined source was bundled again after merging the latest teammate work.
- A browser test was attempted but Chromium could not launch because this execution environment forbids its socket operation. No physical phone camera was tested. No live project was changed.

## Checks still required before production SQL

The supplied erp-review.yml runs npm ci and the full production build with the repository's locked dependencies, Node regressions, PostgreSQL 17 integration/concurrency tests, and the team's MRP browser tests. Wait for verify, postgres and mrp-browser jobs to pass on the final PR commit. Supabase Preview may remain skipped.

New tests/sql/completion.sql (DISPOSABLE CI ONLY), after the teammate performance suite, installs and reinstalls the migration, checks old-row preservation, all seven supplier histories, multiple unpaid/partial/paid invoices, frozen invoice terms, receipt/stock linkage, current quantity/P&L/valuation preservation, receipt correction reconciliation, cache/private-access rules, immediate customer checkout at server prices, retry/old-endpoint/collection safety, and shared dashboard revenue and COGS.

PostgreSQL was unavailable here, so these integration tests have not been executed locally. Do not substitute the test scripts for the one production SQL file.

## Installation scope

Run only the combined 3-RUN-IN-SUPABASE.sql once. It contains the unchanged teammate migration 202611170002_inventory_usage_performance.sql, then 202611170003_erp_completion.sql, each in its own transaction. The new historical import is guarded against duplicates. Reinstallation does not regenerate records or reset later payments. It adds helper functions, caches, triggers and a safe wrapper for the old pickup-action RPC. New internal tables/functions are restricted; public endpoints enforce existing role checks. Original SQL migrations are unchanged.

Do not rerun the old menu-history or supplier-correction packages. If the older supplier-correction package was already installed, its parallel sample-history tables are left untouched and are not used by these calculations.

After installation, real checkouts post immediately to Supabase; other open screens refresh via sales events/focus/15-second polling. This is not a real payment-gateway integration. A phone must load the HTTPS deployed site, allow camera access and successfully read a printed label before camera support is considered verified for that phone/browser.
