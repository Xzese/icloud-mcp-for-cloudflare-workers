# Durable reminder jobs

Jobs are **request-driven on both Cloudflare Workers and ChatGPT Sites**. No Cloudflare
Queue, consumer binding or cron runner is required or supported. Starting a job saves its
reviewed manifest and authorization in D1; only authenticated `continue_reminder_job` calls
execute bounded slices. Status GETs never dispatch, renew Apple credentials, schedule a timer
or execute through `waitUntil`. `executionMode` and `connection_status` always report
`request-driven`, and `autonomousJobs` is false.

**Initial support:** current simple-reminder bulk creation is a permanent connected-account
capability once the additive job schema is installed. No feature flag or extra approval
setting is required; the authenticated owner still reviews and authorizes each exact manifest.
Simple bulk deletion is also permanent. Preview performs a read-only preflight of every target:
missing or already-deleted, stale-tag, duplicate, recurring, alarmed, nested and parent reminders
(one complete subtask scan per list) fail before sealing and are never dispatched. Execution sends
each remaining item through the single-item delete path, which repeats exact lookup and complete
family inspection before a version-guarded native soft-delete. The final plan must still contain
only the approved root; a newly discovered family is rejected rather than cascaded.

The transaction guards the root and List. Observed native child attachments advanced those
versions, but a universal native predicate for "has no children" remains unproven. A read-only rescan after
each confirmed deletion reports it as `SUBTASKS_REMAIN` (or `SUBTASK_CHECK_INCOMPLETE` when the
rescan fails) on the succeeded item. A lost acknowledgement stays `unknown`; read-only
reconciliation reports whether the target is deleted, never replays and never claims who deleted it.
Linked creation remains unsupported separately.

**Bulk updates and completion:** after migration `0004_bulk_change_jobs.sql`, jobs also accept
`bulk_update` and `bulk_complete`. Both require exact list/reminder/version inputs and an
ordinary childless root. Updates accept nonempty title, notes, priority, flagged, dueDate,
timeZone and allDay changes. Recurrence, alarms, early alerts, start dates, subtasks and parents
are refused. Date transitions that change linked scheduling fields, including all-day
conversions, are refused; use an individual prepared update for those transitions. Existing URL/tag relationships are preserved.

Preview and dispatch share the same update planner. Dispatch rechecks childlessness and
guards the exact List version; completion cannot cascade to a newly discovered family.
After an uncertain response, recovery compares the encrypted planned write, including
implicit time-zone/all-day changes. Matching state sets `desiredStateObserved` but never
turns an uncertain request into a confirmed operation or authorizes replay.

## Public flow

| MCP tool | Authenticated API |
| --- | --- |
| `create_reminder_job` | `POST /api/reminder-jobs` |
| `append_reminder_job_items` | `POST /api/reminder-jobs/:jobId/append` |
| `preview_reminder_job` | `POST /api/reminder-jobs/:jobId/preview` |
| `start_reminder_job` | `POST /api/reminder-jobs/:jobId/start` |
| `get_reminder_job` | `GET /api/reminder-jobs/:jobId?offset=0&limit=50` |
| `cancel_reminder_job` | `POST /api/reminder-jobs/:jobId/cancel` |
| `resume_reminder_job` | `POST /api/reminder-jobs/:jobId/resume` |
| `continue_reminder_job` | `POST /api/reminder-jobs/:jobId/continue` |

API action bodies omit `jobId` (it is in the route); MCP action inputs include it.
All API writes require the authenticated owner and JSON same-origin requests. Identity is
never taken from an input owner/account field. Unknown fields are rejected.

Create a draft with `kind`, UUID `idempotencyKey` and required `expectedGeneration`.
The normalized job UUID is the job key, so a lost acceptance response has a known recovery ID.
Append ordered items using a separate UUID `chunkKey` and current `expectedRevision`.
An item contains `kind`, a unique `clientItemKey`, and strict `input`:
current creation fields plus its own retained UUID, exact deletion/completion list/ID/version,
or exact update list/ID/version plus nonempty `changes`. Defaults and creation UUID/date
representations are canonicalized before hashing. Updates normalize only a supplied non-null
dueDate; omitted fields and explicit nulls remain distinct.
Same job/chunk replay returns its existing ledger; changed reuse conflicts. Mutation keys are
reserved account-wide, including across jobs and session generations. Cross-job key reuse
must be reviewed through the original known job, never dispatched through another manifest.
Equal titles with distinct approved UUIDs are distinct reminders.

Preview seals and validates the entire accepted manifest, checks live creation-list access
(at most 50 distinct lists), and reports unsupported items as failed with zero dispatch.
It returns counts, first-page exact inputs/results and a ten-minute encrypted preview token.
Review **all** pages using `get_reminder_job`, obtain user authorization, then start with that
token. It binds owner/account/generation/job/kind and the immutable manifest. It does not itself
constitute authorization. Start does not execute Apple writes.

Each continuation selects at most three items in original ordinal order and within a bounded
slice deadline. Results include the stable client key, approved input/target, status,
attempts, sanitized code/recovery message and separate `operationConfirmed` /
`desiredStateObserved` flags. Counts come from durable item states.
Mixed failures finish as `completed_with_errors`, never `completed`.
Execution order does not promise Apple-app display ordering.

| Limit | Default |
| --- | --- |
| Items per job | 1,000 |
| Ingestion | 50 items and 64 KiB per complete request |
| Serialized job input | 2 MiB |
| Active jobs per owner | 5 (unresolved work remains active) |
| Runner slice | At most 3 items / 75-second budget |
| Result page | At most 50 items, shortened at 256 KiB |
| Job authorization | 24 hours or existing absolute session deadline, whichever is earlier |
| Accepted attempts per item | At most 5 |

## Dispatch, recovery and cancellation

Jobs use an account-wide CAS lease plus a job lease. Each Apple operation separately acquires
and releases the existing session lease. Job/account claims do not replace the session fence.
Dispatch saves the exact encrypted generated mutation and durable intent **before** calling
Apple, then checks the session lease and job cancellation/expiry immediately before submission.
The executor validates bounds before that intent callback.

Recovered `preparing` without intent is undispatched and can be prepared again.
`dispatching`, `verifying`, `unknown`, or durable intent is potentially submitted.
Only exact stable-ID reads are allowed for its recovery; no automatic mutation replay.
A matching fresh record sets `desiredStateObserved=true` but remains **unknown** without a
valid operation receipt. A missing or altered ID also remains unknown, not failed/safe-to-retry.
Independent pending items can continue while unresolved items remain visible.
`needs_attention` work never expires silently into success.

Known undispatched transient errors, lease contention and definite rate rejections can retry
within the attempt/lifetime cap. Backoff has capped exponential jitter and persisted Retry-After;
the account cooldown prevents other jobs from bypassing throttling. Ambiguous responses,
redirects, lost acknowledgements or fences are never automatically replayed.

Cancellation is persisted first, cancels pending items and is checked before preparation and
immediately before dispatch. In-flight work can still finish or require reconciliation.
Cancellation is **not rollback** and never deletes successful creates or restores deleted items.
The state/counts distinguish succeeded, cancelled-before-dispatch and unresolved items.

Disconnect, generation replacement, account mismatch, expired retention or required Apple
approval pauses work. Resume verifies the original account and generation and does not extend
the manifest or session expiry. A new session cannot be silently substituted; reviewed cross-
generation reauthorization is not implemented. Status/cancel remain available without Apple.

## Storage, migration and rollback

`migrations/0001_reminder_jobs.sql` is the immutable additive job initializer.
`migrations/0004_bulk_change_jobs.sql` expands the allowed job kinds, rebuilding the jobs
table and its dependent tables in one migration transaction while retaining encrypted rows,
leases, chunk receipts and replay reservations. Fresh installs use the current `schema.sql`.
The tables are jobs, items, chunk receipts, account-scoped replay reservations, account
leases/cooldowns. The immutable original migration also retains a historical outbox table;
current execution does not read or write it. Owner-scoped reads always use the authenticated
deployment owner before database access. Item content, target IDs, generated mutations and
detailed results use the existing AES-GCM primitives with a separate job/item/field AAD context.
The Apple session envelope schema and rows are unchanged.

Apply missing migrations in order to an existing standalone database, using private operator config.
Databases with the job tables already installed need `0004` for bulk changes.
Independent connector filters/create workflows/list duplication additionally need migrations
`0005`, `0006` and `0007`; service settings (`0002`) and Drive operations (`0003`)
also belong to the shared migration history. Apply pending migrations in order:

```bash
npx wrangler d1 execute icloud-reminders --remote --config wrangler.production.toml --file migrations/0001_reminder_jobs.sql
npx wrangler d1 execute icloud-reminders --remote --config wrangler.production.toml --file migrations/0002_service_settings.sql
npx wrangler d1 execute icloud-reminders --remote --config wrangler.production.toml --file migrations/0003_drive_operations.sql
npx wrangler d1 execute icloud-reminders --remote --config wrangler.production.toml --file migrations/0004_bulk_change_jobs.sql
npx wrangler d1 execute icloud-reminders --remote --config wrangler.production.toml --file migrations/0005_connector_filters.sql
npx wrangler d1 execute icloud-reminders --remote --config wrangler.production.toml --file migrations/0006_create_workflows.sql
npx wrangler d1 execute icloud-reminders --remote --config wrangler.production.toml --file migrations/0007_list_duplication.sql
```

For Sites, the build packages the complete immutable migration history (`0000`–`0007`)
under `dist/.openai/drizzle`. Later schema changes append new migration files;
changing an already-applied initializer does not install new
tables. Preserve the exact ignored Site binding, use the native source workflow, regenerate
with `npm run sites:prepare`, and verify application of the pending additive migration to its
existing D1 before using the new kinds. `connection_status` advertises `bulkUpdate` and
`bulkComplete` only when the expanded schema is present and the session is ready.
Never reset D1, overwrite an Apple session,
replace the Site or publish generated private source history.

Resolved encrypted item content/results/mutations are eligible for deletion after seven days,
on subsequent authenticated job creation (request-driven retention, not a timed purge).
Minimal replay reservations and job metadata remain indefinitely: an expired old key is
explicitly rejected, never treated as a new request. No unknown or in-flight item content is
purged. Older content reads return `JOB_EXPIRED` explicitly. Retain old encryption keys while
any unresolved envelope needs them.

For local acceptance with a login already stored in another checkout, the local launcher
can use that existing ignored state without copying credentials or replacing its owner/key:

```bash
LOCAL_ICLOUD_STATE_DIR=/absolute/checkout/.sites-runtime/local-icloud LOCAL_ICLOUD_PORT=5174 npm run dev:icloud
```

The explicit directory must already contain `keys.json`. Stop any other server using the
same state before launching. Verify session-envelope compatibility before selecting another
checkout's state; an unsupported authenticated schema must fail without invalidating it.
Prefer isolated test state with its own normal sign-in. Build the current checkout first
and retain the original session generation and fixed expiry. Only separately authorized synthetic test-list
reminders may be mutated.

To stop new dispatches, cancel undispatched authorized jobs and stop continuation calls. Preserve all tables, receipts, encryption keys and Apple session state, and keep
a compatible status/reconciliation reader. Do not drop/reset storage or disconnect as rollback.
Slice logs contain only event name, processed count and state, not reminder text, raw Apple
responses, credentials, cookies or full IDs.

Synthetic SQLite and built-Worker checks cover duplicate/chunk handling, bounded execution,
encrypted storage, cancellation, version/session fencing and lost acknowledgements. Supported linked scheduling recipes require the separate native evidence and checks described
in [the protocol evidence gate](linked-record-protocol.md).

## Queue-free operation and upgrades

After reviewing and starting the exact manifest, call `continue_reminder_job` until the job
is terminal or needs attention. Each call processes at most three items. Respect `nextRetryAt`
before another call; review authentication pauses and unknown outcomes instead of blindly
retrying. `get_reminder_job` only reads progress. If continuation calls stop, the durable job
waits without executing Apple writes. The API state `queued` means authorized work waiting
for a continuation, not an external Cloudflare Queue.

Both deployment entrypoints expose request handling only. Standalone configuration generation
rejects Queue producers/consumers, cron schedules and the retired `REMINDER_JOB_EXECUTION_MODE`
/ `REMINDER_JOB_QUEUE_NAME` variables. Remove any legacy delivery bindings and schedules from
private operator configuration before building an upgraded standalone deployment.

The existing job, receipt, session and authorization data remain intact. Previously started
jobs can use authenticated continuations under their original account/session fences; ambiguous
dispatches still reconcile through reads without replay. The original SQL migrations and
historical `reminder_job_outbox` table remain unchanged for upgrade compatibility, but runtime
job availability and execution do not depend on that table. Do not reset D1, remove receipts
or replace a session as part of removing Queue configuration.

On 10 October 2026, the current build also passed authenticated local draft/chunk replay,
changed-replay conflict, complete manifest preview with live exact-list validation,
request-driven start, read-only status/pagination, cancellation before dispatch, cancelled
continuation/resume safeguards and API origin denial. The existing login, session generation
and absolute expiry were preserved. All staged items were cancelled and diagnostic metadata
confirmed zero Apple modify requests. No dedicated test list was available during that run.

Later on 10 October 2026, the owner supplied a dedicated test list. A live four-item bulk-create
job confirmed exactly three items in its first continuation and the fourth in its second.
Fresh exact-ID Apple reads verified every item, original ordinal/client-key ordering and
unchanged notes/priority/flag. Job/chunk/completed-continuation replays and matching individual
create reconciliation produced no extra writes. A token-bound simple timed date/time-zone
update passed, while changed-request and stale-token updates were rejected.

A separate cancelled creation was confirmed absent at its stable ID. Bulk-delete preview
explicitly failed its selected synthetic item as unsupported; continuing that job reported
`completed_with_errors` and left the target unchanged. All four created synthetic reminders
were subsequently removed through the existing exact-version single-item soft-delete tool.
Exact read-back verified deletion state or absence; a complete open query found none of those
test IDs. Diagnostic metadata counted exactly nine modify requests: four creations, one simple
update and four cleanup deletions. Status, previews, replay, cancellation and blocked bulk
deletion sent none. The original session generation and absolute expiry were preserved.

This live run verified Apple API state only; Apple's app was not visually inspected. That run
predates permanent simple bulk deletion.

On 11 October 2026 a separate live Test-list run bulk-created four synthetic reminders and attached
one subtask. A four-item bulk-delete preview refused exactly the stale-tag and parent targets
(`CONFLICT`, `UNSUPPORTED_FEATURE`); execution confirmed the two simple deletions, completed as
`completed_with_errors`, and a further continuation sent nothing. Exact readback showed both refused
targets and the subtask unchanged. Cleanup detached and deleted the rest individually. Exactly 11
modify requests were observed (4 creates, 1 subtask, 2 bulk deletes, 4 cleanup), and the session
generation and fixed expiry were preserved. The Apple app was not visually inspected.
The former standalone Queue adapter was covered by synthetic tests and was never deployed
for this acceptance; it has now been removed. Current standalone integration exercises the
authenticated request-driven start/status/continuation, replay and cancellation journey.


On 12 October 2026, the Queue-free implementation passed all 186 unit tests, TypeScript,
lint, public configuration validation, Sites and standalone Cloudflare builds, built-Worker
and local integration, artifact verification and the CI-pinned full-history secret scan.
The standalone Access-authenticated journey verified that preview, start and status do not
write, continuations process three then one item, completed continuation replay is inert,
and cancellation/session expiry fence dispatch. A synthetic database with the historical
outbox table absent also completed the request-driven journey. An independent review found
no actionable issues. All four [runtime CI jobs passed](https://github.com/Xzese/icloud-reminders-mcp-for-cloudflare-workers/actions/runs/38300871428).

Hosted version 47 then passed a live four-item creation and deletion journey through the
normal installed MCP tools and Apple Reminders. The connection reported
`jobExecutionMode=request-driven` and `autonomousJobs=false`. After starting creation,
status showed four pending items with zero attempts and Reminders showed the disposable
List empty. The first continuation succeeded for three items and left the fourth pending;
a subsequent status read and native display confirmed that pause. The second continuation
completed the fourth. A completed continuation replay returned the identical ledger, and
fresh exact-ID reads confirmed all four synthetic records. Reminders displayed all four.

Using fresh exact versions, a separate bulk-delete manifest previewed and started with all
four items pending. Its first continuation soft-deleted three, leaving one visible in
Reminders; its second completed the fourth. Completed replay again returned an identical
ledger. Exact Apple readbacks confirmed all four soft-deleted records, and Reminders showed
the List empty. The normal exact-version empty-List deletion then retired that disposable
List; an exact read and the native sidebar confirmed cleanup. Recently Deleted was not
purged. The existing private audience, runtime environment revision, Apple session generation
and absolute expiry were preserved. This acceptance covers request-driven bulk execution;
it does not extend Shopping classification or other native capability boundaries.
