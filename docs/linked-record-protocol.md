# Linked scheduling protocol: supported recipes and evidence

Baseline: `f4da3d8ef41b5bc16415a75abc0043d16e3fcba2`. No subsequent baseline changes
were present when this implementation started. The operator's controlled Apple-app edits
and API observations below preceded the connector's successful in-place date move/restore.
Later expanded recipes below were checked through controlled Mac interaction on synthetic Test reminders.

**The in-place timed absolute-date recipe is permanent ready-account functionality.**
Neither the general CloudKit atomic contract nor pyicloud's generic update implementation
alone establishes Apple's private scheduling semantics.
`tests/fixtures/linked-records.json` contains invented rejection regressions, not before/after
captures and not an acceptance oracle.

| Transition | Evidence / support |
| --- | --- |
| Simple reminder edit | Existing single-record builder, exact version and confirmation checks. |
| Timed recurring active-occurrence date/time-zone change | Supported with one current absolute date alarm, preserving recurrence and linked IDs. |
| Timed absolute date alarm, with optional recurrence | Supported in-place Reminder/Alarm/AlarmTrigger atomic recipe below. |
| Linked date clearing or timed/all-day conversion | Supported for the known date pair with explicit calendar-date/instant inputs; no location or early reminder during conversion. |
| Location alarm | One known pair can be created from a resolved place, edited, preserved during a date move or soft retired. |
| Existing early reminder | One minutes/hours offset can be edited or removed; missing account metadata prevents creation. |
| Existing known recurrence | Daily/weekly/monthly/yearly intervals, weekly weekdays, monthly dates or ordinal weekday, yearly months and explicit end instant. Anchor/creation edits remain blocked. |
| Unknown recurrence or scheduling field | Blocked. |
| Completed historical occurrence | Cannot be rescheduled, reopened implicitly or redirected to a successor. |
| Parent/subtask scheduling | Independent parent dates; child dates guard the exact open root parent in the same list. No cascade or deeper nesting. |
| Bulk deletion of simple reminders | Supported per item with single-delete checks; post-commit subtask report, no prevention claim. |

The internal allowlisted lookup accepts only Reminder, Alarm, AlarmTrigger and RecurrenceRule
in the authenticated private zone. Diagnostic graph inspection loads the root's explicit alarm
and recurrence references, checks identities, types, versions, duplicates, deletion state,
zone and owner, and fingerprints fields/edges/versions deterministically. It uses at most
32 records and 256 KiB. The writable loader follows the observed UUID-valued Alarm `TriggerID`
into an exact AlarmTrigger lookup. Scoped metadata omissions retain the verified private zone,
never foreign authority. A structurally complete graph does not imply a supported recipe.
Unknown linked fields remain untouched. Public tools cannot request arbitrary records.

`prepare_reminder_update` reads an exact target and returns its normalized schedule and feature
classification. Supported single-record and linked-date previews receive a ten-minute token encrypted with
owner/account/generation/target associated data and bound to the canonical request and graph.
`update_reminder` checks a supplied token against a fresh graph; stale requests fail before
dispatch. Ordinary updates without a token retain exact-version checks and the same recipe validation.
Unsupported linked changes return no token. No additional scheduling-policy choices are accepted;
in particular, no wall-clock, anchor or alarm-offset meaning is silently added to old inputs.
Unrelated supported edits of linked reminders still use the ordinary single-record path.

The ordinary atomic mutation interface permits only the evidence-supported Reminder fields.
Unchanged Alarm, AlarmTrigger and RecurrenceRule records can additionally be protected by
version-checked updates that reassert **only** their observed `Deleted=0` marker. This is not
permission for arbitrary scheduling edits, references, parents or tokens. The separate
`modifyLinkedDate` interface accepts only the validated Alarm nonce/Trigger component recipe.
It checks operation count (32), exact serialized request size (64 KiB), one operation per record
and exact update tags before the durable-dispatch callback. Every group uses `atomic: true`.
All confirmations are matched by ID and type independently of response order. Guard confirmations
must preserve the complete inspected field set and advance their tags. Missing, duplicate,
unexpected, success/error mixtures or malformed confirmations remain uncertain. A fully rejected
group with exact one-to-one error identities, at least one known conflict and only known
conflicts/`ATOMIC_ERROR`/`BATCH_REQUEST_FAILED` peer failures is a definite conflict. Peer failures
alone are not enough. Additional linked scheduling mutations require their own field allowlists,
recipes and preservation predicates.

## Required evidence for additional linked transitions

Use separately authorized synthetic reminders in a dedicated unshared list. Ask the operator
to perform Mac interactions unless they separately authorize them. Capture sanitized complete
before/after graphs, explicit IDs and version relationships, references and parent relationships,
changed fields, token/nonce derivation, recurrence anchor, alarm kind and offset, unlink/retirement
behavior, active successor identity, and fresh API / Apple-app agreement after synchronization.
Do not store real credentials or personal reminder contents in fixtures.

Each transition needs its own minimal atomic recipe, protection for **all** semantic dependency
versions (including unchanged linked records), byte/record limits, preservation invariants and
read-back predicates. A final read alone does not close a commit race. Unsupported or oversized
groups must remain rejected, not split into independently committed writes.

Required date evidence includes explicit year, IANA zone, matching offset semantics, DST gaps
and repeated wall times, calendar-date all-day handling without neighboring-day conversion,
date clearing, recurrence interval/end/anchor rules and absolute versus relative alarms.
The invented regression moves 29 August 2026 at 09:00 Europe/London to 10 October 2026.
The separate history case identifies an open successor due 12 November 2026 and an explicitly
requested 10 January **2027**; it does not authorize changing completed history.

References:
[pinned pyicloud writes](https://github.com/timlaing/pyicloud/blob/e2e44ab875d47dab4475096021da60030f26c35e/pyicloud/services/reminders/_writes.py),
[CloudKit modify records](https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/ModifyRecords.html).

## Controlled capture workflow

The local-only `POST /api/reminder-evidence/capture` diagnostic resolves syntactically explicit
scheduling references and rereads every captured record to detect synchronization drift. It
also resolves an Alarm's UUID-valued `TriggerID` as `AlarmTrigger/<UUID>`: a controlled
compound read on 10 October 2026 returned exactly that record for the synthetic test alarm.
This capture is diagnostic identity evidence only, not itself proof of trigger mutation semantics.
It does not infer other opaque UUID relationships, unreferenced children, successor identity or write
semantics. Its output always sets `writableGraphProven=false`. This traversal is separate from
the writable graph loader and does not relax its guards.

Enable it only on the authenticated loopback runtime:

```bash
LOCAL_ICLOUD_STATE_DIR=/absolute/authenticated/checkout/.sites-runtime/local-icloud LOCAL_REMINDER_EVIDENCE_ENABLED=synthetic-v1 npm run dev:icloud
```

The route is absent from MCP and refuses hosted origins even if its diagnostic gate is set.
It requires the exact list and case IDs, current session generation, and a root title
`MCP protocol <case UUID>`. Any referenced Reminder must have that same prefix and belong to
the selected list. Capture sends no modify request. Cookies and Apple credentials remain in
memory; retained snapshots contain only sanitized values, aliases and relationships.
Unknown scalar values, documents, account metadata and asset URLs are redacted. Opaque aliases
preserve shape/equality, not nonce derivation; they cannot themselves approve a write recipe.

Create a separately authorized synthetic seed in the dedicated list using one retained UUID:

```bash
npm run evidence:reminder -- seed --confirm-synthetic --case-id UUID --list-name Test
```

An optional `capture --phase initial` verifies the unconfigured seed without using up the
protocol's `before` snapshot.

In Apple Reminders, configure that item's **baseline** date, recurrence/alarm and time zone,
keeping its title unchanged. Wait for synchronization, then capture:

```bash
npm run evidence:reminder -- capture --confirm-synthetic --case-id UUID --list-name Test --phase before
```

Perform exactly one intended transition in Apple Reminders, wait for synchronization, capture
`--phase after`, and inspect the result in the Apple app. Only after that inspection, run:

```bash
npm run evidence:reminder -- compare --confirm-synthetic --case-id UUID --apple-app-confirmed
```

Artifacts are private ignored files in `.sites-runtime/reminder-evidence/<UUID>/`, created
without overwriting an existing capture. The comparison lists field/version changes, added and
removed/unlinked records, and both edge sets. It still sets `writableRecipeApproved=false`.
Use a distinct case UUID for each transition (recurrence, relative/absolute alarm, combinations,
clearing, all-day conversions, DST and parent/subtask cases). Preserve seeds for evidence capture
and delete only their exact authorized IDs afterward; linked cleanup may require the Apple app.
Do not publish captures as approved fixtures until their semantics and preservation/version
protection predicates have been reviewed. No Apple-app interaction is automated by this script.

On 10 October 2026, live acceptance seeded one explicitly named synthetic reminder in the
owner's dedicated Test list and captured its unconfigured `initial` snapshot. The snapshot
contained one record with redacted documents, identifiers, version and resolution map.
Replaying the retained seed key added no modify request. The existing session generation and
absolute expiry were unchanged. The seed was retained for the operator's subsequent baseline
and transitions described below. The initial unconfigured snapshot is not a linked-write
acceptance fixture.

The operator subsequently configured that case as open, timed and weekly recurring, due
29 August 2026 at 09:00 Europe/London. Fresh API reads confirmed the date, zone and open state
and returned one recurrence rule and one date alarm. The alarm's `TriggerID` matched exactly
one compound `AlarmTrigger` record. The expanded baseline captured Reminder, RecurrenceRule,
Alarm and AlarmTrigger through exact lookups and a second version/field check. The three
previously captured records were unchanged; earlier partial captures were retained privately.
No write was sent and the retained session generation and deadline were preserved.
This baseline alone did not establish an atomic rescheduling recipe or commit-time dependency
protection; the subsequent observed transitions are described below.

After the operator changed only the due date to 10 October 2026 at 09:00 and confirmed the
Apple-app display, the four-record after graph matched that instant and zone. The root changed
`DueDate`, `AlarmIDs`, `LastModifiedDate` and `ResolutionTokenMap`; its title, notes, open state,
all-day flag and recurrence references were unchanged. The recurrence rule's fields **and
version** were unchanged (`Frequency=1`, `Interval=1`, `OccurrenceCount=0`,
`FirstDayOfTheWeek=0` for this operator-confirmed weekly case). Apple replaced the Alarm and
AlarmTrigger identities rather than updating them in place. Absence from the new reachable
graph or compound query does **not** prove the old alarm/trigger were deleted or safely retired.

The new trigger used `Type="Date"` and base64-encoded UTF-8 JSON `DateComponentsData`, with
year 2026, month 10, day 10, hour 9, minute/second 0 and an object-valued time zone.
It was not a binary plist. The new alarm's DOUBLE nonce did not equal the reminder's due-date
resolution token modification time, counter, due-date Unix seconds or due-date Apple-epoch
seconds. At this stage its derivation was unproven; no formula was used for writes.

`tests/fixtures/linked-date-observation.json` records an anonymized **projection** of this
actual observation and the preservation/replacement regression. It is distinguished from the
invented rejection fixture and from complete private captures, which remain ignored. It does
not approve an atomic recipe. The subsequent nonce and atomic-guard observations below narrow
two blockers. At this stage a complete recipe and replacement-record retirement still needed
validation. Neither date examples nor a final read alone establishes commit-time protection.
The later in-place recipe avoids replacing or retiring records.

## Observed recurring completion identity

The operator then completed the synthetic occurrence due 10 October. Complete Test-list
pagination and repeated exact normalized reads found **the original Reminder ID still open**,
now due 17 October 2026 at 09:00 Europe/London, with one recurrence and one alarm. A **different
Reminder ID** held completed history for 10 October, with a completion timestamp, no recurrence
link and one alarm. The active original's four-record diagnostic graph was saved.
This case therefore does not support the assumption that the original ID becomes completed
history and a newly allocated ID necessarily becomes the next active occurrence.

The historical complete-graph capture was refused: `UrgentPresentationAlarmsAsData` differed
between exact lookups despite an unchanged Reminder version. The unknown field was not ignored.
Stable exact normalized identity/schedule/completion summaries were retained separately, with
the limitation recorded, rather than advertised as a stable complete historical graph.
`tests/fixtures/linked-completion-observation.json` projects this observation and preserves the
regression that an explicitly targeted completed record cannot be rescheduled or implicitly
redirected. Matching titles are not a generic successor-selection rule.

To capture a separately read, explicitly chosen synthetic history/active ID, the CLI accepts
`capture --phase completion-history|completion-active --reminder-id Reminder/UUID`.
The normal case-title/list/generation checks still apply; no mutation uses that override.
`next-before` and `next-after` phases preserve further explicit active-occurrence edits without
overwriting the first date-transition captures. Every supported transition still needs its own
recipe and commit-time protection; this observation does not enable recurring completion.

## Observed active rescheduling into January 2027

The operator moved only that known open original from 17 October to **10 January 2027 at
09:00 Europe/London**. Stable four-record `next-before`/`next-after` captures confirmed the
same active root, due `2027-01-10T09:00:00.000Z` (GMT, not the October BST offset), still open
and timed. The root again changed only `DueDate`, `AlarmIDs`, `LastModifiedDate` and
`ResolutionTokenMap`. Title, notes, zone, all-day status and recurrence links were unchanged;
the recurrence rule's fields and version were unchanged. Apple again replaced the alarm and
trigger identities. Old-child retirement is still not established.

Repeated exact normalized reads of the separate completed history matched the earlier
identity, version, title/notes aliases, date, zone, all-day/completion state, completion timestamp
and link counts. It remained completed for 10 October at 09:00 BST. This is normalized
preservation evidence, **not** proof of stable complete historical fields; the previously
observed `UrgentPresentationAlarmsAsData` limitation remains.

The January alarm's nonce exactly matched the candidate relationship
`dueDate.counter * 100000000000 + dueDate.modificationTime`, with counter 5.
The completed history's own alarm independently matched that relationship with counter 1.
The January trigger's decoded JSON contained year 2027, month 1, day 10, hour 9, minute/second 0,
era 1 and `timeZone: { identifier: "Europe/London" }`. These two live equalities narrow the
nonce investigation; they do not validate general nonce construction, counter advancement,
replica handling or complete calendar/DST semantics. No candidate formula is used for writes.

`tests/fixtures/linked-next-occurrence-observation.json` projects the actual active transition
and limited historical/nonce observations. Full captures and the separate normalized and
nonce reports remain private and ignored. The CLI compares this pair without overwriting the
first report:

```bash
npm run evidence:reminder -- compare --confirm-synthetic --case-id UUID --apple-app-confirmed --transition next-occurrence
```

This reads `next-before.json`/`next-after.json` and exclusively creates `next-comparison.json`.
The default or `--transition date` compares the original `before.json`/`after.json`.
Comparisons with explicit root identities reject root changes, even if another Reminder is
shared by both graphs. There is no implicit historical/active redirection.

No further operator date edits were needed for the in-place timed recipe below.
Record replacement/retirement and other trigger/calendar transitions remain separate work.
The observed dependency version-guard primitive is proven below. Guards on known records do
not protect against newly created unreferenced children. Bulk deletion therefore reports, rather
than prevents, such a race (see [reminder jobs](reminder-jobs.md)).

## Observed subtask relationship and permanent connector support

The operator moved the existing synthetic **MCP child-race test** under **MCP parent test**
in Apple Reminders, rather than adding a separate child. Exact repeated readback confirmed
the child retained its list and used
`ParentReminder: { type: "REFERENCE", value: { recordName: "<parent Reminder ID>", action: "VALIDATE" } }`.
The parent's tag and fields changed, but no child-ID/count field appeared on the parent.
Added fields were empty list defaults (`AlarmIDs`, `HashtagIDs`, `RecurrenceRuleIDs`,
`AssignmentIDs`, `AttachmentIDs`). This one observation is **not** proof that every new-child
action changes the root's version, nor a reliable commit-time non-parent predicate.
The old child-race baseline is no longer a childless target; a future coordinated race
experiment must establish a new explicitly authorized baseline.

The compound `reminderList` response repeated identical parent/child raw records. Parsing now
validates every copy's owner/zone and all flattened response limits, then coalesces only
canonical-JSON-equivalent **complete raw** records within that page. Conflicting versions,
unknown fields, deletion state or metadata remain protocol errors. Exact lookups, generic
queries and atomic confirmations retain strict duplicate rejection.

The connector completed a live, authorized Test-list acceptance:
one helper root and one subtask were created with reserved exact UUIDs; matching creation
replay made no write; the child was reparented between roots, detached to top level and
attached again. Child writes and same-value Reminder parent guards were accepted atomically,
with complete parent-field preservation and unchanged omitted child content.
Stale **input** parent/child tags were refused during preflight. Synthetic workerd coverage
also injects a parent-version race after preparation, rejects the complete group and checks
uncertain/missing confirmations without retry. That synthetic injection is **not** a native
Apple-app new-child race experiment.

Observed-parent completion was refused. The connector-created child was detached, then it
and the helper were soft-deleted. Exact normalized reads proved the operator's original
child and active/completed recurring records unchanged; the session generation and absolute
deadline were preserved. The permanent ready-account contract is documented in
[subtask relationships](write-access.md#subtask-relationships).
`tests/fixtures/subtask-observation.json` is an anonymized projection of these observations,
not full raw records or a general parent-safety claim. Private reservations and acceptance
results remain ignored. No rollout flag is required for the proven subtask and simple
bulk-creation behavior. These subtask observations do not establish scheduling or bulk-delete safety.

## Proven atomic protection for the observed unchanged dependencies

On 10 October 2026, the authenticated local runtime ran separate explicitly authorized
marker-only experiments against the synthetic active original's **Alarm, AlarmTrigger and
RecurrenceRule**. For each type, a first two-record atomic update reasserted `Deleted=0` on
the root and selected dependency. Apple accepted it, advanced both tags and preserved all
fields. A fresh exact read supplied the current root and other dependency versions.

A second four-record atomic group used the selected dependency's genuinely older tag and
current tags for the root and remaining two dependencies. Apple returned one `CONFLICT` and
three `ATOMIC_ERROR` peer failures. Complete exact readback showed **all four records' fields
and versions unchanged from immediately before that rejected group**. Each dependency was
tested separately. This proves that a same-value marker update participates in Apple's
version check and atomic rejection, rather than being silently ignored.

The implementation constructs guard fields internally from the observed nondeleted marker,
keeps the Reminder mutation allowlist intact, includes guards in the 32-record/64-KiB budgets,
rejects duplicate operations before dispatch and snapshots the complete request before the
dispatch callback. It requires complete field preservation in every guard confirmation.
Ordinary single-record writes retain their existing behavior. Future scheduling recipes must
include every known semantic dependency: modified records via their own exact update tags,
unchanged records via these guards, with no overlapping operations or split commits.

The diagnostic is local-only `POST /api/reminder-evidence/atomic-protection`, absent from MCP
and hosted access, and requires `confirmVersionGuardWrites=true`. It uses the retained owner,
generation, session deadline and write lease; exact case title/list and bidirectional links
restrict it to the controlled four-record synthetic graph. Cookies and credentials stay in
memory. To run each independently authorized dependency test:

```bash
npm run evidence:reminder -- atomic-check --confirm-synthetic --case-id UUID --list-name Test --confirm-version-guard-writes --dependency-type Alarm
```

Use `AlarmTrigger` or `RecurrenceRule` for the other types. The CLI exclusively reserves
`atomic-marker-<type>-intent.json` before dispatch and writes `atomic-marker-<type>.json` only
after full confirmation. It does not replay a reserved experiment. Same-value writes
intentionally advance tags; they are not read-only and can invalidate earlier preparation.

During discovery, an initial attempt stopped after a confirmed marker group because native
scoped lookups omitted per-record zone metadata. The diagnostic now preserves the already
verified private-zone authority for those omissions without accepting foreign zones. Two
early content-change probes returned unconfirmed outcomes because the strict parser did not
yet recognize Apple's `ATOMIC_ERROR` peers. Read-only complete-graph reconciliation found all
content/scheduling fields unchanged; those unconfirmed submissions were not replayed. Safe
error-code count telemetry established the rejection shape, and the separate marker-only
experiments above then received complete confirmed results.

Post-experiment exact normalized reads preserved the completed October history's version and
state and the open original's January date, zone, title and notes. Session generation 1 and
its original absolute expiry were unchanged. Private reports remain ignored; the anonymized
`linked-atomic-protection-observation.json` fixture projects type outcomes and error counts,
not a complete raw response or approved scheduling recipe.

This closes version-check/atomic-rejection evidence for the three **observed, already known
dependencies**, not child discovery, old-alarm retirement, arbitrary linked mutations,
calendar/DST semantics or deletion races. The dynamic completed-history field remains
unproven and is not ignored. Those experiments alone did not approve scheduling writes.

## Permanent in-place absolute-date updates

The connector subsequently completed a separately reserved live API acceptance against the
open weekly synthetic original: **10 January 2027, 09:00 Europe/London** moved to
**11 July 2027, 09:00 Europe/London** (`08:00Z`), then back to the original date.
Each successful four-record atomic group changed only:

| Record | Planned fields |
| --- | --- |
| Reminder | `DueDate` (and `TimeZone` when changed), `LastModifiedDate`, preserving `ResolutionTokenMap`. |
| Existing Alarm | `DueDateResolutionTokenAsNonce`. |
| Existing AlarmTrigger | `DateComponentsData` as base64 UTF-8 JSON Gregorian components. |
| Existing RecurrenceRule | Exact-version same-value `Deleted=0` guard, preserving all fields. |

Reminder, Alarm, AlarmTrigger and RecurrenceRule identities and backlinks stayed unchanged.
No new records, replacement IDs or guessed old-record retirement were involved. Apple's app
had replaced alarm/trigger IDs during its earlier manual edits; this **in-place** connector
recipe deliberately differs. An attempted retired-alarm backlink query was rejected by Apple
and was removed; no retirement behavior was inferred from that failure.

Complete API readback confirmed both new schedules, date-token/nonce/component agreement,
unchanged recurrence fields and unchanged normalized completed-history version/state.
Original stale input returned `CONFLICT`. The initial date was restored and the retained
session generation and absolute expiry did not change. The public
`linked-inplace-date-observation.json` fixture is an anonymized projection; full synthetic
reservations and readbacks remain ignored. Apple-app rendering, actual alarm delivery and
a later recurring completion were **not** verified by this API acceptance.

For this validated graph, the nonce is
`dueDate.counter * 100000000000 + dueDate.modificationTime`. The original native token had
counter 5; the historical API-only acceptance reset the counter to 1 and was accepted with
matching server readback. Later Apple-app verification exposed that reset as insufficient:
existing tokens must retain their replica ID and advance their counter. The current builder
implements that correction. A zone-only edit keeps the existing due-date token
and nonce and reconstructs components for the same instant in the new zone. Synthetic
coverage exercises that path; the live move/restore changed only the date.

The absolute-date planner requires an open, nondeleted, timed reminder with a due instant
and IANA zone, one bidirectionally linked absolute date alarm/trigger and at most one recurrence.
The expanded planner separately validates an optional location pair and subtask parent.
The current token, nonce and decoded components must agree before any write. Components
must be whole-second Gregorian values with the observed field set, within years 1-9999;
unknown fields or calendar semantics are never dropped. The selected instant is converted
with its explicit offset, not resolved from an ambiguous local-clock input. Repeated local
times are refused because this trigger format has no offset/fold discriminator.

The dedicated linked executor allows only one Alarm nonce field and one Trigger component
field, optional one unchanged recurrence guard, exact versions and existing shared
record/byte bounds. Each complete dependency confirmation must match the original fields
plus its planned update. Workerd coverage injects a dependency race and a committed lost
response: the former refuses the entire group, the latter returns uncertainty without retry.
Structural graph completeness and recipe approval remain distinct. No rollout flag controls
this support; capability reporting reflects session availability, not support for every graph.

The expanded recipes below cover bounded clearing, conversion, existing early reminders,
location alarms, known custom recurrence edits and one-level child scheduling. Start dates,
unknown/multiple alarms of the same type and lifecycle advancement remain refused.
Simple bulk deletion is permanent; it reports post-commit subtasks rather than preventing them.

## Native transition captures and expanded scheduling acceptance

Controlled October 2026 captures used synthetic reminders in the dedicated Test list.
Native changes established calendar-date conversion, removal of the date alarm/trigger,
simple recurrence frequencies and fortnightly interval, early-reminder offset payloads, and
location arriving/leaving records after selecting a suggested public station.

The native resolution map preserves each existing field's replica ID and increments its
counter (observed 2→3→4→5). Resetting an existing counter to 1 can produce a successful server
write that the Apple app does not apply. Updates now advance those counters, preserve unrelated
tokens and derive the absolute alarm nonce from the resulting due-date token.

Retirement probes established that a stale delete version rejects the full atomic batch,
and that the trigger must be deleted before its alarm. A reversed order produces an atomic
validating-reference rejection. Successful retirement returns exact identity-only tombstones;
subsequent lookups return `NOT_FOUND`. Recurrence retirement retains the native soft marker
and removes its Reminder backreference. The public transport permits this bounded alarm-pair
retirement only, never hard deletion of a Reminder or arbitrary caller-selected records.

The expanded recipes and explicit input examples are documented in
[write access](write-access.md#additional-scheduling-recipes). Private captures remain ignored;
checked-in fixtures use invented identities and account metadata. Actual notification delivery,
recurrence creation/anchors and early-reminder creation
without independently established account metadata remain outside the verified scope.

Final controlled connector checks confirmed and visually inspected recurring-date clearing,
timed→all-day conversion, a subsequent all-day date move, reverse timed conversion, existing
fortnightly/yearly rule edits, a combined date/location/one-hour-early update, early removal,
and independent parent/child dates. Clearing also read back both retired date records as
`NOT_FOUND` and the recurrence as `Deleted=1` without its Reminder backreference. The station
selection preserved its 412-metre radius during connector edits. Session generation and the
absolute retained-session deadline were unchanged throughout. A reverse-conversion response
with omitted record zone triggered uncertainty and was reconciled read-only; confirmation
validation now uses the authenticated owner for its expanded references rather than relying
on optional record-level zone metadata. No uncertain mutation was replayed.

## Custom recurrence and location expansion

Further native captures established weekly weekday arrays, monthly day-of-month arrays,
one monthly ordinal weekday, yearly month arrays and an optional `EndDate` timestamp.
Weekday entries use Apple's Sunday=1 numbering and `weekNumber=0` for weekly patterns;
monthly ordinals use 1 through 5 or -1 for last. The public API translates ISO weekdays.
Pattern arrays are bounded base64 UTF-8 JSON, not recurrence strings. Unknown calendar,
count, import or pattern combinations fail closed. The interval ceiling of 999 is an API
inspection bound, not a measured Apple UI maximum.

Connector writes were confirmed and visibly checked in Apple Reminders for every four weeks
on Tuesday/Friday with a 1 September 2027 end date, every two months on the 17th/31st with
the end removed, every two months on the last Tuesday, and every two years in January/July.
Changing pattern removed incompatible fields and preserved the existing five-minute early
reminder. End inputs are explicit instants: no midnight or inclusive calendar-day behavior
is inferred from the native date picker. Omission preserves an existing end instant even
when frequency changes; callers must pass `null` to remove it.

Native location removal unlinked the root and set both dependent records to `Deleted=1`;
only the Alarm's Reminder backreference disappeared. The Trigger retained its Alarm
reference and place metadata. Recreating a location through the selected station suggestion
minted fresh Alarm, Trigger and Location identifiers. This soft-retirement recipe is distinct
from the date pair's trigger-first hard retirement.

Creation and place edits carry `isEncrypted=true` on the captured ReferenceFrameString,
Title, Address, Latitude and Longitude fields. Native captures and
[Apple's encrypted-field documentation](https://developer.apple.com/documentation/cloudkit/encrypting-user-data)
establish this typed payload flag. An unflagged creation returned a mixed atomic rejection;
read-only reconciliation confirmed the root tag and date pair were unchanged. A fresh request
with the corrected flags created a leaving station alarm, visibly checked at a 400-metre radius.
No uncertain request was replayed.

A subsequent connector edit changed the resolved station place, proximity to arriving and
radius to 600 metres; Apple Reminders displayed all three changes while the date stayed intact.
The new pair's identifiers were preserved during editing. Connector removal also kept the
absolute date pair and visibly disabled Location.

Early payloads captured on two synthetic roots shared an account identifier, but no
authenticated account field has been established as its source. Creation without an existing
payload remains refused; native account identifiers are never guessed from zone owners or DSIDs.
