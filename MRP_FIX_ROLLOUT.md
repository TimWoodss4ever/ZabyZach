# Confirmed-order MRP fix

Future staff and customer orders now become dated MRP demand at confirmation.
Confirmation succeeds without current ingredients; preparation checks and issues
the stock and records the sale/COGS in one transaction. Immediate POS sales retain
their current behavior. Simulated customer payment remains separate from the
inventory and revenue posting.

## Install on the existing project

1. In the existing Supabase project's SQL Editor, run the complete contents of
   `supabase/migrations/202611190001_mrp_confirmed_demand.sql` once. This is the
   only new production migration for this fix. It requires the existing shared
   MRP, completion and numbered sales-order rollout already observed in the
   diagnostic export. Do not replay older migrations, bootstrap or test files.
2. After SQL succeeds and PR checks pass, merge this branch into main to deploy
   the matching UI through the existing GitHub Pages workflow.
3. Refresh staff/customer tabs. New confirmed, unprepared orders appear in their
   pickup location's MRP. Preparation removes that demand and consumes stock
   once. A shortage at preparation rolls the transaction back and leaves demand
   open for planning; confirming the order itself does not require stock.

The database change works with the previous client too, so SQL can be installed
first. This repository's Pages workflow does not install Supabase SQL. Deployment
is incomplete until both the SQL and frontend are installed.

## Existing records

The migration replaces four RPC definitions and their existing grants. It does
not update, reverse or re-import historical orders, sales, BOMs or inventory.
Orders with an existing sale link continue to count as already consumed. Their
preparation never issues components again; cancelling one that is still
unprepared reverses only its actual sale transactions, once. The UI labels these
orders explicitly instead of hiding their reason for exclusion from MRP.

Do not clear existing sale links or restore their stock by hand to make them
appear in MRP. That would risk duplicated stock and incorrect revenue.

Overdue open purchase receipts are still flagged and excluded until genuinely
received or rescheduled. Review the actual delivery status; this change does not
guess delivery dates or mark stock received. Multi-line POs produce one overdue
alert each. Overdue unprepared orders remain flagged even if their stock was
posted under the earlier checkout flow.

## Verification

- `npm run build`
- `node tests/run-all.mjs`
- Native PostgreSQL CI runs preservation tests, the five-seeded-parent BOM suite,
  shared-MRP lifecycle tests, and `tests/sql/mrp-confirmed-demand.sql` against the
  final installed function versions. Confirmation without stock, partial PO
  receipt conversion/dates, failed-preparation rollback, simulated tender,
  repeated prepare/fulfill/cancel/close, historical stock preservation, immediate
  POS, and caller authorization are asserted.
- `tests/sql/mrp-concurrency.mjs` uses independent PostgreSQL sessions to check
  concurrent same-request confirmation, prepare/fulfill retries across both
  endpoints, and two orders competing for the last component.
- Existing SQL migrations are unchanged. CI applies the final order migrations
  after the older preservation checkpoints, rather than overwriting the final
  functions with earlier versions before testing them.

Local database verification used an isolated PostgreSQL WASM engine; its
unavailable pgcrypto extension declaration was omitted, with PostgreSQL's built-in
`gen_random_uuid` retained. Multi-connection race tests belong to native CI.
No production test transactions or signed-in production UI checks were performed.

## Assignment demonstration after deployment

Use a fresh future confirmed order rather than an already-posted historical
order. Show its parent quantities, the per-unit BOM, gross component demand,
on-hand stock, dated remaining PO receipts, net shortage, pack-rounded suggestion
and requirement date minus lead time. With enough stock, zero suggested purchase
is correct even though gross demand is visible. Use isolated test data to show
shortages; do not inflate or overwrite real orders to force a purchase suggestion.
