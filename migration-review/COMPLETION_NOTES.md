# Combined completion update — current main review

Input main ZIP: ZabyZach-main(6).zip, commit 2a87e7229de41386cc1aa95d7344392d7e91a379.
Input completion ZIP: ZabyZach-erp-final-completion-v2.zip, commit 59295843734c7b5673ac2049180a712a1bfad5d0.
Common reviewed base: ZabyZach-main(5).zip, commit ad4a63a0f896454032f1e5f37c8e97048e05cb41.

The five conflicting files are combined: App.tsx, SharedPurchasingScreens.tsx,
team-supabase-checkout.mjs, erp-review.yml, baseline.json. Every file from the
latest main is retained. The latest main POS component is retained exactly;
its shared rewards, durable checkout/recovery and sticky checkout UI are
verified by source hash and the existing functional regression tests. Latest
main navigation hover/focus/touch behavior, ordering settings, purchase-pack
validation, review notes/history/schedule, and CSS remain in the combined app.

Completion features retained: linked supplier/PO/receipt/invoice/payment history,
shared Dashboard and Financials, compact purchasing refresh and report caching,
menu barcode layout and printer, Command/Ctrl-K, supplier email drafts,
shared camera fallback in POS/inventory/receiving, and phone checkout posting
stock/revenue/COGS exactly once. Already-paid pickup stock is not planned twice.

Both branches named a migration 202611170003. The teammate POS migration stays
202611170003_pos_loyalty.sql unchanged. The completion migration is renamed
202611170004_erp_completion.sql; its entire SQL body is unchanged. This avoids
ambiguous version numbers on future fresh installs. The installed database
functions/import marker do not depend on the filename. Existing completion
records, invoices and payments must NOT be regenerated. No Supabase script is
provided or required for the merge: the user already installed completion SQL.
The existing main POS feature retains its existing database prerequisites.

The CI workflow retains all original tests plus the main POS/rewards database
suite, POS browser suite and navigation/settings browser suite. Completion runs
after the main suites. Its slow row-by-row preservation search stays replaced
with EXCEPT ALL table comparisons, progress/timing output and per-statement
limits. A combined checkout database assertion now exercises both phone posting
and the main POS/rewards wrapper, including retry/stock/COGS/points behavior.
The navigation browser transport fixture supports the shared dashboard and
compact purchasing RPC; assertions on draft/settings/review saves remain.

Validation completed locally: all 34 existing regression scripts passed, and
the added combined-team check passed (35 total). Focused POS handler/transport,
review/settings, preservation, menu/search, MRP/planning and purchasing tests
passed. Source bundling completed. The latest main POS component, barcode page,
MRP workspace, POS transport, loyalty migration, team CSS and navigation browser
assertions match the reviewed latest main; migration versions are unique.

Limits: this environment has a Supabase test stub, not the repository's real
locked dependency installation. Full production TypeScript build and live
PostgreSQL/browser execution were not completed locally. GitHub must run npm ci,
its real build, PostgreSQL and all browser suites on the combined branch before
merging. Previous branch checks passed but do not replace combined-branch checks.
No external branch, PR, website or database was changed by preparing this ZIP.

Rollout: create erp-final-combined-v3 FROM CURRENT main, upload this package,
create a new PR to main, pass checks, merge and wait for Pages deployment.
After the replacement is merged, close old PR #13 without merging it. A new
branch is required because file uploads alone do not create a two-parent merge
commit to resolve the old PR's ancestry conflicts. The newer-main guard stays
enabled to protect any later teammate changes.
