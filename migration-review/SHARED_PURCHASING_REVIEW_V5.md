# Shared purchasing review candidate v5

Baseline: the deployed main merge commit 315a5cd, reconstructed from the supplied branch ZIP, the two successful barcode-import edits, and the reviewed Vite package update. The main guard resolves this abbreviated Git commit to its full object ID and blocks newer group commits. This is not a waiver of the guard.

## Implemented

- New shared supplier, PO, receipt, invoice/payment, management review, and inventory-review screens. The live catalog and destination IDs come from Supabase; new SKUs do not need browser seed entries.
- Atomic partial/final-short receiving, conversion to inventory base units, weighted average cost, actual invoice tax entry, frozen PO terms, and per-delivery invoices.
- Actual-history scorecards with precise fill/score display, overdue incompletes, saved PO promises, and a separate audited management assessment.
- Payment balance and duplicate checks, source-record corrections with reasons, linked receipt/invoice/inventory dates, and stock/payment amount preservation.
- Idempotent request IDs, persisted uncertain-save retries, stale form versions, manager-only RPCs, and no direct access to new tables from browser roles.
- Shared EOQ/ROP review based on actual Sale/Production Issue ledger consumption over 180 days, shared options, and atomic grouped draft POs. No fabricated usage.
- UI refreshes after each save, on window focus, and every 15 seconds for other users' changes.

## Preserved

The original six SQL migrations, existing receipt/sales/production/return RPCs, sign-in code, POS handler, returns handler, report loader/calculations, and three existing database screen loaders are unchanged. The 15 reviewed file hashes still pass. This package does not change package.json, package-lock.json, production deploy.yml, credentials, or local browser demo history. No seed/demo rows are imported into your shared database.

The new migration adds erp_-prefixed tables/columns/functions only. It does not drop/truncate/delete data or replace any existing team RPC. Re-running this same migration retains saved receipts, payments, options and reviews. Existing paid_at invoices remain paid; historical quoted lead is inferred from the original sent/expected dates. Legacy payment terms are estimated from the supplier until frozen by a new transaction. Legacy receipt dates are not silently rewritten.

## Validation status

PASS locally: TypeScript source compatibility, all existing domain/preservation/checkout/report tests, new shared-catalog/metrics/payment/usage/scan tests, actual save-handler tests with mocked transport (duplicate submission, uncertain response, same-ID retry, failed-storage write prevention), and workflow YAML parsing.

NOT RUN locally: actual PostgreSQL execution, clean npm install/production build against the real Supabase package, browser rendering of these new screens, or any live Supabase request. Package installation in this environment is blocked. No compatibility stub, node_modules, build output, credentials or environment file is shipped.

The updated GitHub review workflow must pass before applying SQL. Its PostgreSQL 17 service is disposable and isolated. It applies the team's six original migrations; inserts legacy fixtures before the new migration; checks original row/function preservation; exercises manager/no-profile/customer permissions, final-half and multi-part receiving, tax/terms invoices, partial payments, corrections, rollback, audit, safe reapplication, and two real concurrent sessions. The regular verify job performs the real clean npm install, production build, and all JavaScript checks.

## Boundaries still visible in the app

Dashboard and four-week MRP calculations still summarize browser planning history and are now labelled accordingly. MRP's PO action routes to shared Inventory Review instead of creating disconnected browser POs. Online customer checkout/pickup/rewards and the browser profit/history are still separate from the shared server checkout; existing team guards on reward redemption and custom server modifiers remain intact. Shared purchasing does not complete those separate workflows. Food inventory cost reaches the existing POS through the updated shared items.unit_cost; supplier payment tracking is not a second P&L expense.

## Review sequence

Use a new erp-shared-purchasing branch from current main. Upload root files, then the single review workflow. Wait for BOTH verify and postgres jobs. If main has advanced, compare that group work first. Apply only the supplied new migration in Supabase after these checks pass, then merge and let the existing Pages workflow publish. Never run tests/sql fixture files on a shared database.
