# MRP purchasing review and Settings update

This update connects the confirmed-demand MRP minimum with an optional EOQ/review-policy purchase quantity. It does not create demo orders, change BOMs, post inventory, or rewrite historical transactions.

## Behavior

- Cover confirmed demand is the default. Gross requirements, shortages, weekly/daily views and original deadlines are unchanged.
- Include routine replenishment compares the MRP minimum with the shared EOQ/review policy. A component is topped up once at its earliest requirement. Extra packs are credited toward later requirements so the same demand is not purchased twice.
- The review displays gross demand, on-hand/datetimed receipts, shortage, minimum packs, raw/shelf-adjusted EOQ, local usage, the routine target, selected packs, incremental cost, original requirement/order-by dates and the resulting purchase schedule.
- EOQ uses the existing shared ordering options, supplier lead, item cost, supplier pack conversion and the existing 180-day historical usage source. MRP uses the selected location; Inventory Review retains its existing combined-business scope. Differences are explicitly labeled.
- Shelf-life limits constrain optional routine replenishment. They never erase confirmed demand. Whole-pack rounding or confirmed requirements may exceed the historical shelf-life target and produce a warning. No local usage produces no extra replenishment. No supplier MOQ is invented.
- All existing drafts at the same destination and SKU are checked together, including manual, Inventory Review and MRP drafts. Drafts never count as incoming supply. Intentional dated groups within one MRP request are allowed.
- Both screens expose existing drafts. Inventory Review opens the specific draft; MRP identifies draft numbers and links to Purchase Orders. Existing unissued draft quantities/prices can be reviewed and edited, with revision checks, idempotency and audit history. Editing does not issue a PO, alter its location or change MRP dates.
- Issued PO receipts are netted on their scheduled date and destination. Receiving continues to post actual stock and invoices once.
- Settings has one authoritative shared ordering form, readable responsive controls and a separate local checkout tax estimate rounded for display. Duplicate browser ordering controls are removed. The local tax estimate is explicitly distinguished from the shared server tax rate. Customer availability thresholds and reason codes are preserved.

## Rollout

1. In the existing Supabase project SQL editor, run the complete file `supabase/migrations/202611210002_mrp_eoq_review.sql` once. It is safe to run again. Earlier shared purchasing, history, completion and MRP hardening migrations are prerequisites.
2. Confirm the query completed without errors. The result of the advisory-lock statement itself may be blank; inspect the outcome of the entire script.
3. Merge the checked PR and wait for the existing GitHub Pages deployment to succeed. Refresh the site.

The new SQL only replaces reviewed functions and keeps existing permissions. It adds coherent policy/draft data to the planning snapshot and serializes duplicate-draft checks through the existing purchasing lock. The old website remains compatible while SQL is installed. Do not run any `tests/sql/` files in production.

## Review walkthrough

Use an actual confirmed unprepared order. In MRP select a purchased component with a shortage and review PO drafts. Compare the default minimum with Include routine replenishment. An increase depends on local historical usage, existing supply, shelf life and ordering settings; it is correct for the two choices to match. Inspect cost and dates before creating a draft. In Inventory Review, choose the same destination and verify that the existing draft is shown rather than duplicated. Issue and receive only real purchases.

## Verification

- Pure calculation tests cover default preservation, local usage, one-time EOQ top-up, later-date credit, deadlines, price/pack conversion, shelf limits, zero usage and cross-workflow draft lookup.
- Disposable PostgreSQL tests cover repeat installation/data preservation, policy source, cross-workflow refusal, location separation, dated groups, request recovery, draft editing, actual receiving, stale policy revisions and permissions.
- Native PostgreSQL concurrency test verifies that competing workflow saves create one draft only.
- Browser tests exercise the actual MRP review choice and payload, existing-draft review, Settings form uniqueness/rounded tax, responsive screenshots and existing POS/navigation/receiving flows.
