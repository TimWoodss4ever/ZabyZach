# POS loyalty and checkout update

The previous POS stored reward profiles in browser data but submitted sales to Supabase. Shared checkout could not enroll those profiles, did not award their points, and rejected redemption. The update uses staff-only Supabase RPCs for normalized phone lookup, enrollment, point balances, and atomic sale/redemption posting.

The existing policy remains 1 point per full dollar after discounts and before tax; 100 points buys $5 off an order of at least $5 after other discounts. Shared balances reflect cumulative returned quantities, including zero-dollar rewarded sales. Negative balances after returning earlier earned purchases must be earned back. Points begin with sales made through this updated POS; historical browser demo balances and previous shared sales are not converted. Exchanges reverse the original sale's points; replacement sales through the existing exchange screen do not earn new points.

The migration adds membership/request tables and sales fields, and wraps the existing record_sale function without replacing it. Multiple existing customers with the same normalized phone cause an explicit duplicate-record error instead of an automatic merge. Checkout serializes membership/phone access so two tills cannot spend the same points. Request IDs prevent duplicate sale posting on retry. An uncertain checkout is stored in sessionStorage; Recover checkout confirmation resubmits the same ID and payload, including after reloading the tab. Keep that tab/browser session open until confirmation is recovered.

On desktop, the menu and order items scroll independently within a viewport-height workspace. Totals and Complete sale stay in the order footer. Customer/rewards controls expand above the items. Smaller screens stack the bounded menu and order panels. The previous browser-demo pickup queue and next-call number were removed from shared POS because they did not represent the posted database sales. Unsupported customization controls were removed from the checkout UI. A shared sale stores its call name, but this change does not add a shared pickup queue or call numbering system.

## Rollout

1. Require the build, workflow regression suite, PostgreSQL loyalty tests, and POS browser checks to pass on the final branch head. Reconcile any newer work on main and the other open PRs before merging.
2. Apply supabase/migrations/202611170003_pos_loyalty.sql once to the existing Supabase project before deploying the frontend. Existing migrations, including returns, are prerequisites. This schema migration does not convert or rewrite historical sales or customers.
3. Merge/deploy the matching frontend through the normal Pages workflow.
4. In a designated test store/account, verify new enrollment, lookup from another session, points earned, $5 redemption, partial/full returns, and recovery after an interrupted response. These checks post real transactions if run in production; use a disposable database first.

No live database migration or deployment was performed while preparing this PR.
