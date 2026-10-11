# Create, edit, complete and delete reminders

The reminder mutation MCP tools use Apple's modern private CloudKit Reminders database.
Creation, editing, completion, reopening and soft deletion require the authenticated deployment
owner and a ready, unexpired Apple session. They are normal connected-account capabilities;
there is no separate write-approval setting. Owner, origin, session, exact-zone lookup and
record-version checks remain enforced on every request.

The two login approvals must be configured privately before connecting Apple. For the isolated
local Worker, run `npm run dev:icloud` after building. The dashboard reports connection and
mutation availability; it does not expose a general-purpose Apple record editor.

## Supported fields

| Field | Behaviour |
| --- | --- |
| `title` | Nonblank plain text, up to 2,048 UTF-16 code units. |
| `notes` | Plain text, up to 16,000 UTF-16 code units; `""` clears notes. |
| `priority` | `0` (none), `1` (high), `5` (medium), `9` (low). |
| `flagged` | Boolean. |
| `dueDate` | Valid ISO date-time with an explicit offset; `null` clears it. |
| `timeZone` | Valid IANA identifier; `null` clears it. |
| `allDay` | Boolean; `true` requires a due date and time zone. |

Creation defaults to empty notes, no priority or flag, no due date and an open reminder.
Updates affect only the specified fields plus Apple's modification metadata and associated
resolution tokens. Clearing a due date also clears its time zone and all-day marker unless
explicitly supplied; incompatible all-day settings are rejected.
An existing undated reminder can carry Apple's all-day marker; unrelated edits preserve it.

The separate `complete_reminder`, `reopen_reminder` and `delete_reminder` tools accept an exact
`listId`, `reminderId` and current `recordChangeTag`. Completion sets `Completed=1` and a current
completion timestamp. Reopening sets `Completed=0` and clears that timestamp. Deletion sets
`Deleted=1` through a normal version-checked update; it does not hard-delete the CloudKit record.
No restore tool is provided. These tools preserve title, notes, dates and other omitted fields.

State changes refuse recurring, alarmed and nested reminders, and parents whose children are
observed in a bounded complete list inspection (including completed children).
Each action sends exactly one version-checked record update; it never cascades.
An incomplete/errorful or over-budget child inspection blocks the action. This check is **not**
proof of commit-time protection against a newly added, unreferenced child. Bulk deletion uses the
same per-item checks and additionally rescans after commit to report any remaining subtasks. Use Apple's app for completing, reopening or deleting parents and their subtasks.
Moving lists, list management, attachments and tags are outside this interface. The bounded
scheduling recipes below can create or retire a date-alarm pair and edit existing simple
recurrence, early-reminder offsets and location proximity. Arbitrary alarm/rule edits are refused.
Unchanged linked fields remain untouched. Editing title or notes replaces that text document
with plain text, including its formatting; an omitted document remains intact.

## Timed recurring and absolute-alarm date updates

`update_reminder` can change the due date or time zone of an **open timed reminder** with one
absolute date alarm, optionally one location alarm and at most one existing recurrence rule.
A subtask additionally requires an exact-version guard on its open root parent in the same list. This is permanent ready-account
functionality on both deployment targets, not an opt-in flag. `capabilities.linkedScheduling`
reports connection availability; `prepare_reminder_update` reports whether the exact reminder
graph supports this recipe.

The server resolves and validates the current Reminder, Alarm, AlarmTrigger and optional
RecurrenceRule. One atomic group changes the Reminder's date/time-zone and modification
tokens, the Alarm's due-date nonce and the Trigger's base64 JSON Gregorian components.
Existing IDs and references stay unchanged. Any recurrence is protected by an exact-version
`Deleted=0` guard; its complete fields stay unchanged while its version advances.
Every known participant uses its inspected tag. Completed history is neither modified nor
redirected to the active occurrence.

Supply a whole-second ISO instant with an explicit offset and a valid IANA time zone.
The trigger components represent that instant in the selected zone. A **zone-only** edit keeps
the instant and changes the displayed local time; to retain the local clock, supply the matching
new instant as `dueDate` too. The format cannot distinguish repeated fall-back local times, so
those are explicitly refused. Dates must remain in Gregorian years 1-9999.
Start dates, multiple alarms of the same type, unknown trigger/calendar fields, recurrence
creation/end dates/anchors and deeper nesting remain unsupported. The additional recipes below
require explicit inputs and do not infer calendar-date or wall-clock intent.

Controlled native API acceptance moved a weekly reminder from 10 January 2027 at 09:00
Europe/London to 11 July 2027 at 09:00 BST, then restored its original date. Both writes,
full dependency readback and stale-tag refusal passed; linked IDs, recurrence fields,
completed-history version/state and the retained session deadline were preserved.
Additional Apple-app checks are recorded with the expanded recipes below. Actual alarm delivery
was not tested. See
[the recipe evidence](linked-record-protocol.md#permanent-in-place-absolute-date-updates).

## Additional scheduling recipes

Every linked update uses a fresh complete graph, exact versions, one atomic batch and strict
confirmation checks. Existing resolution tokens retain their replica ID and increment their
counter; new fields receive a new token. A counter overflow is refused. Unchanged participants
receive marker-only version guards, and uncertain outcomes are never replayed automatically.

- `changes.dueDate: null` clears a known date schedule and its simple recurrence. The root
  unlinks both; the recurrence is retired with `Deleted=1` and no Reminder backreference.
  The exact date trigger is deleted before its alarm, in the same atomic batch.
- Timed to all-day conversion requires `allDay: true` and the requested calendar date as an
  explicit midnight-UTC `dueDate`; omit `timeZone`. It removes the stored zone and date alarm.
  Reverse conversion requires `allDay: false`, an explicit instant and an IANA `timeZone`,
  and creates a validated date-alarm pair while preserving an existing simple recurrence.
- `changes.recurrence` edits an existing simple rule using `frequency` (`daily`, `weekly`,
  `monthly`, `yearly`) and `interval` (1, or 2 for weekly). End dates, custom rules and creation
  remain refused.
- `changes.earlyReminder` edits one existing offset using positive `count` and `unit`
  (`minutes` or `hours`); `null` removes it. Its account metadata is preserved. Creation is
  refused when that metadata is absent, as are date clearing/conversion with an early reminder.
- `changes.locationAlarm: { proximity: "arriving" | "leaving" }` edits one existing location
  alarm while preserving its place, coordinates, radius and identity. A date move can preserve
  that complete location pair alongside the absolute date pair. Location creation/removal,
  radius edits, and clearing/conversion with a location alarm remain refused.
- Parent dates do not cascade to children. A child's date update guards the exact same-list,
  open root parent; unavailable, foreign, completed or nested parents are refused.

These internal date-alarm deletions do not expose an arbitrary delete tool or permanently
remove the Reminder itself. The ordinary reminder-delete tool continues to use soft deletion.

## Subtask relationships

The separate `create_subtask` and `set_reminder_parent` tools are permanent connected-account
capabilities on both deployment targets and in the local runtime. They require the authenticated
owner and a ready, unexpired Apple session, not a feature flag or additional approval setting.
`connection_status.capabilities.subtasks` reports session availability.

`create_subtask` accepts the normal creation fields plus
`parentReminder: { "reminderId": "<root-id>", "recordChangeTag": "<current-root-tag>" }`.
It creates an **open, undated** child in the same list; due dates, time zones and all-day
creation are refused. Keep the same UUID key and complete request for reconciliation.
Replay checks the child's exact ID, content, state, list and parent and submits no write,
even if its parent tag has since advanced.

`set_reminder_parent` accepts `listId`, `reminderId`, the child's current `recordChangeTag`
and `parentReminder`. Supply a root ID/tag to attach or reparent the reminder, or `null` to
return it to the list's top level. The server resolves the previous parent from the exact
versioned child. Both roots and the child must be open, undated, non-recurring and unalarmed.
Self-parenting, cross-list moves, nested parents, moving reminders with children and deeper
nesting are refused. A bounded complete child inspection includes completed descendants;
errors, incomplete pagination and exhausted budgets block dispatch.

CloudKit's `parent` and `List` remain the owning list, **not** the subtask root.
The child relationship uses `ParentReminder` with an exact `REFERENCE`/`VALIDATE` value,
or an explicit null on detach. Only that field, `LastModifiedDate` and their resolution
tokens change; omitted content and unknown fields stay intact. Creation or movement shares
one atomic group with exact-version, same-value `Deleted=0` guards for affected parents.
These guards intentionally advance parent tags; reread before a different operation.
Any stale known participant rejects the group, without forced writes or automatic retries.
Incomplete/changed confirmations remain `WRITE_OUTCOME_UNKNOWN`.

These tools do not extend simple bulk creation: parent inputs in bulk manifests are rejected.
They do not enable parent/child completion, deletion, schedule edits or descendant cascades.
A list scan and known-record guards do not establish general unreferenced-child race safety,
so bulk deletion reports post-commit subtasks rather than claiming prevention.

## MCP examples

First call `connection_status`, then `get_reminder_lists`. Use the returned exact list ID.
Generate one UUID for each distinct create attempt and retain it until the outcome is resolved.
These IDs and text are invented examples:

```json
{
  "listId": "List/00000000-0000-4000-8000-000000000001",
  "idempotencyKey": "00000000-0000-4000-8000-000000000002",
  "title": "Test reminder",
  "notes": "Created through the MCP tool",
  "priority": 0,
  "flagged": false
}
```

The returned normalized `record` includes its ID and `recordChangeTag`. To edit an existing
open reminder, obtain its current tag through `get_reminders` and call `update_reminder`:

```json
{
  "listId": "List/00000000-0000-4000-8000-000000000001",
  "reminderId": "Reminder/00000000-0000-4000-8000-000000000002",
  "recordChangeTag": "<tag-from-the-latest-read>",
  "changes": { "title": "Updated test reminder" }
}
```

All mutation tools accept an optional `expectedGeneration` to bind a request to a previously read
Apple session. The internal `POST /api/mutations` API requires it, plus the same owner and
same-origin checks used by other state-changing API requests. Unknown fields are rejected.
No raw CloudKit records, signed asset URLs, proof material or write payloads appear in MCP outputs.
Use `get_reminder` with the exact list and reminder IDs to read completed or soft-deleted items
and their current tag without scanning history. It returns `record=null, missing=true` if Apple
reports the exact item absent. `get_reminders(includeCompleted=true)` can also page through history;
use a smaller `limit` such as 20 or 50 when full compound pages exceed the 1 MiB response budget.
The state tools use the same target/version arguments as `update_reminder`, without `changes`.
A completed reminder cannot be completed again; an open reminder cannot be reopened. Both are
conflicts, and a deleted reminder cannot be changed or reused as a create replay.

## Concurrency and recovery

Each request holds the existing owner/session operation lease, looks up the exact current
list and target record in the authenticated private Reminders zone, then rechecks the lease
immediately before submitting one bounded atomic operation. Updates use `update` with the
exact change tag; there is no force-update, record replacement or automatic retry.

- `CONFLICT`: no edit was confirmed. Read the current reminder and review the intended change
  before constructing a new update with its new tag. An existing create ID with different
  content or state is also a conflict.
- `WRITE_OUTCOME_UNKNOWN`: Apple may have saved the change. The result includes the target
  `reminderId` and, for creation, its `idempotencyKey`, with `retryable: false`. Read that list
  and reconcile the known ID before another change. Never generate a new creation key to retry
  this attempt.
- An identical create replay finds the same still-open reminder and returns `replayed: true`
  without another modify request. An altered or completed item is not treated as a replay.

Timeouts, redirects, server errors, malformed confirmations and a lost session fence after
submission are uncertain outcomes. Writes do not follow redirects. Disconnect prevents a
pending preparation from submitting once its lease is lost, but cannot undo an Apple operation
already in flight. A successful mutation invalidates unfinished all-open read continuations.
Neither reads nor writes extend the absolute local session deadline. Single-request mutations
do not cache reminder contents or receipts. The separate bulk-job ledger stores encrypted
authorized manifests, dispatch intent and results; it does not change Apple session envelopes.

### Prepared updates and bulk jobs

`prepare_reminder_update` provides a read-only exact-version preview. Supported single-record
and bounded scheduling updates receive a ten-minute owner/account/generation/request/graph-bound token, accepted as
optional `preparationToken` by `update_reminder`. Changed requests or stale graphs are rejected
before dispatch. Linked-date previews include all modified/guarded versions and complete
atomic record/byte counts. No recurrence anchor or wall-clock reinterpretation
policy is inferred; `policy` accepts only omission or an empty object.
The API preview is `POST /api/reminder-updates/prepare`.
See [linked protocol evidence and scope](linked-record-protocol.md).

The eight `*_reminder_job*` lifecycle tools stage, preview, start, read, cancel, resume and
continue encrypted durable manifests. Simple bulk creation is a normal ready-account capability
once the job schema is installed, without a rollout flag;
simple bulk deletion is permanent with a read-only preview preflight and per-item single-delete checks.
Both deployment targets honestly advertise request-driven execution, not background progress.
Recovered dispatch intent is never automatically replayed; desired state observed without a
receipt stays unknown. See [job contracts, limits and migration](reminder-jobs.md).

### MCP contracts and idempotency

Each tool publishes input parameter descriptions and a typed output schema for successful
`structuredContent`. The server validates successful results against that schema. Matching JSON
text preserves the same information for clients that consume only text, including connection status.
Application failures use `isError: true` and a sanitized error object with the same JSON text fallback;
the success output schema does not describe error results.

All mutation tools declare `readOnlyHint: false`, `idempotentHint: true` and `openWorldHint: true`.
Creation (including subtask creation) declares `destructiveHint: false`; editing, reparenting and state changes declare it true because
they can overwrite or remove existing state. Read tools declare `readOnlyHint: true` and
`destructiveHint: false`; idempotency hints have no meaning for read-only tools.

Idempotency means identical arguments cause no additional reminder change, not that every repeat
returns success. Creation reconciles the stable UUID; existing-item mutations refuse the original
version after it advances. Retain the exact IDs, inputs, version tag and session generation.
A fresh tag is a new request and must not be substituted automatically. After an uncertain result,
use `get_reminder` to reconcile the exact item before deciding what to do next. These hints do not
replace server permission checks or a client's user authorization for changes.

See the MCP [tool contracts](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
and [annotation definitions](https://modelcontextprotocol.io/specification/2025-11-25/schema#toolannotations).

## Local live acceptance

1. Use a uniquely named, unshared iCloud list such as **MCP Test**. The test targets only its
   own labelled synthetic item. Allow the list to appear in iCloud.
2. Run `npm run install:ci` and `npm run build`. Stop any earlier local Worker, then launch
   `npm run dev:icloud`. It uses a separate encrypted local session.
3. Open `http://127.0.0.1:5173/`, finish Apple sign-in/device approval if required, and wait
   for **Ready**, then retrieve the current lists.
4. Explicitly run the one-item test:

   ```bash
   npm run test:icloud-write -- --confirm --list-name 'MCP Test'
   ```

   It prints the synthetic ID and key before writing. It creates one item, checks matching-key
   replay, reads it, edits the title while preserving notes/priority/flag, rejects a stale edit,
   completes it, verifies the completion date and absence from open results, rejects stale deletion,
   reopens it and verifies the cleared completion date, then deletes it, verifies the exact stored deletion marker (or reported absence), and checks
   absence from a complete open query. Only that generated test ID is modified.
   Each phase has a three-minute budget; reads are limited to five pages and requests to 40 seconds.
   No write is automatically retried. Personal contents, account/list IDs, cookies, tags and raw
   Apple responses are not printed. A failed or uncertain step stops before further mutations.
5. Stop the Worker when finished. A successful test removes its item
   from the normal list; if it stops earlier, inspect the retained ID in Apple's app before cleanup.

To finish a **known, previously created and edited** item from this script, use its retained key:

```bash
npm run test:icloud-write -- --confirm --list-name 'MCP Test' --finish-existing --idempotency-key UUID
```

This mode requires a supplied UUID and verifies the exact synthetic title, notes, priority and
flag before completion. It never creates a replacement or chooses a personal reminder. If the
item has already been completed, altered or deleted, it stops; inspect its current state first.

`WRITE_OUTCOME_UNKNOWN` may mean Apple saved the operation. Reconcile the printed exact ID
before another request; do not create a fresh key. To reconcile uncertain creation, the same
key can be supplied without `--finish-existing`, but changed/completed/deleted content returns
`CONFLICT` and stops. If direct list retrieval fails or is incomplete, resolve it before testing writes.

## Protocol reference and acceptance

The payload and text codec follow MIT-licensed pyicloud at revision
`e2e44ab875d47dab4475096021da60030f26c35e`:
[create/update/soft-delete implementation](https://github.com/timlaing/pyicloud/blob/e2e44ab875d47dab4475096021da60030f26c35e/pyicloud/services/reminders/_writes.py),
[text documents and resolution tokens](https://github.com/timlaing/pyicloud/blob/e2e44ab875d47dab4475096021da60030f26c35e/pyicloud/services/reminders/_protocol.py).
The general request contract is described in Apple's
[Modify Records reference](https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/ModifyRecords.html).
Unlike the upstream broad update path, this implementation sends only changed fields and
preserves unmodified resolution tokens. It does not merge CRDT edits with another client's document.

Synthetic unit and built-Worker acceptance checks cover safeguards and uncertain responses.
A controlled live create/edit run passed on 9 October 2026, including duplicate prevention,
content preservation and stale-version refusal. A subsequent live run completed, reopened and
soft-deleted the same synthetic reminder. Exact Apple read-back confirmed completion timestamps,
clearing the timestamp on reopening and the deletion marker; complete open-list queries confirmed
the completed and deleted item was absent. Stale-version deletion was rejected. These checks used
the isolated local Worker and Apple API responses; Apple's app was not visually inspected.
These results do not independently audit the codec or establish every linked-record workflow.

On 10 October 2026, the current build repeated the dedicated-list single-item create/replay,
edit, stale-tag refusal, completion, reopening and soft-delete acceptance successfully through
the retained authenticated local session. A separate four-item bulk-create and prepared
simple date/time-zone update run also passed and cleaned up its exact synthetic IDs.
See [the live bulk acceptance record](reminder-jobs.md). These are Apple API read-back checks,
not visual Apple-app verification or evidence for linked scheduling transitions.

Validate a dedicated test reminder before using write access on personal items. Disconnect Apple
or stop the local Worker when account access is no longer needed. Keep credentials and verification codes
on the dedicated connection page, never in MCP arguments or chat.
