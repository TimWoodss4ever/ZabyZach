# Sales order impact history update

This update adds a **View impact** detail for each Sales Order, shows the order's current MRP demand, posted sale and return amounts, linked inventory ledger entries, and order status milestones. It also removes the extra page heading above the Sales Orders panel, keeping the heading beside the refresh and create buttons.

The database migration adds an order-event history for future status changes and a staff-only RPC to load one order's saved sales, return, and inventory history. Existing order creation dates are preserved as initial events. The migration does not guess old fulfillment or close timestamps.

## Add the website files

1. Extract this ZIP.
2. In the GitHub repository, add or replace `src/App.tsx`, `src/SharedPlanningScreens.tsx`, and `src/style.css` using the matching paths in this ZIP.
3. Commit the changes to a branch and let the GitHub Pages workflow complete.

## Update Supabase

1. Open the SQL Editor for the same Supabase project used by the ERP.
2. Run the contents of `supabase/migrations/202611200002_sales_order_impact_history.sql` once.
3. Do not rerun the earlier migrations. This one is additive and follows the migrations through `202611200001_stock_visibility_guard.sql`.
4. After the SQL succeeds and the site deployment finishes, refresh the ERP and open **Sales Orders → View impact**.

The detail screen distinguishes MRP demand from posted activity: a future confirmed order appears in MRP but does not consume stock or record revenue until preparation. A return reduces net sales; a restocked item increases inventory and offsets its recorded COGS. Card tender remains simulated and does not charge a card.
