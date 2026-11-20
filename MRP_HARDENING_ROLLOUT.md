# MRP planning and order hardening

This update prepares the real order and planning workflows for the assignment.
It adds no demo mode, seed orders, sample purchases or inventory adjustments.

| Assignment need | Resulting behavior |
| --- | --- |
| Five or more BOM parents and component quantities | Existing catalog/BOMs are preserved. Recipes remain visible per parent unit. |
| Confirmed orders multiply through the BOM | New unprepared orders remain demand. Later pickups are considered when production lead time puts their component requirements inside the displayed window. |
| Inventory and open PO netting | Existing location/date netting is retained; only the visible four weeks are displayed. |
| Suggested quantities and order-by dates | Pack rounding is preserved. Drafts are separated by requirement date, retaining need-by and order-by dates in purchasing. |
| Component consumption | Preparation and immediate POS behavior from the previous fix are preserved, including once-only legacy order handling. |
| Clear four-week view | Weekly remains the default. Daily shows one seven-day period at a time, with previous/next week controls. |

## Included corrections

- Checkout/recovery returns the actual persisted order status. A cancelled saved
  order is never presented as a new confirmation or silently reopened.
- New orders freeze their line prices, rounded subtotal/discount/tax/total and
  tax rate. Preparation uses the frozen quote even if catalog or tax settings
  change. Immediate POS still uses its current pricing/tax workflow.
- Legacy order history is not rewritten. Linked historical sales retain their
  recorded amounts. Unposted orders created before quote storage existed have
  no recoverable original tax snapshot; their fallback total cannot be promised
  to match an earlier browser-only quote.
- MRP draft saving rejects an outdated planning revision while preserving
  recovery of a previously committed request. Explicit draft saves briefly lock
  relevant source tables for a consistent revision check; browsing stays read-only.
- Separate dated drafts keep later requirements visible. While a draft, its
  expected date shows the material requirement date. Issuing it uses the existing
  supplier lead-time arrival calculation; the original need-by/order-by dates
  remain visible. Issue on the planned date after review; early issue can result
  in early delivery. This does not pretend the supplier promised a later date.
- Nested component details display the actual sales order number.
- The empty state explains how to create eligible real demand and how to inspect
  stock without orders. No demonstration records are injected.
- Production creation requires a completion date and creates/schedules the batch
  atomically through a durable request. An uncertain response can be recovered
  without duplicating the batch.

## Rollout

1. Review the PR and its checks.
2. On the existing Supabase project already running the prior MRP fix, apply only
   `supabase/migrations/202611190002_mrp_planning_hardening.sql`.
3. After SQL succeeds and all checks pass, merge/deploy the matching frontend.
   The Pages workflow does not install SQL. Do not replay historical migrations
   or run test fixtures on the live project.

The migration adds nullable quote/scheduling columns, a private production request
table and revised RPCs. It does not backfill, reverse or reseed business records.
The latest purchasing/barcode/name-search changes and the stock-visibility
posting safeguard from PR #21 are retained. The new migration does not replace
the stock-posting engine.

Older open browser tabs without the planning revision will need a refresh to the
new frontend before saving MRP drafts. Existing durable purchase-request retries
continue recovering their original result.

## Verification

- Production TypeScript/Vite build and the existing application/preservation suite.
- Pure regressions for lookahead, bounded weekly display, dated draft quantities,
  changed selections, quote display/status recovery and production requests.
- Disposable PostgreSQL regressions for unchanged history and repeat migration,
  frozen quotes/catalog prices/tax, cancellation recovery, stale-draft refusal,
  dated drafts and issue dates, atomic scheduling, retries and access controls.
- Native PostgreSQL concurrency checks for identical draft requests and competing
  saves from the same planning revision.
- Browser checks for daily/weekly switching, week navigation, dated draft review,
  readable order references and existing desktop/mobile MRP/POS/navigation flows.

Synthetic records exist only in disposable test fixtures. No production records
or application demo datasets are created by this update or its preparation.
