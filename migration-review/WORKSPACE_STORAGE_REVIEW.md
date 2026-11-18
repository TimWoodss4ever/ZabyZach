# Local workspace storage review

Reviewed input: ZabyZach-main(9).zip, main be6255a793cbecf4ed6329d286babefd9d422667.

The old synchronous localStorage dataset is roughly 3.8 million characters on
fresh startup. A second original-data backup makes its small per-origin quota
particularly fragile. The phone-startup patch correctly caught exceptions but
retained the oversized data in localStorage and therefore kept showing a notice.
The dataset is still referenced by existing customer/legacy workspace logic;
removing or replacing its records would change behavior. This patch keeps it.

## Boundary

Only these four bulk keys move into IndexedDB:
- zbyzack-erp-v1
- zbyzack-erp-v1-costs
- zbyzack-erp-v1-before-erp-updates
- zbyzack-erp-v1-costs-before-erp-updates

Database: zbyzack-local-workspace-v2; object store workspace; record current.
The record holds values plus an exact first legacyBackup and, only when needed,
a deduplicated archive of conflicting old-tab strings. No historical records
are removed from the workspace. There is no new server schema or dependency.
Auth tokens, welcome/reward keys, sessionStorage and purchasing/planning retry
identifiers keep their existing code and storage. The four bulk legacy keys
are removed only after commit and read-back verification of their exact saved
strings, and only if another tab has not changed the source in the meantime.
The small native-storage space is then available for auth and request IDs.

## Startup and saving

main.tsx displays Opening your workspace while hydration runs, before mounting
App. Native open/transaction operations have time limits. Domain load/save
interfaces stay synchronous against a hydrated memory cache; writes coalesce
into asynchronous read/write transactions. Values changed during a commit stay
queued until that newer value commits. A failed write leaves the pending data
in memory, flags it as unsaved, and permits a later flush to retry. Browser
beforeunload protection is requested while writes are pending; mobile browsers
may not deliver unload/pagehide, so users should allow saves to finish.

Native transaction merging rechecks revisions during migration so a newer tab
cannot be overwritten by a stale migration read. Exact legacy strings that do
not match the current data are archived before cleanup. Ordinary application
full-workspace saves retain the original last-writer semantics; this is not a
new collaborative conflict-merging system for simultaneous local edits.
BroadcastChannel, with a small storage-event fallback and focus refresh, reloads
committed workspace changes in other tabs without replacing pending local edits.
No large dataset is written back to localStorage after initialization.

## Failure and recovery

If IndexedDB genuinely cannot open/read/save, the UI stays usable and a compact
notice offers Details and Download local backup. Successful IndexedDB use does
not show a warning merely because localStorage cannot accept the old large copy.
A failure before verification never removes the old native keys. A failure
later keeps original snapshots in IndexedDB and current unsaved values in memory.
The export contains raw serialized workspace/cost values and retained original
snapshots; it contains no sign-in tokens or durable shared-request IDs.

This preserves SAVED browser data. A page update cannot recover changes that
were already only in an older tab's private memory; finish in-progress work
before refreshing. Do not clear site data as a rollout or recovery step.
After migration the local records live in IndexedDB. A rollback must retain the
hydration/persistence adapter or explicitly restore an exported snapshot; simply
reverting to the old localStorage-only loader would make migrated records appear
missing even though the IndexedDB originals remain. Shared Supabase history is
separate and this patch neither resets nor rewrites it.

## Source preservation

App.tsx, domain.ts, Supabase client, POS/rewards transport, shared purchasing,
planning request logic, barcode labels, camera scanner and every Supabase file
match the supplied main exactly. Existing POS browser assertions are unchanged;
its script only appends the new native-storage suite, so the existing workflow
runs it without another workflow-file upload. The current-main guard remains
intact and its reviewed SHA is refreshed to the supplied main.

## Validation

37 local regression scripts passed, including migration verification, failed
commit/read verification, 4 MB writes, original backups, untouched auth/retry
keys, reload, concurrent old-tab/new-tab saves, pending flush/failed-write export,
blocked persistence and recovery. Focused new-storage TypeScript checking and
Vite source bundling passed. Existing main POS/source hash checks passed.

Local dependency installation is the pre-existing Supabase test stub rather
than the repository's locked production dependencies; full npm build was not
claimed. Local Chromium cannot launch in this runtime. The new browser suite
uses native IndexedDB and actual domain startup, reload and multiple pages,
with injected storage denial, and is appended to the existing GitHub POS browser
job. Full real-dependency build, PostgreSQL and browser tests must pass in GitHub
before merging. Physical iPhone reload/camera verification remains necessary.
No live repository, deployment or database has been changed by preparing this.
