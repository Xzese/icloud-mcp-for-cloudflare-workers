# Durable reminder jobs

Jobs are **request-driven by default on both Cloudflare Workers and ChatGPT Sites**.
Starting a job saves its reviewed manifest and outbox eligibility in D1. Sites uses authenticated
continuations; standalone Workers can opt into the Queue adapter described below. Status GETs
never dispatch, renew Apple credentials, schedule a timer or execute through `waitUntil`.
`executionMode` and `connection_status` describe the actual configured mode. Sites cannot
enable Queue mode: its entrypoint does not expose a consumer.

**Initial support:** current simple-reminder bulk creation is a permanent connected-account
capability once the additive job schema is installed. No feature flag or extra approval
setting is required; the authenticated owner still reviews and authorizes each exact manifest.
Simple bulk deletion is also permanent. Preview performs a read-only preflight of every target:
missing or already-deleted, stale-tag, duplicate, recurring, alarmed, nested and parent reminders
(one complete subtask scan per list) fail before sealing and are never dispatched. Execution sends
each remaining item through the single-item delete path, which repeats the exact lookup and subtask
scan immediately before one exact-version soft-delete. It never cascades.

Apple offers no observed commit-time predicate for "has no children", so a subtask attached in
Apple Reminders between the final scan and the commit cannot be blocked. A read-only rescan after
each confirmed deletion reports it as `SUBTASKS_REMAIN` (or `SUBTASK_CHECK_INCOMPLETE` when the
rescan fails) on the succeeded item. A lost acknowledgement stays `unknown`; read-only
reconciliation reports whether the target is deleted, never replays and never claims who deleted it.
Linked creation remains unsupported separately.

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
current creation fields plus its own retained UUID, or exact deletion list/ID/version.
Defaults and creation UUID/date representations are canonicalized before hashing.
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
`desiredStateObserved` flags. Counts come from durable states, not incremented queue totals.
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

`migrations/0001_reminder_jobs.sql` is additive. Fresh installs use the matching `schema.sql`.
The tables are jobs, items, chunk receipts, account-scoped replay reservations, account
leases/cooldowns and outbox eligibility. Owner-scoped reads always use the authenticated
deployment owner before database access. Item content, target IDs, generated mutations and
detailed results use the existing AES-GCM primitives with a separate job/item/field AAD context.
The Apple session envelope schema and rows are unchanged.

Apply the additive migration to an existing standalone database, using private operator config:

```bash
npx wrangler d1 execute icloud-reminders --remote --config wrangler.production.toml --file migrations/0001_reminder_jobs.sql
```

For Sites, preserve the exact ignored Site binding, use the native source workflow, regenerate
with `npm run sites:prepare`, and verify application of the additive packaged schema to its
existing D1 before using bulk creation. Never reset D1, overwrite an Apple session,
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
LOCAL_ICLOUD_STATE_DIR=/absolute/checkout/.sites-runtime/local-icloud npm run dev:icloud
```

The explicit directory must already contain `keys.json`. Stop any other server using the
same state before launching; build the current checkout first and retain the original
session generation and fixed expiry. Only separately authorized synthetic test-list
reminders may be mutated.

To stop new dispatches, cancel undispatched authorized jobs and stop continuation automation
or Queue delivery. Preserve all tables, receipts, encryption keys and Apple session state, and keep
a compatible status/reconciliation reader. Do not drop/reset storage or disconnect as rollback.
Slice logs contain only event name, processed count and state, not reminder text, raw Apple
responses, credentials, cookies or full IDs.

Synthetic SQLite and built-Worker checks cover duplicate/chunk handling, bounded execution,
encrypted storage, cancellation, version/session fencing and lost acknowledgements. Linked
scheduling evidence and autonomous adapters remain release requirements; the Queue adapter requires operator binding verification before deployment, while
linked writes remain blocked as described in [the protocol evidence gate](linked-record-protocol.md).

## Optional standalone Queue execution

The standalone entrypoint exports a Queue consumer and a dedicated outbox recovery handler.
The runner, ledger, encryption and account/session fences are identical to continuation mode.
Messages contain only a job UUID and revision hint, never owner authority, target IDs or text.
Duplicate/stale messages reload the ledger; confirmed writes cannot be resubmitted.
Only runnable states execute. Authentication pauses and unknown outcomes require explicit review.
Cancellation, expiry, account cooldown and live leases are honored.

After a slice, progress and the next outbox request are persisted before sending the next message
and acknowledging the current delivery. Send failures, exhausted delivery retries or a lost
acknowledgement leave D1 recovery authority intact. A one-minute scheduled pump sends at most five
due owner-scoped requests, with a two-minute recovery spacing after successful delivery.
This schedule processes only job outbox rows; it does not revive retired catalogue work or renew
sessions. Queue mode is an operational delivery setting, not user authorization.

Provision a Queue in the existing Cloudflare account and verify its producer/consumer bindings
and the deployed standalone entrypoint before enabling `REMINDER_JOB_EXECUTION_MODE=queue-v1`.
Keep identifiers in **ignored `wrangler.production.toml`**, not the checked-in template. Within
its existing `[vars]`, set the mode and exact `REMINDER_JOB_QUEUE_NAME`. Then add:

```toml
[[queues.producers]]
binding = "REMINDER_JOB_QUEUE"
queue = "your-private-reminder-job-queue"

[[queues.consumers]]
queue = "your-private-reminder-job-queue"
max_batch_size = 1
max_batch_timeout = 1
max_concurrency = 1
max_retries = 5

[triggers]
crons = ["* * * * *"]
```

The Queue name must exactly match the variable. Configuration generation rejects missing,
mismatched or unbounded bindings and unrelated schedules. No Queue is provisioned or deployed
automatically. No bulk-creation feature flag is required. Rollback clears the
delivery mode and removes only these job bindings/schedule; retain D1 and use authenticated
continuation/status/reconciliation. The outbox survives a switch back to request-driven mode.

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
generation and fixed expiry were preserved. The Apple app was not visually inspected. The standalone Queue adapter is
covered by synthetic D1 and exact built-workerd producer/consumer tests, not a live deployment.
