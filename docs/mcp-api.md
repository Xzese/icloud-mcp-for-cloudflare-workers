# MCP and API reference

This reference explains every registered MCP tool: what to supply, what it returns,
what changes, and why. The input/output schemas advertised by `tools/list` are the
machine-readable contract. This document describes the current source; an older deployment
or a client with cached tool metadata can advertise an older contract.

The connector follows **observed Apple Reminders behaviour for its supported recipes**.
For example, completing a recurring occurrence normally advances the active reminder and
creates completed history; it does not mark the next occurrence completed. The connector
also adds exact-version checks, bounded inspection and recovery tracking. Those safeguards
are connector choices, not claims about Apple's UI implementation. This is an unofficial
integration, and a supported recurrence edit does not imply support for completing every
recurrence pattern.

Drive tool contracts and file transfer endpoints are documented in [iCloud Drive and service permissions](icloud-drive.md). Disabled service groups are omitted from `tools/list`; server-side checks also enforce preferences for direct calls. `connection_status` includes `services`, `serviceSettings` and `accountConnected`, without contacting Apple.

## Contents

- [Shared inputs, results and recovery](#shared-inputs-results-and-recovery)
- [Connection and reading](#connection-and-reading)
- [Lists and appearance](#lists-and-appearance)
- [Shopping categories](#shopping-categories)
- [Creating, editing and organizing reminders](#creating-editing-and-organizing-reminders)
- [Completion, reopening and deletion](#completion-reopening-and-deletion)
- [Recurring reminders: why completion can leave a reminder open](#recurring-reminders-why-completion-can-leave-a-reminder-open)
- [Durable bulk jobs](#durable-bulk-jobs)
- [HTTP API and authentication](#http-api-and-authentication)
- [Evidence, boundaries and maintaining this reference](#evidence-boundaries-and-maintaining-this-reference)

## Shared inputs, results and recovery

All tools require the authenticated deployment owner. Tools never accept an input owner,
Apple password, cookie or raw CloudKit write. Apple-facing operations need a ready session
and authorize the exact owned private list live; a remembered list ID is not proof of access.
Shared-list discovery and shared-list writes are outside the current supported scope.

Use `connection_status.generation` as `expectedGeneration` to bind an operation to the
Apple session you inspected. Most single-item tools allow omission and use the current
generation. `prepare_reminder_update`, `update_reminder_list_appearance`,
`set_reminder_category` and `create_reminder_job` require it. Jobs retain their original generation, and subsequent job
calls use `jobId`. A replacement session is not silently adopted for recovery.

Existing-reminder writes use `listId`, `reminderId` and the current `recordChangeTag`.
Existing-list writes use `listId` and the List's own tag. These are opaque version tokens,
not dates. Copying a reminder's tag into a List argument is invalid. Every successful write
can advance versions; read the returned state or fetch the affected exact records before a
new action. Atomic guards can advance an otherwise unchanged participant's version while
preserving its content. Do not infer a visible edit from a changed tag alone.

Successful MCP calls return `structuredContent` plus equivalent JSON text. Reminder results
include normalized title/notes, completion and deletion state, date/time-zone fields,
relationship IDs and version tags. Related IDs do not constitute hydrated alarms, tags or
URLs; use the relevant read/preview tool. Raw records, credentials and signed asset download
links are excluded. Mutation results normally contain `operation`, `generation`, `record`,
`replayed` and `writesEnabled`; lifecycle calls can also return `affectedRecords`, and
recurring completion can return `completedOccurrence`.

Application errors set `isError: true` and include `error.code`, `message`, `retryable` and
`requestId`, with recovery details when appropriate. Input-schema failures can instead be
MCP validation errors. A hosted adapter may label the outer error `INVALID_ARGUMENT`;
inspect the nested connector error when present.

Failures while decoding a List's `ReminderIDs` include `error.membershipDiagnostics`:
`fieldType` (`STRING` or `OTHER`), `stringLength` (characters, or null), `jsonShape`
(`not_inspected`, `invalid`, `array`, `object` or `scalar`) and `arrayLength` (or null).
These expose only shape and size, never membership values or parser excerpts. Malformed
fields, JSON, shapes or identities return `PROTOCOL_CHANGED`; exceeding the 131,072-character
or 2,000-entry inspection limit returns `UNSUPPORTED_FEATURE`. Oversized strings are not
parsed, so their JSON shape and array length remain unknown. Both failures are nonretryable
and prevent lifecycle dispatch. A successful list summary deliberately returns
`reminderIds: null` without inspecting membership; its separate `count` is not an inventory.

Native inventories above 1,000 entries use bounded 200-item pages and exact lookup batches,
at most 10 query pages and 2,000 distinct reminder identities. These inventory reads project
`List`, `ParentReminder` and `Deleted`; document content and scheduling graphs do not
establish parent relationships. Selected lifecycle participants are subsequently resolved
with full fields and exact versions before planning.
The relationship projection queries `Reminder` by its List reference directly, including
completed records, rather than the compound `reminderList` scheduling view. Relationship
normalization validates only those native links and deletion state; unrelated audit dates
and document formats cannot stand in for a parent-link check. Owned deleted stubs are ignored.
Query and exact-lookup phases each cap aggregate data at 8 MiB;
large exact lookups run in groups of at most four, draining every read before a failure;
the existing session lease, request deadline and 1 MiB per-response limit remain in force.
Atomic writes can carry up to 256 KiB when native List ordering requires it; removing only
those bounded ordering values must leave at most the original 64 KiB of other request data.
This capacity does not enlarge reminder-content limits or permit splitting a recurring write.

| Result or error | Meaning and next action |
| --- | --- |
| `replayed: true` | The retained request was reconciled without another Apple write. It does not mean a fresh operation ran. |
| `CONFLICT` | The version, state, request or retained identity no longer matches. Read and review before making a new request. Never automatically substitute a fresh tag. |
| `WRITE_OUTCOME_UNKNOWN` | Apple may have committed. Retain the original IDs, tag, generation, inputs and creation key/scope; read every indicated participant before another mutation. Never replace a create/copy key. |
| `UNSUPPORTED_FEATURE` | The graph or recipe cannot currently be changed faithfully within the bounds. No speculative force-write is offered. |
| `PROTOCOL_CHANGED` | Apple's response could not be interpreted safely. Do not treat it as an empty collection or a successful mutation. |
| Authentication or rate-limit error | Follow the required connection action or cooldown. Reads and writes do not extend the fixed session deadline. |

Mutation idempotency means identical arguments cannot apply the change twice; it does not
promise that every replay succeeds. Ordinary writes can return `CONFLICT` after the original
tag becomes stale. Supported creation, copy and recurring-intent reconciliation retain
identities to resolve uncertain acknowledgements read-only. No tool automatically refreshes
tags or replays an ambiguous write.

## Connection and reading

### `connection_status`

**Input:** `{}`. **Result:** connection state, generation, fixed expiry, required action,
transport state, capabilities and tool availability, including job execution mode.

This reads local connection/storage state without fetching reminders or validating the
session against Apple. It explains which next step is available without causing a network
read or a mutation. `READY` is local readiness, not a guarantee that a later Apple request
will succeed; capability flags report current availability rather than universal support
for every native graph.

### `get_reminder_lists`

**Input:** optional `expectedGeneration`. **Result:** current selectable private lists,
IDs, available titles/counts and discovery completeness.

It queries the current private-zone List catalogue directly rather than reconstructing it
from history. Only a complete bounded discovery replaces the encrypted list snapshot; an
incomplete/unsupported discovery reports an error and preserves the prior snapshot. Counts
may be absent and cannot prove a list empty. This avoids presenting a partial catalogue as
all of the owner's lists. Shared-database discovery is not included.

### `get_reminders`

**Input:** `listId`, optional `includeCompleted` (default `false`), `limit` (1–200,
default 200), `continuation` and `expectedGeneration`. **Result:** one live page, normalized
records, record errors and pagination state.

Open-only is the usual actionable view; `includeCompleted: true` includes history. The list
is authorized live on each call and reminder contents are never cached. Continue with the
same list/options and returned opaque value. Here `complete` concerns unresolved page
errors; **`paginationComplete` identifies the end of that list**. A single page is not an
entire list. Dense compound history can exceed the 1 MiB Apple-response budget: start a
smaller read, such as 20 or 50, rather than treating the failed read as complete.

### `get_all_open_reminders`

**Input:** optional `expectedGeneration` and returned UUID `continuation`. **Result:** open
records across the selected lists, list/progress information, errors and completeness.

It discovers selectable private lists once, then resumes that fixed selection without
rediscovering it. Bounded partial work returns a single-use, owner/session-bound continuation
valid for up to ten minutes and no later than session expiry. Combine successful pages and
use each newly returned token. `complete: true` requires every selected list to finish
without errors. Fixing list selection makes continuation predictable; it does not freeze
reminder contents into a snapshot. A successful mutation invalidates unfinished all-open
continuations.

### `get_reminder`

**Input:** `listId`, `reminderId`, optional `expectedGeneration`; no tag required.
**Result:** current exact `record`, or `record: null, missing: true` when Apple reports it
absent.

This includes completed and soft-deleted records without searching history. A directly
deleted, detached record can have `listId: null`; the caller's old list is not fabricated
back into the result. Soft-deleted and missing are different states. This exact read provides
fresh tags and resolves uncertain outcomes even when the item has disappeared from the
ordinary app list. The requested list must still be available and authorized.

### `inspect_reminder`

**Input:** exact `listId`, `reminderId`, optional MCP `expectedGeneration` and
`recurrenceCalendarTimeZone`. **Result:** current normalized `record`, readable `schedule`,
`organization`, `category`, `subtasks`, and `actions` for complete/reopen/delete/move/copy/update.

This is a bounded, read-only inspection of a nondeleted reminder. Schedule and organization
sections distinguish `known` from `unknown`; null or empty values in an unknown section do
not establish absence. Shopping membership resolves only the selected category, without
enumerating the entire category catalogue. Subtask details identify the selected reminder's
children and its one-level family. Raw Apple records, signed asset links and private early-alert
metadata are excluded. Use `get_reminder` for soft-deleted or missing-item reconciliation.

Each action reports `supported`, `unsupported` or `requires_input`, with a reason, affected
existing reminder IDs and missing inputs. Lifecycle checks reuse native planners; recurring
completion can also create a fresh history identity at execution. Moves/copies still need a
destination and exact List versions. Updates direct callers to `prepare_reminder_update` with
the proposed changes. An ended all-day recurrence can require an explicit calendar zone;
recurring deletion requires an explicit deletion scope. Inspection creates no mutation intent
or write authorization and reserves no versions. Actual mutations repeat their checks.

### `search_reminders`

**Input:** optional `listId`, `text`, `status` (`open` by default, `completed` or `all`),
`flagged`, `priority` (0/1/5/9), inclusive `dueFrom`/`dueTo` explicit-offset instants,
`tags`, `tagMatch`, `hasTags`, `hasUrl`, `urlText`, `limit` (1–200, default 200),
`continuation` and `expectedGeneration`. **Result:** matching normalized records and
scan progress/completeness.

All supplied filters combine with AND. `text` is a case-insensitive title/notes substring.
Due bounds exclude undated reminders. `tags` contains 1–16 unique, exact, case-sensitive
literal names; `tagMatch` is `all` by default or `any`, and requires `tags`. `hasTags`
tests native tag relationships. `hasUrl` and case-insensitive `urlText` test the **separate
native URL**, not a link in notes or an image. Contradictory filters are rejected.

One call reads at most one Apple page, so **zero matches with a continuation is not zero
matches overall**. Repeat identical filters and page size with the newly returned single-use
token until `complete` is true. Without `listId`, the initial discovered private-list
selection is retained. Tokens expire within ten minutes/session expiry; pages remain live,
not a snapshot. Unknown or incomplete tag/attachment classification raises an error instead
of silently asserting absence. Related metadata lookup is bounded, and assets are not
downloaded. These rules prevent false search negatives. Search is a connector scan, not a
synced native Smart List. See [search budgets and acceptance](native-reminders-parity.md#implemented-search-and-organization-contracts).

## Lists and appearance

### `get_reminder_list`

**Input:** `listId`, optional `expectedGeneration`. **Result:** exact List name, available
count, deletion state and `recordChangeTag`.

This reads an owned private non-group list, including its soft-deleted state for
reconciliation. Use its version for rename, delete or transfers. The catalogue's count is
not a replacement for exact membership inspection, and this read does not modify the list.

### `create_reminder_list`

**Input:** nonblank `name` (up to 256 characters), UUID `idempotencyKey`, optional
`expectedGeneration`. **Result:** created List and retained key, or matching read-only replay.

It creates a standard owned private list using the native List representation. The UUID
determines its identity so a lost acknowledgement cannot justify a second list. Reuse the
same key/name after uncertainty and inspect the exact returned/determined ID. It does not
create a shared, shopping, grouped or Smart List.

### `rename_reminder_list`

**Input:** `listId`, current List `recordChangeTag`, new `name`, optional
`expectedGeneration`. **Result:** renamed List with its new tag.

It changes the native name and corresponding resolution token, preserving unrelated fields
and membership. This matches renaming a standard list in Reminders. A stale version or
already-matching name conflicts; shared/group lists are refused. The guard prevents
overwriting a name change made in the native app since the read.

### `delete_reminder_list`

**Input:** `listId`, current List tag, exact current `confirmName`, optional
`expectedGeneration`. **Result:** soft-deleted List.

The connector requires explicit empty membership and a complete live inspection including
completed reminders, then uses the native deletion/unlink markers. Unlike native deletion
of a populated list, this tool **does not delete its contents**. The narrower rule and exact
name confirmation prevent an empty-looking open view from authorizing removal of hidden
history. Concurrent connector creation guards the List; a full normal MCP/real-Apple
race rejected deletion after an independent guarded creation, preserving the item and List.
Universal protection against every
unreferenced native membership event remains unproven. No restore or permanent purge is
exposed. See [list deletion evidence and limits](list-management.md).

### `get_reminder_list_appearance`

**Input:** `listId`, optional `expectedGeneration`. **Result:** List tag and classified
`color`/`badge` state: recognized preset/default/custom or unsupported colour, and emoji or
unsupported badge.

It interprets native appearance without exposing opaque field data or inventing a writable
value for an unknown badge. This separates what can be observed from what the connector
can safely change. Only owned standard private lists are supported.

### `update_reminder_list_appearance`

**Input:** `listId`, current appearance `recordChangeTag`, required `expectedGeneration`,
`colorPreset`, `emoji`, or both. **Result:** updated classified appearance and tag.

Presets are `red`, `orange`, `yellow`, `green`, `light-blue`, `blue`, `indigo`, `pink`,
`purple`, `brown`, `grey` and `rose`. `emoji` must be one valid emoji grapheme. Native
palette/emoji fields and their tokens change together; other List fields are preserved.
The values come from native captures, with app round trips verifying appearance. Custom RGB,
clearing colour/badge, standard symbol badges, pinning, groups and sections have no write
contract here. After uncertainty, read appearance rather than retrying the original write.
See [appearance evidence](native-reminders-parity.md#native-list-appearance-acceptance).

## Standard-list sections

### `get_reminder_list_sections`

**Input:** exact `listId`, optional `expectedGeneration`, `limit` (1–200, default 200)
and returned UUID `continuation`. **Result:** section IDs/names/version tags, memberships,
`orderedSectionIds`, `orderingStatus`, current `listRecordChangeTag`, and pagination state.
Only owned private Standard lists are supported; Shopping lists use `get_shopping_categories`.
Shared lists, groups and Smart Lists are refused.

Reads use the type-filtered `ListSection` metadata change feed, current exact lookups and
the selected List's checksum-verified membership and ordering assets. Empty materialised
sections can be found even without memberships. Each call reads one feed page; an empty
page can still return a continuation. Merge sections by `sectionId`. `complete` becomes
true only at the end of the metadata feed. It does not imply a cached snapshot.

Keep list, generation and page limit fixed, use each new single-use continuation within
ten minutes, and restart after expiry, repeated native pagination or a List-version change.
Each page rechecks the List version before returning. At most 200 sections/memberships are
supported. `orderingStatus: "explicit"` reports the persisted ordering asset;
`"not_materialized"` returns an empty `orderedSectionIds` without guessing native default
order. No raw records, asset URLs or reminder bodies are persisted or returned.

This read tool provides no section creation, rename, deletion, move or reorder operation.
See [native read evidence](native-reminders-parity.md#standard-section-read-evidence).

## Shopping categories

### `get_shopping_categories`

**Input:** exact `listId`, optional `expectedGeneration`, `limit` (1–200, default 200)
and returned UUID `continuation`. **Result:** materialised categories and their current
IDs/names/version tags, current item membership, any explicit category ordering, locale,
the List's current `listRecordChangeTag`, and pagination state.

Apple stores categories separately from reminders. Its generic `ListSection` query is
not indexed, so this tool uses the private change feed restricted to **category records
and metadata fields only**. This can inspect category metadata across the owner's private
lists; only the selected list's categories are returned. It includes empty materialised
categories, which cannot be discovered from current item memberships alone. Built-in
suggestions that have never been materialised are not category records. The app may localise
stored names differently: for example, stored `Produce` appears as `Fruit & Veg` in the
observed UK interface. Use IDs, not a guessed translated name, for a move.

Each call reads one bounded catalogue page and rechecks current exact categories. Combine
results by `categoryId`; live pages may repeat categories or reflect intervening edits.
`complete` and `paginationComplete` become true only at the end of the catalogue. Even a page
with no matching categories can carry a continuation. Keep the list, generation and limit
fixed, use each newly returned single-use token within ten minutes, and restart after expiry.
Only encrypted cursor/scope metadata is retained; reminder contents, category names and asset
links are not cached. This category feed does not replace direct current-list discovery.

### `set_reminder_category`

**Input:** required `expectedGeneration`, `listId`, `reminderId`, current reminder
`recordChangeTag`, current `listRecordChangeTag`, destination `categoryId` and its
`categoryRecordChangeTag`. **Result:** the reminder, destination category and new versions.

This moves one ordinary open, undated, childless root item to an **existing category in the
same owned Shopping list**. It updates the native membership asset, moves the item to the end
of the category's ordering and updates Apple's grocery-learning correction for the title.
That last step matches the native manual move: future items with the same product title
learn the chosen category. It is not a connector classifier. Other memberships, learned
choices and reminder content are preserved.

The current write recipe supports visible ASCII titles up to 256 characters, bounded native
membership/learning assets, and a null learning-reset date. Scheduled, recurring, assigned
or nested items, non-ASCII learning keys, category creation/renaming/deletion, list conversion,
virtual suggestions and clearing to `None` are outside this write recipe. The destination
must be returned by a fresh category read; a category in another list is rejected.

The exact reminder, List and destination category are protected in one versioned atomic
request. Asset staging alone does not move an item. Checksums retain their native encrypted
wrappers, and confirmation checks asset identity/content, ownership and preserved fields.
Stale versions return `CONFLICT` without automatic refresh or dispatch. After uncertainty,
read the reminder and categories before constructing another request; the original move is
never blindly repeated. See [Shopping protocol and acceptance](native-reminders-parity.md#shopping-category-protocol-and-acceptance).

## Creating, editing and organizing reminders

### `create_reminder`

**Input:** `listId`, one UUID `idempotencyKey`, nonblank `title` (up to 2,048 UTF-16 code
units), optional `notes` (up to 16,000), `priority` (default 0), `flagged` (default false),
`dueDate`, `timeZone`, `allDay` (default false) and `expectedGeneration`.
**Result:** new open `record`, key and replay status.

It creates one ordinary native reminder; the key determines the Reminder ID. Dates require
an explicit ISO 8601 offset; an all-day create requires a date and time zone. It creates no
recurrence, alarm, attachment or child relationship. Use later dedicated operations for
those features. Creation atomically appends the new stable identity to native List ordering
and advances its ordering token under the exact List version. That List update precedes
creation, including in a pristine list, and conflicts with connector list deletion. Identical matching creation
reconciles without another write; altered/completed/deleted existing state is not adopted
as an identical create. Equal titles with different authorized keys remain distinct items.

Creation in an existing owned Shopping list does not automatically assign a category. In
the live comparison, MCP-created `Milk` remained in Others while the same title created
inside Reminders was assigned to Dairy, Eggs & Cheese. The tool does not invoke Apple's
grocery classifier or write category membership. Creation now establishes the explicit List
ordering required for later manual assignment. An eligible item can be assigned to an existing category with
`set_reminder_category`. Automatic categorisation on creation remains unimplemented. See
the [Apple classifier investigation](native-reminders-parity.md#apple-classifier-investigation).

### `create_subtask`

**Input:** creation fields plus `parentReminder: { reminderId, recordChangeTag }` and
optional `expectedGeneration`. **Result:** new child record, stable key and replay status.

The child and exact open root must be in the same list, undated, unalarmed and non-recurring.
It creates the native parent relationship while guarding the parent and List atomically.
This matches a one-level subtask, rather than merely placing an indented title in notes.
Deeper nesting and parent nodes with unsupported schedules are refused. Retain the original
key/inputs after uncertainty; a matching replay does not dispatch again when parent guard
versions have advanced. Bulk-create jobs do not accept parent inputs.

### `set_reminder_parent`

**Input:** exact child target/tag, `parentReminder: { reminderId, recordChangeTag }` or
`null`, optional `expectedGeneration`. **Result:** updated child with its parent ID.

It attaches, reparents or returns a simple reminder to the list's top level. The previous
parent is read from the versioned child; affected old/new parents are guarded together.
Complete bounded descendant inspection prevents moving a known parent beneath another
node. It refuses self-parenting, cross-list moves, deeper nesting and completed, dated,
recurring or alarmed nodes. This follows native parent relationships and keeps unrelated
content intact; it is not a cascading lifecycle or cross-list transfer operation.

### `prepare_reminder_update`

**Input:** exact target/tag, required `expectedGeneration`, nonempty `changes`, optional
`policy` (only `{}` is accepted). **Result:** supported recipe/preview with before/after
schedule, participants/bounds and a preparation token, or an unsupported explanation.

This performs exact graph inspection without changing Apple. A supported token expires
within ten minutes/session expiry and binds the owner, account, generation, request and
graph. Pass it with identical arguments as `preparationToken` to `update_reminder`; a
changed graph/request conflicts. The preview makes linked date effects reviewable and never
authorizes the mutation by itself. It does not redirect a completed history to the active
series or infer a wall-clock/recurrence-anchor policy.

### `update_reminder`

**Input:** exact target/tag, nonempty `changes`, optional `preparationToken` and
`expectedGeneration`. **Result:** updated open reminder with its new tag.

Only supplied fields change. Title/notes edits replace that field's formatting with plain
text; omitted documents remain intact. `notes: ""` clears notes. Priority is 0 none, 1 high,
5 medium or 9 low. Completion, deletion, parenting, URLs/tags and list transfer have their
own tools because those changes have different native graph effects.

| Change | Behaviour and reason |
| --- | --- |
| `dueDate`, `timeZone`, `allDay` | Simple date edits or supported linked date recipes preserve the correct native schedule rather than changing only the displayed date. Timed linked moves require whole-second explicit-offset instants and an IANA zone. Zone-only changes preserve the instant, not the local clock. |
| `dueDate: null` | Clears a simple date plus its zone/all-day marker unless explicitly overridden. Known linked clearing retires the date pair and recurrence, removes early reminders and preserves a supported location alarm/calendar metadata. |
| Timed ↔ all-day conversion | All-day conversion requires the desired date at midnight UTC with `Z`, removes the stored zone/date pair and removes hourly recurrence. Timed conversion requires explicit date and zone. Supported location pairs and early payloads are preserved. |
| `recurrence` or `null` | Creates/edits/removes one known rule. Supply `frequency` and `interval` (1–999), optionally one compatible day/month pattern and explicit-offset `endDate`; null end removes it. Compatible omitted patterns/end remain; frequency changes clear incompatible patterns. No arbitrary RRULE, count/exception or anchor reinterpretation. |
| `earlyReminder: { unit, count }` or `null` | Creates/edits/removes one minutes/hours/days/weeks/months offset (count 1–10,080). Creation discovers and exact-version guards a native early-reminder metadata witness in the same list; it never guesses Apple's private account identifier or copies the source's acknowledgement. Existing private metadata is preserved. An existing finite `acknowledgedDate` is recognised and its bytes stay untouched during a date move; changing that acknowledged offset needs a separate native recipe. |
| `locationAlarm` or `null` | Creates one alarm from full resolved `place` (title, address, latitude, longitude), `proximity` (`arriving`/`leaving`) and positive `radiusMeters` (at most 1,000,000); supplied metadata edits the existing one, null removes it. The connector does not geocode text or choose a dropdown result. |

Recurrence frequencies are hourly/daily/weekly/monthly/yearly. Patterns are weekly ISO
`weekdays` (Monday 1–Sunday 7), monthly `monthDays` (1–31) or one
`ordinalWeekday: { weekday, ordinal }` (-1 last or 1–5), or yearly `months` (1–12).
Date-only moves can also preserve the observed interval-one monthly rule with
`DaysOfTheMonth: [28,29]`, `SetPositions: [-1]` and no end. The preview reports
`monthDays: [28,29]` and read-only `setPositions: [-1]`, retaining the native selection
rather than reporting two independent monthly occurrences. The exact rule is guarded
in the atomic group and its fields are unchanged. Omit `recurrence` and `allDay` for
this recipe; editing/clearing the special rule or converting its date remains refused.
Unsupported early-payload diagnostics identify the rejected field path or reminder
identity without returning private account identifiers or payload values.

Hourly needs a timed date. The supported date graph can contain one absolute-date pair,
one location pair and one known recurrence; child scheduling guards the exact open
same-list root. Multiple same-type alarms, unknown relative payloads/schedules and repeated
local times are refused. Linked participants are protected in one bounded atomic group.
The [scheduling recipes and evidence](linked-record-protocol.md#permanent-in-place-absolute-date-updates)
explain why updating one visible field can also update or retire alarm records.

### `get_reminder_organization`

**Input:** exact `listId`/`reminderId`, optional `expectedGeneration`.
**Result:** reminder tag, separate `url: { id, url }` or null, literal `tags: [{ id, name }]`
and opaque `otherAttachmentIds`.

It resolves native organization relationships instead of parsing title/notes. Other
attachment contents and signed links remain hidden. Use this exact read after uncertain
URL/tag changes; generic reminder reads expose relationship IDs, not their meanings.

### `set_reminder_url`

**Input:** exact target/tag, `url` (one credential-free HTTP(S) URL or `null`), optional
`expectedGeneration`. **Result:** updated reminder/relationship IDs.

It creates or retires native URL attachment records atomically with the reminder's URL
selection. Clearing is not a notes edit. Unrelated attachments/tags are preserved; multiple
URL attachments are refused. Retired URL records are soft-marked and detached from their
reminder backlink. This follows the supported native linked-record representation; after
uncertainty use `get_reminder_organization` before any new request.

### `set_reminder_tags`

**Input:** exact target/tag, `tags` (up to 16 unique literal names, no whitespace/controls;
`[]` clears all), optional `expectedGeneration`. **Result:** updated reminder/relationship IDs.

This **replaces the entire selected reminder's tag selection**. Matching existing tag records
are retained/guarded, new ones created and removed ones soft-retired/detached atomically.
Tags are native relationships rather than hashtag-looking text. It does not rename a tag
globally or retag other reminders. Read organization after uncertainty and preserve unrelated
URL/content state.

### `move_reminder`

**Input:** exact source target/tag, `destinationListId`, `sourceListChangeTag`,
`destinationListChangeTag`, optional `expectedGeneration`. **Result:** the same Reminder ID
with its destination List relationship.

The supported source is an undated, open, childless ordinary root in a different owned
standard private list. Identity, content, one URL and ordinary tags are preserved; native
parent and both memberships change atomically. Exact List versions prevent overwriting
membership edits. Schedules, recurrence, alarms, descendants, assignments, sections and
other attachments are refused. Reconcile uncertainty through the exact ID in both lists;
a bounded child scan is not a universal lock against unseen native additions.

### `copy_reminder`

**Input:** move arguments plus one stable UUID `idempotencyKey`. **Result:** a fresh reminder
and key, or matching read-only replay.

It has the same ordinary-root scope as move, but creates new Reminder, URL and tag identities
and leaves the source content in place. Title/notes are copied as plain text, plus priority
and flag. The source graph and List memberships are guarded atomically. Up to 128 encrypted
copy request/content fingerprints are retained per Apple session, without storing bodies.
Identical retained inputs can reconcile after guard tags advance; changed inputs/content
conflict. A lost acknowledgement therefore cannot produce an extra copy. Session replacement
does not automatically adopt a previous session's copy as a matching request.

## Completion, reopening and deletion

These three tools take the exact `listId`, `reminderId`, `recordChangeTag` and optional
`expectedGeneration`. Supply current versions for **the selected identity**. A history
record and its still-active recurring root are different reminders.

### `complete_reminder`

**Additional input:** optional `recurrenceCalendarTimeZone` for the supported ended all-day
daily rule. **Result:** `record`, optional `affectedRecords` and, when recurrence advances,
`completedOccurrence`.

An ordinary open reminder becomes completed. Completing an ordinary parent also completes
its open children at the same completion timestamp, preserving children completed earlier.
Completing a child changes only that child; completing every child individually leaves the
parent open. This matches observed native actions. The known one-level family and List are
guarded atomically; supported ordinary members can have one absolute-date pair, which is
retained. Recurring completion follows the separate lifecycle below, so a successful
`record.completed: false` can be the correct next active occurrence.

### `reopen_reminder`

**Additional input:** optional `recurrenceCalendarTimeZone` for the supported final all-day
daily rule. **Result:** reopened `record` and optional `affectedRecords`.

An ordinary completed reminder becomes open. Reopening a parent restores only children
whose prior completion timestamp equals the parent's cascade timestamp; independently
completed children remain completed. Reopening a child leaves the parent's state unchanged.
Supported absolute-date pairs remain intact. Reopening completed occurrence history makes
that history an independent open reminder at its old date; it does not rewind the recurring
root. A supported completed final daily/weekly active occurrence can reopen in place with
its due date/rule retained. Other recurring reopening patterns are refused.

### `delete_reminder`

**Additional input:** `recurringDeletionScope` (`occurrence` or `all_future`) for a supported
active recurrence; optional `recurrenceCalendarTimeZone` only for ended all-day daily rules.
**Result:** updated selected `record` and optional `affectedRecords`.

Ordinary deletion uses Apple's `Deleted` marker and native detach/cascade recipe. Directly
deleting a root or child removes its List/intrinsic-parent relationship and membership;
direct child deletion also touches its root. Deleting an ordinary parent soft-deletes its
children, including completed children, while preserving those cascaded children's native
links and completion state. That differs from directly deleting each child. Supported
absolute-date pairs are soft-retired with backlinks retained. These actions were observed
in Reminders/Recently Deleted; no restore or permanent-purge tool is exposed.

For an active recurrence, scope is mandatory because Apple's two native deletion actions
have different effects. Scope is rejected for ordinary deletion. See the next section for
advancement, retirement and end-date boundaries. Bulk deletion intentionally has narrower
scope and never expands an approved simple target into a family cascade.

Ordinary family inspection must finish within its read budget and the atomic plan must fit
32 records/64 KiB. Unknown, deeper, recurring or early/location-alarmed families are refused.
Discovery resolves the union of the complete query and explicit native List ordering by
exact ID, so a committed child omitted by a lagging query is still inspected. Definite retired
ordering entries are ignored; incomplete, foreign or unsupported live identities refuse
dispatch. Known members, unchanged children, date pairs and the List are guarded together. Native
child additions advanced root/List versions in observed samples; a universal predicate lock
against every unreferenced native addition is not established. This limitation is documented
rather than inferred away. See [native family lifecycle evidence](lifecycle-protocol.md).

## Recurring reminders: why completion can leave a reminder open

Apple stores a continuing series as an **active Reminder identity** with a recurrence rule.
Completing a supported occurrence usually produces two visible states:

| Action | Active identity | Occurrence history | Why |
| --- | --- | --- | --- |
| Complete a nonfinal occurrence | Same ID, still open, due at the next calendar occurrence | A fresh completed Reminder at the old date, without a recurrence link | Matches native Reminders' advancement and completed-history representation. |
| Complete the supported final occurrence | Same ID becomes completed at its existing date; rule retained | No new history (`completedOccurrence` absent) | Native Reminders has no next occurrence to advance to. |
| Reopen completed history | Active series unchanged | The selected history ID becomes an independent open reminder at its old date | Native reopening does not undo the advancement of the series. |
| Reopen the supported final active occurrence | Same ID becomes open at its existing final date; rule retained | None created | Matches native final-occurrence reopening. |
| Delete `occurrence` before the final date | Same ID stays open at the next date | None created; prior history unchanged | Corresponds to **Delete This Reminder Only**, which skips rather than completes. |
| Delete `all_future`, or the supported final `occurrence` | Active root detached and soft-deleted; current rule/supported pair retired | Prior history unchanged | Corresponds to retiring the remaining series, not deleting its past history. |

For example, a weekly reminder due 19 October at 09:00 Europe/London can return its **same
ID due 26 October at 09:00 local time** and a new completed history ID due 19 October.
Across that clock change the UTC time changes from `08:00Z` to `09:00Z`. Adding seven fixed
24-hour periods or simply setting the active root completed would not match the native
behaviour. If the user wants the next occurrence, continue using `record.id`; if they want
to inspect/reopen that completed occurrence, use `completedOccurrence.id` and its own tag.

### Supported completion/reopening recipes

Active-series lifecycle recipes require an exact owned private root, one supported rule,
a due date and complete bounded graph/descendant inspection. They exclude subtasks,
`startDate`, assignments, tags, attachments, early reminders, location alarms and unknown
relationships. Completion/deletion require an open nondeleted active record; recurring
reopening requires its completed exact final occurrence. The same exclusions apply to the
active-series deletion recipes below. Independent history instead uses its supported
ordinary lifecycle recipe.

- **Timed weekly:** childless interval-one root in its stored IANA zone, zero or one supported
  absolute-date pair. A supported end must be on an exact weekly occurrence and local clock.
  Earlier occurrences advance with history; the final completes/reopens in place.
- **Timed daily completion:** non-ended childless interval-one root in its stored IANA
  zone with exactly one absolute-date pair. Advancement preserves the local clock across
  daylight-saving changes; missing or repeated next local times are refused. Active-series
  reopening, ended completion and timed daily deletion require separate evidence.
- **All-day daily:** childless interval-one root at midnight UTC, without stored zone/alarms.
  Inclusive end interpretation without
  `recurrenceCalendarTimeZone` requires a midnight-UTC end. With an explicit valid IANA zone,
  the raw end instant is interpreted as that zone's calendar date, even when the instant is
  itself midnight UTC. The argument interprets the end; it does not set the reminder's zone.
- **All-day last-day monthly:** a childless root at an actual month end at midnight UTC,
  without stored zone/alarms, using the observed no-end rule with native month days
  `[28,29,30,31]` and set position `[-1]`, advancing actual month ends and creating history.
  This is distinct from an arbitrary monthly recurrence or a guessed hidden anchor.

For supported weekly or timed daily advancement with an absolute-date alarm, Apple creates
separate fresh Alarm/
AlarmTrigger pairs for next active and completed history and retires the exact old pair.
History retains its own old-date pair; reopening it retains that pair. The connector follows
that graph transition, not a shared alarm redirected to the next date. Final supported
completion retains the current pair without new history/pairs.

### Supported recurring deletion recipes

- **Timed weekly:** childless interval-one root with exactly one absolute-date pair in its
  stored IANA zone. `occurrence` advances and replaces only the current pair, with no completed
  history; its exact old pair is hard-retired, as observed natively. Caller calendar zones
  are refused. At an ended rule's final local calendar day, the root/rule/current pair are
  soft-retired even if the end clock precedes the due clock. Earlier advancement must fit
  within the raw end instant; if it cannot, an actionable error requires explicit
  `all_future` or a separately reviewed end-date edit.
- **All-day daily:** childless interval-one root at midnight UTC, without stored zone/alarms.
  `occurrence` advances without creating history or an alarm pair; the inclusive final date
  retires the root/rule. An explicit calendar zone is allowed only for an ended daily rule,
  using the same end interpretation as completion.
- **All-day last-day monthly:** childless no-end root at an actual month end with the observed
  `[28,29,30,31]`/`[-1]` rule, no stored zone/alarms. `occurrence` advances to the next month
  end without history/pairs. `all_future` retires the active root/rule.

`all_future` preserves earlier history and unrelated fields, detaches the active root and
soft-marks its current supported rule/pair. The List ordering token follows the observed
retirement recipe without fabricating absent membership. Supported final deletion retains
the caller's scope in recovery even when its result equals all-future retirement.

Recurrence-edit support is broader than lifecycle support: other intervals/patterns,
counts/exceptions, overdue skipping, recurring families and unsupported end conditions need
their own native evidence/recipes. Recurring operations retain an encrypted immutable intent
before dispatch, binding original ID/tag/action/scope/calendar zone and generated identities.
An uncertain replay reconciles those exact outcomes read-only instead of creating another
history or alarm pair. See [native recurring observations](lifecycle-protocol.md#recurring-completion-and-history)
and the [acceptance register](native-reminders-parity.md#acceptance-of-bounded-recurring-completion).

## Durable bulk jobs

Jobs are connector orchestration, not a native Apple Reminders job object or an all-or-nothing
bulk transaction. They stage an immutable authorized manifest and execute each supported
item separately. Execution is **request-driven on both deployment targets**. There is no
Queue consumer or cron runner; `executionMode` is always `request-driven`. Only authenticated
`continue_reminder_job` calls advance the job.

### `create_reminder_job`

**Input:** `kind` (`bulk_create`, `bulk_delete`, `bulk_update` or `bulk_complete`), UUID `idempotencyKey`, required
`expectedGeneration`. **Result:** empty encrypted draft, `jobId`, revision and expiry.

It saves no Apple mutation. The normalized UUID is the recovery/job ID, so a lost response
does not require a second job. Changed key/kind/generation reuse conflicts. Authorization
expires within 24 hours or the original fixed session deadline, whichever is earlier.

### `append_reminder_job_items`

**Input:** `jobId`, UUID `chunkKey`, current `expectedRevision`, ordered `items`; each item
has `kind`, unique `clientItemKey` and strict operation `input`.
**Result:** updated draft/revision and counts.

Append 1–50 items per request within 64 KiB; the job supports up to 1,000 items/2 MiB input.
Stable chunk keys prevent duplicate ingestion; changed reuse or concurrent revisions conflict.
Create items retain their own UUIDs, so equal titles do not collapse. Other items retain
their exact list/reminder/version. Updates also include nonempty `changes` limited to title,
notes, priority, flagged, dueDate, timeZone and allDay; omitted fields remain untouched.
No dynamic search selection or automatic tag refresh is allowed.
This stages authorized inputs without changing Apple.

### `preview_reminder_job`

**Input:** `jobId`, current `expectedRevision`. **Result:** sealed immutable manifest,
counts, first-page summaries/results and ten-minute preview token.

It validates the entire manifest and read-only preflights delete, update and completion
targets. Missing, stale, duplicate, recurring, alarmed, nested and parent targets fail
explicitly and never dispatch. Updates/completion additionally exclude early alerts and
start dates; date transitions that change linked scheduling fields, including all-day
conversions, must be reviewed individually.
Review additional pages through `get_reminder_job` before authorization. Sealing and token
binding prevent the accepted work changing between review and start; a token is not user
authorization and preview performs no Apple write.

### `start_reminder_job`

**Input:** `jobId`, reviewed unexpired `previewToken`. **Result:** accepted durable work and
actual execution mode.

Call within the user's authorization for that exact manifest. Start saves durable authorized
work **without executing an Apple mutation in this request**. Call `continue_reminder_job`
for progress, respecting `nextRetryAt` and reviewing unknown or paused states. Each delete repeats single-item checks and never
cascades a newly discovered family; a post-commit native child is reported as `SUBTASKS_REMAIN`
or an incomplete-check warning. Execution order does not promise native display order.
Updates and completion also repeat exact-version and childless-root checks, with a List
version guard. Completion cannot silently expand to a family operation. A lost response
remains unknown; recovery compares the persisted planned fields, including implicit date
changes, without resubmitting the mutation.

### `get_reminder_job`

**Input:** `jobId`, optional `offset` (default 0), `limit` (1–50, default 50).
**Result:** state, counts, ordered exact inputs/results and `nextOffset`.

This is a read of the encrypted owner-scoped ledger. Follow `nextOffset`, because byte bounds
can shorten pages. It never dispatches, renews a session or schedules work. Results distinguish
`operationConfirmed` (valid receipt) from `desiredStateObserved` (matching current state).
Observed state alone does not prove that the uncertain operation performed the change.

### `cancel_reminder_job`

**Input:** `jobId`. **Result:** persisted cancellation and honest in-flight/unresolved counts.

It stops future dispatch. Already dispatched work may finish or be reconciled read-only.
Cancellation **is not rollback**: successful creates remain and deleted targets are not
restored. This avoids claiming that a local cancellation can undo an Apple request in flight.

### `resume_reminder_job`

**Input:** `jobId`. **Result:** eligible resumed job state, or a scope/expiry/cooldown error.

It requires the same Apple account, original generation and unexpired authorized manifest.
Persisted cooldown is honored. It does not adopt a reconnected session, refresh deletion tags
or replay uncertain mutations. Use `continue_reminder_job` to execute/reconcile a slice.

### `continue_reminder_job`

**Input:** `jobId`. **Result:** progress after at most three ledger-selected items in a
bounded slice, including failures/conflicts/unknown outcomes.

This is the job call that can perform Apple writes. Account/job leases and per-operation
session fences prevent concurrent runners from dispatching the same item; durable intent is
saved first and cancellation checked before dispatch. Recovered ambiguous intent is read-only
reconciled, never automatically replayed. Definite undispatched transient failures may retry
within the persisted cooldown/attempt bounds. Without further calls, request-driven work
pauses. Mixed outcomes finish `completed_with_errors`, not blanket success. See
[job contracts and recovery](reminder-jobs.md).

## HTTP API and authentication

The MCP endpoint is **`POST /mcp`**, using stateless Streamable HTTP JSON-RPC. Initialize the
MCP client, discover tools with `tools/list`, and invoke with `tools/call`, for example:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "complete_reminder",
    "arguments": {
      "expectedGeneration": 7,
      "listId": "List/00000000-0000-4000-8000-000000000001",
      "reminderId": "Reminder/00000000-0000-4000-8000-000000000002",
      "recordChangeTag": "<current-reminder-tag>"
    }
  }
}
```

These are invented example values; use IDs/tags from your own reads. A supported nonfinal
recurrence returns the next active reminder as `record` and old completed history as
`completedOccurrence`. Ordinary/final completion has no newly created history.

The following HTTP routes serve the private dashboard/development client. They are not an
unauthenticated Apple API. Sites supplies dispatch-owned identity; standalone Workers verify
Cloudflare Access identity. The configured owner is explicit, never automatically claimed.
HTTP POST routes require same-origin checks; request identity cannot be supplied in JSON.
MCP requires the authenticated owner and rejects a supplied foreign `Origin`.

| Route | Contract and purpose |
| --- | --- |
| `GET /api/bootstrap/identity` | Report authenticated principal and whether it matches the configured owner. Allows explicit operator binding; does not claim ownership or connect Apple. |
| `GET /api/connection` | Same connection-state service as `connection_status`; no Apple reminder fetch. |
| `GET /api/auth/config` | Report login gates/configuration so the private UI can show required setup. |
| `GET /connect/apple`, `GET /api/auth/client.js`, WebSocket `/api/auth/socket` | Dedicated browser credential document/proof exchange. Password proof stays in the browser; normal MCP/API tools do not accept passwords or derived keys. |
| `POST /api/auth/resume` | `{ expectedGeneration, restartApproval? }`; continue/restart the bounded trusted-device approval flow. Does not mutate reminders. |
| `POST /api/auth/disconnect` | Disconnect/clear local connection state and invalidate pending session work. Cannot undo already dispatched Apple writes. |
| `POST /api/apple/read` | Required `expectedGeneration` and strict controlled-read `action`; diagnostic dashboard reads described below. It is not the MCP normalized-output contract. |
| `POST /api/mutations` | Required `expectedGeneration` plus strict `action` and matching single-reminder tool arguments. Returns the same mutation service result. No raw-record/force-write interface. |
| `POST /api/reminder-updates/prepare` | Same input/result as `prepare_reminder_update`; required generation and exact graph/request binding. |
| `POST /api/reminders/inspect` | Same input/result as `inspect_reminder`, with required `expectedGeneration`; no Apple writes. |
| `POST /api/reminder-jobs` | Same as `create_reminder_job`. |
| `POST /api/reminder-jobs/:jobId/append`, `/preview`, `/start`, `/cancel`, `/resume`, `/continue` | Same as corresponding job tool; omit `jobId` from JSON because it is in the route. |
| `GET /api/reminder-jobs/:jobId?offset=0&limit=50` | Same paged read as `get_reminder_job`; only `offset`/`limit` query parameters are accepted. |
| `POST /api/reminder-evidence/capture` | Local-only synthetic evidence capture, requiring exact case/list/reminder/generation. Read-only Apple graph capture, sanitized output; not a general user-content export. |
| `POST /api/reminder-evidence/atomic-protection` | Local-only synthetic protocol test requiring those fields, `dependencyType` and `confirmVersionGuardWrites: true`. **Performs version-guard writes** to validate atomic conflict behaviour; not a read-only health check. |

`/api/mutations` actions are `create`, `update`, `complete`, `reopen`, `delete`,
`create_subtask`, `set_parent`, `set_url`, `set_tags`, `move` and `copy`. List creation,
rename/deletion, appearance, exact organization reads and search are exposed through their
MCP tools; no equivalent general REST route is currently registered for them.

Controlled read actions are `discover`, `saved-lists`, `current-lists`,
`refresh-saved-lists`, `lookup-lists` (1–10 `listIds`, optional `expectedZoneOwner`),
`probe-shared-lists` (1–10 explicit IDs), `reminders` (list/options/continuation) and
`reminders-batch` (1–2 unique lists, `includeCompleted`, page limit). These are controlled
discovery/diagnostic paths; a shared-list probe does not enable shared MCP parity. The
[direct-read document](direct-list-retrieval.md) explains discovery states and bounds.
HTTP failures use a sanitized `{ error: ... }` and HTTP status, while MCP failures use the
tool/MCP envelope described above. General mutation/job/preparation requests are bounded to
64 KiB, controlled read/resume to 12 KiB, and Apple responses to 1 MiB. JSON API responses are
private and not cached. See [architecture and trust boundaries](architecture.md).

## Evidence, boundaries and maintaining this reference

Native behaviour statements refer to disposable synthetic app captures and connector round
trips recorded in [lifecycle observations](lifecycle-protocol.md),
[linked scheduling evidence](linked-record-protocol.md), [list management](list-management.md)
and the [capability/acceptance register](native-reminders-parity.md). They establish the
specific recipes, not an official Apple API guarantee. The register tracks remaining
functionality and validation gaps. Mac-visible synchronization is accepted as the sync
boundary; actual notification delivery remains unverified/deferred.

When changing a tool, update its name/input/output/behaviour and rationale here, plus the
README summary and relevant evidence/limits. Add a distinct native lifecycle recipe before
claiming new parity; document connector-specific safeguards separately. Authoritative
implementation entry points are [MCP registration](../src/mcp/handler.ts),
[public output schemas](../src/mcp/schemas.ts), [HTTP routing](../src/api/router.ts),
[connection/mutation service](../src/auth/service.ts) and [job schemas](../src/jobs/schemas.ts).

## Connector collections, export and saved filters

`get_reminder_view` and `export_reminders` scan complete live search results before sorting or
exporting. Supply `timeZone`, `referenceInstant`, optional `view`, `upcomingDays`, `sortBy`,
`filters` and `expectedGeneration`. Export adds `format: "json" | "csv"`. Public bounds are
25 pages, 1,000 scanned records, 512 KiB and 30 seconds; exceeding a bound returns an error
without partial records. These tools do not mutate Apple.

`save_reminder_filter`, `get_reminder_filters`, `run_reminder_filter` and
`delete_reminder_filter` manage independent encrypted owner-scoped connector definitions.
Migration 0003 is required; updates/deletion use exact filter revisions. A run needs a new
explicit reference instant. See [examples and semantics](connector-collections.md).

## Durable connector creation and list duplication

`create_reminder_workflow` accepts a stable `workflowId`, `create` fields, optional one-feature
`schedule`, `url`, `tags` and optional `expectedGeneration`. It invokes the existing create,
prepared-update and organization contracts in order. It returns per-stage confirmed, pending,
blocked or uncertain progress. Repeating a persisted started/uncertain stage performs only
read-only reconciliation. Migration 0004 is required. See [workflow contracts](create-workflows.md).

`duplicate_reminder_list` accepts a stable `duplicationId`, exact `sourceListId`,
`sourceListRecordChangeTag`, destination `name` and optional `expectedGeneration`. It performs
complete bounded preflight of at most 20 eligible open undated childless roots, then creates
and populates a new Standard list through existing native copy operations. Native groups,
sections/order/appearance, completed history and schedules are excluded. Migration 0005 is
required. Read-only uncertainty and exact-version rules are in [the duplication contract](list-duplication.md).

Confirmed move/copy responses may include `listVersions` with both exact List tags from that
atomic operation. Read-only copy reconciliation omits them. An observed later List version is
not a receipt from the original write.
