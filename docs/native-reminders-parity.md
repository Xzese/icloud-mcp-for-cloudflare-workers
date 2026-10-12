# Native Apple Reminders capability map

Status: **implementation in progress; remaining backlog mapped**, 12 October 2026. PR #23
builds on PRs #21/#22 and adds bounded search, separate URL/tag reads and writes, and ordinary
reminder move/copy tools, plus guarded ordinary and scheduled family completion/reopening/deletion and ordinary-create
List guards. Root-only recurring completion adds bounded daily, weekly and last-day monthly
recipes with durable occurrence reconciliation and explicit weekly/daily/last-day monthly deletion scopes, including end-day retirement. The remaining native feature families below
are not yet implemented.
Apple's private Reminders web protocol remains undocumented.

The current delivery scope is Shopping category reads/manual item moves, the existing
search follow-up and explicit concurrency verification. The broader inventory below is
a backlog for separate deliveries, not a completion requirement for this scope.

## Versions and baseline

The inspected device runs macOS **27.0.1** and Reminders **7.0 (4046.21)**, confirmed through
the OS version and About Reminders. The live investigation used synthetic reminders in the
Test list and explicitly disposable test lists. No shared invitations, contact selections,
photo-library uploads or device settings were changed for this map.

| Source revision | Status at this audit | Capabilities used as the baseline |
|---|---|---|
| `origin/main` at `f4da3d8` | Main baseline | Private list discovery, paginated and exact reminder reads, all-open reads, plain title/notes, priority/flag, simple dates, create and bounded completion/reopening/soft deletion. |
| [PR #21](https://github.com/Xzese/icloud-reminders-mcp-for-cloudflare-workers/pull/21) at `42bd3cf` | Committed, pushed, live verified; awaiting merge | Durable bulk jobs, one-level subtask relationships and bounded linked schedules, including recurrence/early/location creation, editing, removal and combined date transitions. |
| [PR #22](https://github.com/Xzese/icloud-reminders-mcp-for-cloudflare-workers/pull/22) at `3ef9370` | Committed, pushed, live verified; awaiting merge; based on #21 | Exact list/version reads, standard private list creation, rename and verified-empty deletion. |
| [PR #23](https://github.com/Xzese/icloud-reminders-mcp-for-cloudflare-workers/pull/23) | This implementation PR, based on #22 | Bounded search, native URL/tag organization, ordinary reminder move/copy, guarded ordinary and scheduled family lifecycle, create List guards and the remaining capability map. Open PR features are not represented as merged. |

“Live verified” means the connector's stored result was read back and appeared correctly in
Apple Reminders for the tested recipes. It does not establish notification delivery, every
native variant or protection against an unobserved concurrent change. The owner confirmed
iPhone synchronization and accepts Mac Reminders persistence as the synchronization boundary.
Actual notification delivery is deferred for a later investigation.

## Live evidence register

These references identify observations made through screen access; they are not inferred
write recipes. Private captures remain ignored, with no account identities or raw records
included in this document.

| Evidence | Observation |
|---|---|
| UI-1: File menu | New Group, New Section, New Section with Selection, Edit Sections, Move to Section, Auto-Categorise, Pin List, Share/Manage Shared List, Convert/Create Smart List, View Templates, Save as Template, Show List Info and Print. Some depend on selection or list type. |
| UI-2: View menu | List/Columns; Manual, Deadline, Creation Date, Priority and Title sorting; Today, Scheduled, All, Flagged, Assigned, Completed and Urgent smart views; completed-item visibility and subtask expansion controls. |
| UI-3: New List editor | Twelve colour choices, standard badge/emoji, Standard/Shopping/Smart List types, Templates. Smart List filters expose Tags, Date, Time, Priority, Flag, Location and Lists. The unsaved editor was cancelled. |
| UI-4: Synthetic reminder details | Separate URL field, Date/Time/Urgent, List selector, Tags, Flag, Priority, Location and When Messaging. Dated samples also expose Repeat and Early Reminder. |
| UI-5: Reminder context/quick controls | Section creation with selection, moves to physical lists, adding to a smart view, Add/Clear Tags, cut/copy/paste, and photo/scan attachment controls. No personal files or contacts were selected. |
| LIVE-21 | Native recurrence/early/location captures and connector round trips, including mixed date clearing, date restoration, hourly-to-all-day retirement and fresh early alerts. See [PR #21 protocol evidence](https://github.com/Xzese/icloud-reminders-mcp-for-cloudflare-workers/blob/42bd3cf/docs/linked-record-protocol.md). |
| LIVE-23 | Native URL/tag and move/copy captures; production MCP search, URL replacement/clearing, tag replacement/clearing, fresh copy and original-key read-only reconciliation, identity-preserving move, and a native URL reverse edit. All appeared correctly in Reminders. Both disposable lists and their samples were removed after acceptance; no personal records were mutated. |
| LIVE-22 | Native list create/rename/delete captures; production connector create/rename/delete visibly confirmed. Matching keys caused no second write; stale/different-name requests conflicted; open and completed members prevented deletion. Disposable lists were cleaned up. See [PR #22 evidence](https://github.com/Xzese/icloud-reminders-mcp-for-cloudflare-workers/blob/3ef9370/docs/list-management.md). |
| LIVE-LIFECYCLE | Fresh native parent/subtask completion, selective reopening and soft deletion; recurring successor/history, clock-change and deletion-scope captures; production Worker ordinary-family acceptance and lost-acknowledgement read-only reconciliation. See [lifecycle evidence](lifecycle-protocol.md). Bounded root recurring completion, daily final completion/reopening, cadence-aligned timed weekly endings, explicit ended/non-ended timed weekly and all-day daily deletion scopes, plus no-end all-day last-day monthly deletion and ordinary/scheduled family lifecycle are implemented; other recurring lifecycle remains outstanding. |

Native menu visibility establishes an opportunity to investigate. It does not establish where
Apple stores a feature, whether it syncs, or which CloudKit mutations are sufficient.

## Capability inventory

The “Next work” column describes the smallest useful investigation or implementation;
items marked missing are not exposed by the current MCP tools.

| Capability | Native evidence | Current MCP status | Next work and acceptance boundary |
|---|---|---|---|
| Plain title, notes, priority and flag | UI-4/5; main baseline | Main | Retain unchanged documents/unknown metadata. Rich formatting after editing needs separate fidelity checks. |
| Separate URL field | UI-4; LIVE-23 | #23: typed native URL read, replacement and clearing | One HTTP(S) URL attachment; preserve other assets and tags with exact-version atomic writes. Multiple URL attachments remain excluded. |
| Create, complete, reopen and soft-delete reminders | Main; UI-5; LIVE-LIFECYCLE | Ordinary roots/children, bounded families and standalone roots with one absolute date alarm; #21 adds create/delete jobs | Root-only daily, weekly and last-day monthly advancement/history, daily final completion/reopening with explicit calendar-zone support, and cadence-aligned timed weekly endings are implemented; explicit occurrence/all-future deletion of timed weekly and all-day daily roots, including supported endings, and no-end last-day monthly roots is implemented; other end conditions, recurring reopening/deletion patterns and recurring families remain outstanding. Reopen does not mean restore a deleted record. |
| Date/time and time-zone changes | LIVE-21 | Main simple dates; #21 linked recipes | Keep explicit instant/calendar-date semantics. Start dates and additional native date shapes remain unverified. |
| Recurrence creation, editing and removal | LIVE-21 | #21: hourly/daily/weekly/monthly/yearly intervals; supported weekday/month patterns and end instant | Root completion has separate bounded daily/weekly/last-day monthly recipes. Daily end completion/reopening requires an explicit calendar zone for nonmidnight instants; omission retains the UTC-midnight recipe. Timed interval-one weekly endings also support exact same-clock, cadence-aligned end instants in the stored IANA zone. Anchor changes, other end/count completion, exceptions and imported rules remain gaps. Do not expose a generic RRULE writer from these bounded recipes. |
| Early reminders | LIVE-21 | #21: one minutes/hours/days/weeks/months offset | Creation requires a validated exact-version native witness in the same list. Additional offsets/variants and creation with no witness need evidence. |
| Arrival/departure location alerts | LIVE-21 | #21: one resolved place, radius and proximity, with a known date alarm | Text geocoding, car/Bluetooth triggers and other location variants are missing. Stored location parity does not verify device notification permissions. |
| Multiple/special alarms | UI-4; LIVE-21 bounds | One date alarm plus one location alarm supported in #21 | Capture further graph types individually; do not assume the known trigger shape applies to them. |
| Durable bulk work | LIVE-21 and production integration | #21: encrypted jobs for create and soft delete | Update/complete jobs remain outstanding. Use existing bounded jobs for future recipes only after individual operations have verified contracts. Job status is a connector feature, not a native app view. |
| One-level subtasks | UI-5; LIVE-21; LIVE-LIFECYCLE | Bounded create, reparent/detach, independent dates and guarded complete/reopen/delete | Parent completion changes open children; reopening preserves independently completed children. One absolute-date pair per nonrecurring family member is supported. Deeper nesting, other alarm graphs and family transfers remain outstanding. |
| Tags and tag filtering | UI-3/4/5; LIVE-23 | #23: typed literal tag reads and per-reminder selection replacement | Tags are per-reminder records; retain selected identities, create fresh records and retire removed ones atomically. Exact literal tag all/any and tagged/untagged search filters are implemented; global tag rename remains future work. |
| Move between lists; copy/duplicate | UI-4/5; LIVE-23 | #23: undated, open, childless ordinary roots between owned standard private lists | Preserve move identity; create fresh copy/URL/tag identities. Require both List versions and source version; preserve other memberships. Scheduled, family, assignment, section and non-URL asset transfers remain excluded. Copy text is plain text. |
| Search and built-in smart views | UI-2; LIVE-23 | #23: title/notes text, status, exact list, flag, priority and due-range filters | One live Apple page per call; zero matches may still carry a continuation. Without listId, scan all selectable owned private lists discovered at start. Native tag all/any, tag/URL presence and separate-URL text filters are implemented. Native Smart List storage and globally sorted result sets remain future work. |
| Sorting and manual ordering | UI-2/5; native List SortingStyle=manual | No ordering/sort-write tool | Complete-result sorting can be a read convenience. Native order changes require ordering-document and token captures; do not guess array replacement. |
| Sections and column view | UI-1/2/5 | Missing | Discover section identities, membership and ordering using a disposable list. Add typed reads before section CRUD/moves. Columns present sections; storage of the view preference has not been captured. |
| Standard list CRUD | LIVE-22; LIVE-LIFECYCLE | #22: create/read/rename/empty delete; ordinary create now guards List | Connector create/delete serialize through the List guard. Native root creation/attachment advanced List versions in observed samples; a universal native membership lock remains unproven. Appearance/types/groups and nonempty cascades remain outstanding. |
| List colours, badge/emoji and pinning | UI-1/3; twelve native colours, emoji and pin/unpin captures | #23: typed appearance reads and twelve-preset/emoji updates | Default Color is absent; explicit presets and emoji use native JSON strings. Standard badges and pin writes remain outstanding; pin adds PinnedDate, while unpin also changes parentAccount tokens and sidebar placement. |
| List groups and organisation | UI-1; IsGroup list metadata | Groups excluded from selectable mutation targets | Capture group membership, order, rename and removal. Distinguish removing a group from deleting its lists. |
| Shopping/grocery lists and categories | UI-3; category flags in LIVE-22; scoped category acceptance below | Category reads and manual moves to existing same-list categories implemented | Empty materialised categories are read through a category-only metadata feed. Category management, list conversion and unmaterialised suggestions remain separate work. |
| Native custom Smart Lists | UI-1/3 | Missing | Read stored all/any filter definitions and identity first. Server-side filters are useful independently and must not be advertised as a native synced Smart List. |
| Templates | UI-1/3 | Missing | A connector snapshot/copy tool can come first. Native save/import, template identity, update and sharing need their own captures and acceptance. |
| Shared lists and reminder assignment | UI-1/2; Apple documentation | Private-zone tools only; bounded shared diagnostics do not provide normal shared CRUD | Establish shared-zone access, participants, roles, revocation and assignment identity with an explicitly approved sharing test. Do not route shared writes through the private client. |
| Photos, scans and other attachments | UI-5; AttachmentIDs/related metadata | Partial metadata; no attachment upload/download tool | Discover native asset/encryption/link lifecycle; bound types/sizes and signed URL handling. Use synthetic files for acceptance. Separate URLs from photo/scan assets. |
| Urgent reminders | UI-2/4/5; Apple iOS guide | Missing | Investigate a potentially synced urgency flag and its date prerequisites. Alarm delivery remains device-dependent; a remote write cannot establish delivery or configure alarm permission. |
| When Messaging | UI-4; Apple iOS guide | Missing | Investigate synced contact/trigger representation only with an approved test identity. Detection while messaging is native-device behaviour. |
| Notification preferences, all-day alert time and default list/time zone | Apple guides | No settings tools | Determine which preferences sync and which are local. Preserve scheduling data independently of device settings; normal reminder writes do not configure Focus or permissions. |
| Recently deleted history and restore | Apple iOS guide; existing soft-deleted exact reads | Partial reconciliation; no restore/purge tool | Capture restore and retention behaviour separately from completion reopening. Native permanent deletion and list restoration are not inferred from a Deleted marker. |
| Calendar, Siri, widgets, share-sheet and natural-language entry | Apple guides; UI deadline shortcuts | Native integrations; no remote UI tools | Scheduled data can be used by native clients, but Calendar display was not tested. Optional parsing must produce explicit date/time-zone inputs; do not promise device actions or Calendar event creation. |
| Apple Intelligence suggestions/Auto-Categorise | UI-1; Apple Mac guide | Missing | Determine how resulting categories/reminders are stored and preserve them. A connector classifier is not Apple's native model or device service. |
| Print, export and import | UI-1; Apple guides | Missing | Bounded JSON/CSV export can be a connector convenience. Native print/layout/template/file import formats require independent evidence. |

## Implemented search and organization contracts

`search_reminders` matches a case-insensitive substring in title or notes, with optional
`status` (open by default, completed or all), `listId`, `flagged`, `priority`, `dueFrom` and
`dueTo`. `tags` requires 1–16 unique exact case-sensitive literal native names, with
`tagMatch` set to all (the default when omitted) or any. `hasTags` selects tagged or
untagged reminders. `hasUrl` selects presence/absence of a separate native URL;
`urlText` matches its case-insensitive substring. Text in title/notes and non-URL
attachments does not satisfy these organization filters. All supplied filters combine
with AND; contradictory presence/text or presence/tag requests are refused.
One call reads one Apple page, up to 200 reminders; no matches can still mean that
more pages are pending. Repeat the same filters and use each newly returned continuation.
The encrypted cursor retains selection, progress and fingerprints for ten minutes, never
reminder bodies. Owner, Apple account, generation, options and continuation replay are
checked. The frozen list selection does not make live pages an immutable snapshot.

Only scalar-matching candidates and requested relationship types are hydrated. Each call
resolves at most 256 unique related IDs through at most eight exact lookups of up to
32 records, with a 256 KiB metadata budget. Selected links, active backlinks, owner and
private zone must all validate; incomplete or unknown metadata errors explicitly instead
of silently hiding a match. Errors leave the continuation unconsumed. Exceeding the
budget requires a narrower search or a fresh search with a smaller limit. Plain searches
perform no additional relationship lookup, and unrequested relationship types remain
opaque. Tag/URL filter values are represented only by the existing cursor filter hash;
reminder bodies and hydrated metadata are never persisted.

URL absence requires an empty attachment selection or a recognized non-URL image
classification. Selected URL-bearing, missing, conflicting or unknown classifications
are refused instead of silently matching absence. Native image paste supplied an
`Image`/`public.png` witness; the synthetic JPEG classification is also covered.
Search does not download asset files or expose their signed links. Legacy
organization read/write classification remains unchanged.

`get_reminder_organization` resolves a selected reminder's URL and literal tag names with
related IDs. Non-URL attachments are returned only as opaque IDs. `set_reminder_url` sets one
credential-free HTTP(S) URL or clears it with null. `set_reminder_tags` replaces the entire
selection (up to 16 unique literal names) or removes all tags with an empty array. These
operations create fresh related records, retain matching selected tags, and soft-retire
removed URL/tag records by setting `Deleted=1` and removing their reminder backlink. Root
relationship IDs, last-modified date and its native resolution token are changed together.
Retained relationships are exact-version guards; unrelated records and fields are preserved.

`move_reminder` preserves the selected ordinary root's identity, updates its List reference
and native parent, and removes/appends only that ID in the source/destination memberships.
`copy_reminder` creates a fresh reminder and fresh URL/tag identities, protecting source
reminder, source relationships, source List and destination membership atomically. Copy
preserves visible title/notes as plain text, priority and flag. Both tools require different
owned standard private lists, exact root/List versions and an undated, open, childless root.
Schedules, recurrence, alarms, assignments, sections, nested reminders and other attachments
are excluded. The transaction is bounded to 32 records and 64 KiB.

Before copy dispatch, the existing encrypted Apple session retains the stable UUID plus
request and copied-content fingerprints. Identical reconciliation returns `replayed=true`
without a write even when the original guard versions advanced. Changed inputs or changed
copied content conflict. No reminder body is persisted. Up to 128 copy keys are retained for
that session; they are not evicted to authorize silent key reuse. Disconnect/replacement
clears this local evidence, so existing copies from another session are read by exact ID and
are not automatically adopted as a matching request.

Apple expands reference confirmations with authenticated zone metadata, returns created
text documents as encrypted-byte wrappers, and omits null completion dates. Confirmations
validate these observed representations. Same-tag reads refresh only the signed download
URL inside the observed `UrgentPresentationAlarmsAsData` and List
`MembershipsOfRemindersInSectionsAsData` assets; dedicated native presentation comparisons
exclude those URLs while preserving asset checksums, encryption metadata and all other fields.
Scheduling guards and UPDATE receipts use the same narrow URL normalization, preserving
checksums, encryption metadata and every other field.

Known-record versions reject atomic conflicts; unsupported or incomplete preflight fails
before dispatch. A lost acknowledgement is never automatically replayed. Descendant absence
is checked through a bounded complete read. A new child arriving after that read without
advancing an existing participant's version is still an unproven concurrency boundary.
Full-service parent completion and empty-list deletion each rejected committed independent
guarded API membership changes and the equivalent native UI changes.
Ordinary connector creation now guards the List in the same atomic group. Root-only recurring advancement/history uses the bounded
recipes in [write access](write-access.md); other recurring lifecycle remains outstanding. Ordinary deletion follows the distinct
native detach/cascade recipes with exact readback of the selected detached record. Ordinary family completion/reopening uses complete bounded discovery and atomic
known-family/List guards, following the selective native completion-timestamp behavior in
[the lifecycle protocol](lifecycle-protocol.md). Native history/identity and deletion evidence
has been captured for the next implementation stage.

## Acceptance of the first implementation bundle

The production Worker was exercised against the retained Apple session using synthetic
reminders in two disposable native lists. Search found the selected sample; typed URL/tag
reads matched native edits. URL replacement retired the previous attachment, and tag
replacement retained the selected tag identity while creating and retiring the other records.
Copies appeared with independent URL/tag identities. Reconciliation with the original copy
key after an uncertain acknowledgement returned the existing copy without another write;
a fresh copy confirmed normally. A stale URL version conflicted before dispatch.

Move preserved the original reminder identity and its URL/tags, emptied the source list and
added the reminder to the destination. Clearing the moved reminder's URL and tags left the
copies' organization intact. A subsequent URL edit in the native Details editor was read
back through the typed tool. Each step preserved the Apple session generation and its fixed
retention expiry. Screen access confirmed the results and removal of both disposable lists
and their synthetic samples. Recently Deleted was not purged.

Verification passed: TypeScript, all 173 unit tests, production Worker integration journeys,
public configuration checks, the Sites build and artifact verification, and the standalone
Cloudflare build/dry-run/integration checks. An independent review found no remaining issues
in the corrected native confirmation and preservation paths. These checks cover the bounded
recipes above; the concurrency and lifecycle exclusions remain explicit.

The hosted all-open read failure reported on 11 October was reproduced against version 27,
whose source lacked #21's compound-page duplicate handling. Version 28 published that fix
and the first implementation bundle. The actual connector then returned `complete=true`,
28 unique open reminders across all four discovered lists, four completed pages, no
continuation and no read or record errors. The original generation and retention expiry
were preserved. Identical repeated records are deduplicated; conflicting copies remain a
protocol error, covered through the production MCP integration journey.

The raw MCP error result now carries the specific code both in `error_code` and `error.code`.
A harmless stale-generation probe confirmed that the hosted adapter still rewrites the
outer label to `INVALID_ARGUMENT`, while preserving `error.code=CONFLICT` and the original
text response. This adapter label is not evidence of invalid tool arguments. The nested
connector code is the diagnostic contract; changing the hosted adapter is outside this
repository. Failure signals remain explicit with `isError=true`.

## Acceptance of ordinary family lifecycle and create guards

Fresh native captures established mixed-family completion and selective reopening, independent
child changes, direct-child versus parent deletion, recurring history identities, date-alarm
retirement and the distinction between deleting one occurrence and all future occurrences.
At the ordinary-family acceptance stage, the captured recurring graphs were evidence for
the next implementation; recurring recipes were not yet exposed. Ordinary deletion is implemented and verified below. See [the lifecycle protocol](lifecycle-protocol.md).

The production Worker created a separate three-member family in that disposable list.
Independent child completion changed one record; parent completion changed the parent and
its open child, preserving the earlier completed child. Parent reopening changed those two
records and retained the independently completed child. Independent child reopening changed
one record. Native Reminders displayed the resulting states, and a subsequent native child
completion was read back through the Worker.

A stale parent version conflicted with zero writes. An intentionally lost acknowledgement
after Apple's committed parent completion returned `WRITE_OUTCOME_UNKNOWN`; exact readback
showed the cascade had committed, with one dispatch and no automatic replay. Generation and
fixed session expiry were retained. The integration journey also checks stale family/List
guards and newly introduced relationship fields in confirmations. Such uncertain receipts
never become success or authorize another dispatch. Empty optional relationships and native
presentation metadata remain accepted.

TypeScript, all 178 unit tests, production Worker integration, public configuration, Sites
build/artifact and standalone Cloudflare build/dry-run/integration checks passed. Independent
review identified and verified the correction of the receipt relationship gap. The whole
goal remains in progress: recurrence, alarmed lifecycle and the remaining inventory below are
outstanding.

## Acceptance of ordinary native deletion and migration packaging

Production Worker child deletion detached the selected child and advanced its root timestamp.
A sibling retained its contents under a guard; guard versions and audit timestamps advanced.
The native parent cascade then detached the root and marked its remaining child deleted while
retaining that child's List/parent references, membership and completion state. Exact reads
represented the detached roots with `listId: null`. Repeating the original parent request
conflicted with zero additional dispatches. Apple Reminders showed the family removed and
preserved the unrelated recurring sample and three completed histories.

Two initial child requests committed once but were reported uncertain while the parent-reference
representation was investigated. Read-only reconciliation preserved their identities. An
exact-version probe proved the null-name parent dictionary; the corrected request confirmed
normally. The integration journey covers read failure, same-receipt-version field/tag drift,
changed intrinsic parent, empty-to-populated relationships and a child arriving during the final
bulk plan. These fail without replay or an unauthorized bulk cascade. Independent review found
no remaining issues in these repairs.

The Sites package now carries the immutable original `0000_schema.sql` and additive
`0001_reminder_jobs.sql`, rather than rewriting an applied initializer. The Worker upgrade
journey installed all six job tables while preserving an existing synthetic session envelope,
generation and version. TypeScript, all 179 unit tests, production Worker integration, public
configuration, Sites build/artifact and standalone Cloudflare checks passed for this bundle.
The original Apple generation and fixed retention expiry were preserved during live deletion.

## Acceptance of bounded recurring completion

The production Worker completed the native all-day last-day monthly sample from
31 March to 30 April 2027. A deliberately lost acknowledgement returned
`WRITE_OUTCOME_UNKNOWN` after one dispatch. Reconciliation with the original ID/tag
returned the same completed March occurrence with `replayed=true` and zero writes.
Native Reminders showed the advanced open item and completed history.

A fresh native weekly reminder with one absolute date alarm advanced from
19 October at `08:00Z` to 26 October at `09:00Z`, preserving 09:00 Europe/London.
The active reminder stayed open, the completed history retained its old date,
each acquired its own alarm pair, and the old pair returned `NOT_FOUND`. The first
receipt was uncertain because Apple expanded the new alarm references with zone
metadata. Narrow authenticated-zone normalization repaired confirmation, and the
original request reconciled read-only without a second completion. A distinct
next occurrence then confirmed normally from 26 October to 2 November.

A new weekly repeat-end edit confirmed and native Details showed 9 November.
Removing the daily sample's end condition and completing 22 October advanced its
active ID to 23 October and returned completed history normally. These fresh
updates also accepted only the observed signed asset URL refresh; unrelated asset
metadata remains compared. Generation and fixed session expiry were retained.

The recipes protect source, rule, List and exact alarm identities atomically.
Guard writes can advance versions even when their semantic fields remain intact.
Retained intents fence preparation/dispatch and preserve identities through lost
acknowledgements. Local budget/lease failures before dispatch retain a resumable
prepared intent; a prepared advancement whose next due date has passed sends no
write. Definite Apple rejections remain conservative read-only reconciliation.
Other end/count completion, overdue skipping, recurring reopening/deletion and families
remain outstanding; the goal is still active.

Verification passed: lint, TypeScript, all 181 unit tests, full production Worker
integration, local access/transport integration, public configuration, Sites
build/artifact verification and standalone Cloudflare build/dry-run/integration.
Independent review verified the intrinsic-parent, pre-dispatch gate, current-time
and authenticated-reference confirmation repairs with no remaining findings.

## Acceptance of midnight UTC daily endings

Using the same synthetic daily active ID, a confirmed end-date edit selected
26 October at midnight UTC. Connector completion of 25 October advanced to
26 October and returned completed history. Final completion then marked that
same active record completed at 26 October without adding history or changing
its due date. The rule and List semantic fields were retained under version
guards. Reopening cleared completion at that same date and retained the rule.
Both original final and reopening requests reconciled read-only with zero
additional dispatches. Native Reminders displayed all resulting states.

The initial final-date attempt failed before dispatch because Apple's exact List
lookup omitted its top-level zone metadata. Only that omitted zone is now bound
to the authenticated private zone; explicit foreign metadata is rejected.
The original prepared intent resumed with its retained IDs/time and committed
once under a deliberately lost acknowledgement. No replacement request or IDs
were used. Exact read-only reconciliation confirmed its result.

Native menu-created end dates can carry a nonmidnight instant on the previous
UTC date while displaying the intended local calendar end day. That distinct
case is captured in [the lifecycle evidence](lifecycle-protocol.md) and still
now has the explicit calendar-zone recipe below. Occurrence counts, other ended patterns,
alarmed families, additional alarm graphs and recurring deletion remain outstanding. The goal
remains active.

Lint, TypeScript, all 181 unit tests, full production Worker integration, local
access/transport checks, public configuration and both deployment build checks
passed. Independent review verified terminal-mode intent compatibility, original
request reconciliation and the omitted-zone binding without remaining findings.

## Standalone date-alarm lifecycle acceptance

Native reopening and completion of connector-created weekly history preserved its exact
absolute-date Alarm/AlarmTrigger fields, identities and versions. Native recoverable deletion
detached the reminder and soft-marked both linked records while retaining their backlinks.
The new guarded Worker recipe reproduced these actions on a second synthetic history record.
Completion committed once under a deliberately dropped acknowledgement; exact readback
confirmed it, and its original arguments returned `CONFLICT` with zero additional dispatches.
Reopening and deletion then confirmed normally. Exact raw deletion reads showed only `Deleted`
changed on each linked record, with both intrinsic parents retained. Reminders displayed the
sample removed while the active weekly series remained unchanged. Recently Deleted was not purged.

All 182 unit tests, full production Worker integration, TypeScript, lint (six existing warnings),
local transport checks, public configuration, Sites build/artifact and standalone Cloudflare
verification passed. Independent review reported no remaining findings. This recipe covers
childless timed roots with exactly one absolute-date pair; alarmed families, additional alarm
graphs and recurring deletion remain separate work. The overall goal remains active.

## Explicit calendar-zone end acceptance

`recurrenceCalendarTimeZone` now supports the observed nonmidnight native end-date form for
ended all-day interval-one daily roots. It interprets the end instant in the caller's named
IANA zone and compares that calendar date with the UTC all-day due-date label. Omission retains
the previous midnight-UTC recipe; other recipes refuse the argument. The exact zone binds both
the original request and retained intent, without changing stored `TimeZone` or rule fields.

Live acceptance first used a newly menu-created nonmidnight end. It then reproduced the captured
25 October London end stored as 24 October 23:51:29 UTC. Native Details displayed 25 October.
The Worker advanced 24 to 25 October with completed history, completed that same active 25 October
record without history, and reopened it at 25 October with its rule retained. Deliberately lost
advancement and final acknowledgements reconciled their original arguments with zero dispatches;
reopening replay also performed zero writes. Omission was refused before dispatch, and a changed
zone could not reuse a prior outcome. Native Details confirmed the reopened final due/end date.

All 182 unit tests, full production Worker integration, TypeScript, lint, local transport,
public configuration, Sites/artifact and standalone Cloudflare checks passed. Independent
review found no remaining issues. Occurrence counts, other recurring patterns/deletion,
alarmed families and the rest of the capability inventory remain in progress.

## Native list appearance acceptance

Typed colour/emoji read and update tools are implemented and live-verified through the built
production Worker. All twelve palette constants come from separate native captures. Indigo/star
writes displayed in Reminders; a native green reverse edit was read correctly. An orange/bookmark
write under lost acknowledgement confirmed by exact readback, and original stale arguments
returned `CONFLICT` with zero writes. Native section visibility and all unrelated List fields
were preserved. See [list appearance contracts](list-management.md).

The first review caught Reminder-specific List parent verification, incomplete emoji validation
and a smaller token-map comparison budget. All three are corrected, with a representative
large token-map/parent preservation MCP journey and invalid emoji refusal. All 184 unit tests
and the required build/Worker/local/Cloudflare checks passed; focused rereview found no remaining
issues. Pinning and unpinning have native captures but no write tool yet. Standard badges,
sections/groups and other remaining inventory continue under the active goal.

## Acceptance of timed weekly endings and first creation

The built Worker completed the native timed weekly sample's final 9 November
occurrence in place, then reopened it at the same 09:00 Europe/London date.
Its Rule, List and absolute date-alarm pair retained their identities and fields;
no history was created for the final completion. A deliberately lost completion
acknowledgement reconciled with the original arguments and zero further writes.
Reopening also reconciled read-only. Resetting the existing sample to 2 November
through the hosted date tool displayed correctly in native Reminders; the built
Worker then advanced it to 9 November, created one exact completed occurrence and
replaced the old date pair. The lost advancement acknowledgement reconciled to
the same history identity with zero writes. The end rule remained unchanged.

The new terminal recipe requires interval one, a timed root in an explicit IANA
zone, a unique local instant, and an end date on the same weekly cadence and
local clock. It supports either no alarm or one validated absolute date pair.
It does not reinterpret the daily-only `recurrenceCalendarTimeZone` argument.
New terminal intents preserve full intrinsic relationships and asset encryption
metadata; the existing advance and daily intent serialization remains compatible.
Other ending patterns and recurring deletion remain active work.

A fresh connector-created empty List exposed Apple's `Record updated multiple
times in one batch` rejection when the exact List guard followed its first
Reminder create. The absent Reminder was confirmed by its retained UUID.
Native metadata showed that a first intrinsic child initializes List chain
protection; the internal collision mechanism is inferred. Reordering the same
exact-tag marker guard before creation succeeded. The built Worker now follows
that order while preserving its logical receipt order and unchanged creation
fields. Fresh creation, same-key replay, lost-acknowledgement readback and replay
were verified through real Apple requests; replay dispatched no writes.
Subtask creation also binds a full exact List snapshot and the parent version
in the same atomic group; live creation and original-argument replay passed.
Authorization-only lookups retain their summary projection. No guard was
removed and no creation was split into separate Apple requests.

## Native evidence for scheduled families

A separate disposable native family had a timed parent, one independently timed
child and one undated child. Completing the undated child first, then the parent,
completed the open scheduled child with the parent's exact completion timestamp.
The independently completed child's timestamp and version stayed unchanged.
Reopening the parent reopened only the cascaded child. Both absolute-date pairs
and the List retained their versions and semantic fields across these actions.

Recoverable native parent deletion detached the selected root from its List and
intrinsic parent. Both children became soft-deleted while retaining their List,
ParentReminder and intrinsic relationships. Each of the two Alarm/AlarmTrigger
pairs changed only `Deleted` to one, retaining its native backlinks and intrinsic
parents. Only the selected root's List membership was removed; the soft-deleted
children retained their memberships. Direct dated-child deletion detached only
that child, retired only its own pair and advanced the root's modification fields.
Native child reopening under an already-completed parent preserved the parent's
completion state, timestamp and version. Recently Deleted was not purged.

## Scheduled family implementation and built Worker acceptance

Complete, reopen and delete now support bounded one-level nonrecurring families
with zero or one validated absolute-date pair per member, including mixed dated
and undated members. Complete discovery, every member, every pair and the exact
List participate in one atomic group of at most 32 records and 64 KiB. Unknown
wrappers/relationships, early or location alarms and recurrence are refused before
dispatch. Strict receipts preserve unrelated fields, intrinsic relationships and
asset encryption metadata; deletion exactly rereads the detached selected member.
Guard writes can advance versions while retaining semantic fields.

The built Worker reproduced independent dated-child completion, parent cascading,
selective reopening and child reopening/completion under a completed parent on a
fresh native mixed family. Lost parent-completion acknowledgement was confirmed
by exact readback; its original stale arguments returned `CONFLICT` with zero
writes. Lost dated-child deletion similarly reconciled through exact reads and
zero-dispatch stale arguments. Raw reads confirmed only the child's pair changed
`Deleted`, the root changed only modification fields, and sibling/root pair fields
were preserved. Parent deletion then detached the root, soft-deleted the remaining
child while retaining links/membership, and retired the root's pair. Native Reminders
visibly displayed these states. The same generation and fixed session expiry held.

All 185 unit tests, full Worker integration and the required source/build checks
passed. Independent review found no issues. Known-participant conflicts are covered;
a universal guarantee against previously unreferenced native children remains an
explicit concurrency investigation. Recurring deletion, additional alarm graphs
and the remaining capability inventory continue under the active goal.

## Explicit recurring deletion and concurrency acceptance

`delete_reminder` now requires an explicit `occurrence` or `all_future` scope for the
supported non-ended, childless timed interval-one weekly graph with one absolute-date pair.
Occurrence deletion advances the same active identity without history, retires only its
old pair and creates a fresh next-date pair. All-future deletion detaches and soft-deletes
the active root and its exact current Rule/pair, retaining backlinks and earlier history.
New scope-bound deletion intents preserve legacy completion formats and hashes. Complete
exact graph/List guards, bounded atomics, strict field/crypto/intrinsic receipts and detached
root rereads remain required; bulk jobs retain their ordinary childless-root restriction.

Built Worker acceptance advanced a fresh native 19 October 09:00 London sample to
26 October 09:00 across the clock change, then to 2 November under lost acknowledgement.
Its original arguments reconciled with the same identities and zero writes. Omitted scope
and changed-scope stale arguments were refused before dispatch. Lost all-future deletion
was exactly read back and reconciled with zero writes. Raw records confirmed only the
intended root/List fields and linked deletion markers changed; urgency asset encryption
metadata, pair backlinks, unrelated reminders and the fixed session expiry were preserved.
Native Reminders displayed the advanced dates and final removal. No history was created.

A separate native late-child attachment advanced the root and List tags. The retained old
three-record completion atomic was submitted once to real Apple and rejected with `CONFLICT`;
all participant tags and open states remained unchanged. Direct native subtask creation also
advanced the root/List tags. The first staged full-service race timed out safely before any
Apple write, so it is deadline evidence rather than a successful live commit-race test.
Subsequent normal built-MCP journeys verified committed independent API child attachment and
empty-list creation races: one stale atomic attempt returned `CONFLICT` in each case,
preserving every peer-result tag and open state, the live List and the fixed session expiry.
Both peer commits and exact verification finished inside the original read deadline. These
full-service API-actor checks were followed by passing native UI-actor journeys, with each
original stale atomic rejected once inside the unchanged HTTP deadline. See the detailed
native acceptance below in [the lifecycle protocol](lifecycle-protocol.md#full-service-native-ui-concurrency-acceptance).
See [the exact native concurrency limits](lifecycle-protocol.md).

TypeScript, lint (six existing warnings), all 185 unit tests, full Worker integration,
local access/transport, public configuration and build/artifact checks passed. Additional
mock deletion records initially exceeded a later shared fixture's discovery budget; isolating
only those temporary fixture records restored the full Worker pass without a runtime change
or increased production limit. Independent review found no issues. Native final-ended weekly
deletion has further captures, including asset reference rewrapping with identical file bytes;
that shape, other recurring patterns and the remaining capability inventory remain in progress.

## All-day daily deletion acceptance

The explicit deletion scopes now also support a childless open all-day interval-one
DAILY root at a midnight-UTC calendar label, with no stored zone, end/count/exception
condition or date pair. Occurrence deletion advances its same identity without a pair,
history or new record IDs. All-future deletion detaches the root and changes only
Deleted on its owned Rule, retaining its links. The List ordering token advances even
when established membership is absent; membership changes only to remove the active
member when present. A daily-specific three-record intent discriminator preserves
weekly intent serialization, fingerprints and legacy completion formats.

Native and built Worker journeys confirmed both scopes. The built Worker advanced
19 to 20 October, then advanced to 21 October under a deliberately lost acknowledgement.
Original arguments reconciled with zero writes. Changed-scope stale arguments conflicted
and omitted scope failed validation before dispatch. Lost all-future retirement reconciled
read-only against the exact detached root and Rule. Raw captures confirmed unchanged
completion fields, empty alarm relationships, strict asset/intrinsic metadata and all
unrelated participant versions and fields. Reminders displayed advancement and removal;
the Apple generation and fixed retention expiry were preserved. Independent review found
no issues. The existing Worker journey also checks absent-member ordering and refusal
of ended or zoned daily shapes, with isolated fixture cleanup. TypeScript, lint
(six existing warnings), all 185 unit tests, the full Worker suite, local access/
transport tests, public configuration, build/artifact verification and standalone
Cloudflare build/dry-run/queue/access checks passed.

Native deletion of a separate final-ended daily sample removed it immediately without
a scope menu and retired its Rule. Calendar interpretation and durable terminal deletion are implemented in the following
release, alongside continuing work on other recurring patterns and the remaining
capability inventory. The overall goal stays active.

## Ended all-day daily deletion acceptance

Deletion now accepts an inclusive end calendar date for the supported childless
all-day interval-one daily root without a stored zone or alarm pair. It uses the
existing explicit `recurrenceCalendarTimeZone` interpretation; omission accepts
only midnight-UTC end instants. Earlier occurrence deletion skips to the next daily
label within the end. Final occurrence deletion retires the same root and Rule
without advancing the date, preserving the original occurrence scope. All-future
deletion retires any valid active ended occurrence. Calendar arguments on other
delete recipes and active labels beyond the end are refused. New ended/terminal
intent fields bind exact scope/zone/outcomes and preserve previous serialized forms.

Native captures verified earlier skip, final retirement without a scope menu and
all-future retirement before the final date. The first built explicit-zone attempt
stopped before any POST on a local prepared/dispatched checkpoint field-order
mismatch, reproduced by the Worker test. The corrected construction retained the
same request, selected IDs/time and hashes; identical original arguments then
advanced to the final date with one POST. Final retirement deliberately lost its
acknowledgement and reconciled read-only with zero writes. Changed scope/zone stale
requests conflicted before dispatch; omitted-zone nonmidnight ends were refused.
Strict raw checks confirmed no history/pair/new IDs, preserved due/completion and
asset/intrinsic metadata, expected root/List/Rule changes and unchanged unrelated
records. Native Reminders displayed the advancement and removal. Session generation
and fixed expiry were preserved. Independent review and focused repair review were
clean; TypeScript, lint (six existing warnings), all 185 unit tests, the full
Worker suite, local access/transport, public configuration, artifact verification
and standalone Cloudflare build/dry-run/queue/access checks passed after repair.

Ended weekly shapes, other recurrence patterns, recurring families and the remaining
capability inventory continue under the active goal.

## Ended timed weekly deletion acceptance

The timed interval-one weekly graph with one exact absolute-date pair now supports
ended deletion. Final occurrence detection compares local due/end calendar labels in
the stored IANA zone, including native end clocks earlier than that day's due time.
Earlier occurrence deletion requires the exact next weekly instant within the stored
end. The native no-advance edge returns actionable `VALIDATION_ERROR` with zero writes;
the caller can explicitly request all-future retirement or review the end. All-future
retirement detaches the root and soft-marks only its current Rule/pair, preserving
links, dates, prior histories and unrelated metadata. No caller calendar zone is accepted
for weekly deletion. New five-record recipe/terminal intents retain exact scope and
legacy serialized shapes; retirement creates no new pair IDs or hard-retired IDs.

Native captures and error logs established each boundary, including a temporary local
hide with no saved change when a next clock fell after the end, successful explicit
all-future retirement, clock-change advancement and same-day end-before-clock retirement.
The built Worker independently reproduced all three successful shapes on fresh native
graphs. Lost terminal and all-future acknowledgements reconciled read-only with zero
redispatches. Changed-scope stale arguments conflicted, unsupported caller zones were
refused, and the no-advance error included the explicit retirement option. Raw captures
confirmed exact pair replacement/retirement, unchanged completion/due/end fields where
required, strict crypto/intrinsic metadata and unchanged unrelated record fields/versions.
The List ordering token advanced for absent established membership without reconstructing
missing siblings. Native Reminders showed advancement/removal and the retained session
was preserved. Independent review was clean. TypeScript, lint (six existing warnings),
all 185 unit tests, full Worker integration, local access/transport, public configuration,
build/artifact checks and standalone Cloudflare build/dry-run/queue/access tests passed.

Private Site version 40 previously verified hosted midnight-UTC daily advancement,
terminal retirement and all-future retirement, including unchanged-tag original replays.
Private Site version 41 verified the previously retained nonmidnight daily witness with
an explicit London calendar zone through the installed Delete tool. The refreshed field
reached the server; final occurrence retirement and original-argument replay preserved
the result tag. Raw comparisons confirmed only the intended root, rule and List changes.
Three fresh native weekly graphs then verified hosted clock-change advancement, final
calendar-day retirement, the unchanged actionable no-advance refusal and explicit
all-future retirement. Every original successful request replayed read-only with its
unchanged result tag. Exact raw reads verified old-pair removal, current-pair/rule soft
retirement, preserved crypto/backlinks, unchanged histories and unrelated fields/versions.
The native app displayed advancement and an empty disposable list after retirement.
Generation 9 and the original fixed session expiry were retained. Other recurring
patterns, families and the remaining capability inventory remain separate backlog work.

## Remaining implementation order

1. **Extend read completeness.** Search includes native tag/URL filters and Shopping
   category reads include materialised empty sections. Add broader section
   metadata after bounded hydration designs. Keep progress and
   completed-history scope explicit; avoid a cached catalogue of reminder bodies.
2. **Extend organization fidelity.** Ordinary URL/tag and move/copy recipes are implemented.
   Investigate global tag rename, scheduled transfers, assets and whole families separately.
   Preserve exact-version checks and read-only lost-acknowledgement reconciliation.
3. **Lists, sections and ordering.** Build on the existing list CRUD, appearance and
   Shopping category reads/manual moves. Investigate groups, category management and
   section-order writes, then read-only Smart List definitions. Investigate native Smart List
   writes and templates after their identity/relationship formats are established.
4. **Remaining schedules and lifecycle.** Investigate recurrence anchors/exceptions, multiple
   alerts, urgency data and parent/child lifecycle transitions. Keep device notification
   delivery acceptance separate from stored protocol parity. None of these gaps is a reason
   to discard the already verified #21 recipes.
5. **Collaboration and assets.** Use independent shared-zone/participant and attachment
   designs, with explicit test identities/files. Permission and revocation evidence precede
   invitations, assignments or uploads. Device-only actions stay with the native client.

For each follow-up, the release check is a supported recipe with typed tools, synthetic
behavioural coverage, native reverse edits and visible sync, conflict/no-replay checks, and
preservation of unrelated data and the existing session. Run the repository's required
checks for runtime changes. A visible menu or accepted HTTP response alone is insufficient.
Unverified protocol candidates remain labelled as such until the missing evidence is gathered.

## Documentation sources and limits

The live Mac observations above are the primary evidence for the installed app. Apple guides
add platform context; they do not certify the connector's private protocol.

- [Reminders User Guide for Mac](https://support.apple.com/guide/reminders/welcome/mac): native feature families and account/version scope.
- [Custom Smart Lists](https://support.apple.com/guide/reminders/create-custom-smart-lists-remnfec66479/mac): all/any filters and conversion side effects. Conversion can move reminders and flatten subtasks, so it needs its own acceptance.
- [Sections](https://support.apple.com/guide/reminders/manage-sections-in-reminder-lists-remn14bf0e77/mac): sections, ordering and column presentation.
- [Tags](https://support.apple.com/guide/reminders/tag-reminders-remn45640f4f/mac): native tag organisation and filtering.
- [Templates](https://support.apple.com/guide/reminders/use-reminder-list-templates-remn29caf6e1/mac): native template lifecycle.
- [iPhone/iPad Reminders](https://support.apple.com/en-gb/102484): urgency, messaging, attachments, Calendar integration and recently deleted recovery. Apple describes a 30-day reminder recovery window and device-specific urgency delivery. These were not exercised on an iPhone here.
- [Grocery lists](https://support.apple.com/en-gb/105086): grocery category behaviour on supported iOS versions.

The audit is bounded to the installed Mac app and these documented feature families. New OS
features, regional differences, other account providers and unobserved storage variants need
fresh evidence. The mapping milestone is complete and the first search/organization bundle is implemented.
The remaining inventory is a separate backlog; the bounded recipes do not establish full parity.

## Last-day monthly deletion implementation

The observed no-end interval-one monthly rule supports explicit occurrence/all-future
deletion on an open childless all-day midnight-UTC root without a stored zone or alarms.
The exact month-day/set-position pattern and an actual month-end due date are required.
Occurrence deletion advances the same ID to the next month end without history, new
records or pairs. All-future deletion detaches the root, soft-retires only its current
Rule and advances List ordering even for absent established membership. Three-role,
replicas-only intents retain immutable recipe/scope and strict read-only reconciliation.
Legacy serialized shapes remain unchanged. Monthly ends, other patterns, alarms, caller
calendar zones and families require separate native evidence.

Native and built real-Apple journeys verified 31 October to 30 November advancement,
all-future retirement, lost replies and zero-write original replays. Missing scope,
changed-scope replay and caller calendar zones were refused before dispatch. Raw
comparisons preserved dates, completion fields, backlinks, crypto, prior histories
and unrelated fields/versions. The app displayed advancement and removal; the retained
session stayed unchanged. Synthetic behavioral coverage includes leap-year, year and
month boundaries and rejects an invalid anchor for either scope. Independent review
found no issues. Further recurring lifecycle and the remaining capability inventory
continue under the active goal.

## Tag and URL search acceptance

Four fresh synthetic samples were displayed in native Reminders: a two-tag URL item,
a one-tag second URL item, an untagged item with lookalike strings only in notes, and
a tagged URL item completed in the app. A generated JPEG pasted with its reminder row
selected became a native `Image`/`public.png` attachment without a URL field. The same
exact attachment version retained every checksum, encryption field and relationship
while only its signed FileAsset download URL refreshed; private comparisons normalize
that observed path only. Search neither downloads nor persists the image.

The built Worker verified all/any tags, tagged/untagged and native URL presence/absence,
case-insensitive URL text, completed scope and combined filters against real Apple
records. Notes-only text and the native image did not satisfy URL filters. Zero-match
pages retained honest continuation; changed tag or URL options conflicted before
Apple reads, while original filters completed the same cursor. A native URL reverse
edit appeared immediately in search and its old URL stopped matching. Both full live
read suites made zero mutations; exact raw comparisons preserved reminders, metadata,
histories and unrelated versions. Session generation and fixed expiry were unchanged.

Independent review identified an ambiguous-attachment negative classification and
confirmed its focused repair. Existing persistence and MCP journeys verify that such
errors retain the continuation and the identical token succeeds after metadata repair,
along with foreign/deleted/dangling links, selected-only hydration and lookup budgets.
The full 185-test suite, typecheck, lint (five existing warnings), Sites build, full Worker,
local access/transport, public configuration and artifact verification passed.
The remaining organization, transfer, lifecycle and capability inventory stays under
the active goal.

## Search projection and advertised parameter verification

Search now requests only the seventeen fields used by the normalized reminder result,
scalar matching and organization relationships. Created/modified timestamps remain native
record-header metadata. Ordinary reads, family inspection and write/guard snapshots keep
their full fields. This reduces dense history payloads without raising the Apple transport
budget or dropping opaque fields from mutation preparation.

The MCP input schema exposes the plain search object and its parameter descriptions;
cross-field validation still runs in the service. The Worker journey verifies the actual
`tools/list` schema as well as valid filtering and contradictory-input refusal. Client
and persistence tests verify normalized output/audit dates, complete default records,
search-only projection and unchanged continuation semantics.

A direct read-only native projection comparison preserved every normalized field for four
synthetic reminders while reducing their raw payload from 28,649 to 16,004 bytes. The settled
built Worker then passed all thirteen existing real-Apple search scenarios, including tag
all/any, native URL presence/absence/text, completed scope, native reverse URL edits and
zero-match/filter-bound continuations. It made zero mutations and retained the session
generation and fixed deadline. The 186-test suite and required lint/type/build/Worker/local/
artifact/Cloudflare checks passed; CI-pinned Gitleaks 8.30.1 found no Git-history leaks.
Private Site version 44 deployed the exact archive-backed source and passed scoped tag/URL
search through the installed tool. A continuous all-private-list search with completed
history then finished all 95 pages across its 15 selected lists, returning exactly the two
expected synthetic tag matches without record errors. Dense compound responses can still
exceed the transport budget at limit 200; the successful full scan used limit 50 as documented.
An interleaved earlier scan expired honestly at the fixed ten-minute search deadline and
was restarted, rather than being presented as complete. Exact final reads preserved all
44 synthetic current/historical records' fields, versions and intrinsic parents, plus the
four previously retired identities. The Apple session generation and fixed expiry stayed
unchanged. All four [CI jobs passed for 2fa8fcd](https://github.com/Xzese/icloud-reminders-mcp-for-cloudflare-workers/actions/runs/38262847105).

## Shopping category protocol and acceptance

The scoped delivery adds `get_shopping_categories` and `set_reminder_category` for existing
owned private Shopping lists. Category management and list conversion remain separate work.
The native app created a disposable Shopping list and classified Milk as Dairy, Eggs & Cheese,
Carrots as Fruit & Veg and Paper towels as Household Essentials. Native manual moves were
captured, including an empty custom section; Milk was returned to Dairy.

A separate live creation comparison on 12 October 2026 used a new disposable native
Shopping list. The installed MCP `create_reminder` successfully created Milk, but it stayed
in Others without a category membership. Native-created Carrots was classified as Fruit &
Veg, and a second Milk created natively was classified as Dairy, Eggs & Cheese. Exact API
reads confirmed the MCP Milk identity/tag stayed unchanged while the membership asset
contained only the two native-created identities. Automatic classification of connector
creation is therefore outside the implemented read/manual-move behavior. The comparison
List and all three samples were removed through native recoverable deletion; exact List
readback confirmed retirement, with the session generation and fixed expiry preserved.

Categories are `ListSection` records with a List backlink and intrinsic List parent. Generic
filtered/unfiltered queries are not indexed. Apple's documented `changes/zone` feed works
with `desiredRecordTypes: ["ListSection"]` and a metadata-only field projection. Reverse
pagination found all four materialised fixture categories on its first page, including the
empty custom category. Other lists' category records were discarded. The feed can return
empty pages with more changes pending; a first-page match is not proof of complete catalogue
enumeration. The MCP read preserves that distinction and returns a single-use scoped cursor.

The List stores category memberships in `MembershipsOfRemindersInSectionsAsData`, learned
title choices in `GroceryLocalCorrectionsAsData`, and optional explicit ordering in
`SectionIDsOrderingAsData`. Assets are bounded native JSON. Memberships associate reminder
UUIDs with category UUIDs and Apple-reference modification times. Manual moves also append
the item in `ReminderIDs` and update the lowercase-title learning correction. The root
changes only its modification time and resolution token.

The native checksum path was verified through pure, constructed ReminderKit values, without
reading its store. SHA-512 uses the native checksum base rather than raw asset JSON: ordered
membership description strings, dates floored to UTC seconds from Apple's 2001 reference
epoch, and the observed null-reset optional-value framing for title corrections. Portable
Worker output matched independent native captures and input-order permutation probes.
Both checksum fields retain Apple's encrypted wrappers. Non-null reset dates and non-ASCII
learning keys remain outside this write recipe.

Asset upload tokens and raw-data staging follow Apple's documented upload flow. Downloads
and uploads pin the observed Apple hosts and bounded paths, omit cookies/authorization,
disable redirects and enforce independent byte/time budgets. The final request updates the
exact reminder and List and version-guards the existing destination section. Confirmation
checks versions, unchanged fields, intrinsic ownership, immutable asset metadata, decoded
content and checksums. Apple's write receipts can omit top-level zones; only that omission
is bound to the already authenticated private zone, while explicit foreign zones are rejected.

The built normal MCP reader returned four categories and three memberships, including the
empty section. A deliberately stale List tag returned `CONFLICT` before any asset staging or
record write. Independent MCP moves to the custom category and back to Household each made
one confirmed atomic request and preserved the session generation and fixed expiry. One
earlier saved move produced false uncertainty from the omitted-zone receipt check; exact
readback established its outcome before the check was repaired and further independent
requests were made. The original request was not replayed.

The 191-test suite, lint, typecheck, local/Worker integration journeys, public-source checks,
normal Sites build, standalone Cloudflare build and artifact verification passed. Regression
coverage includes checksum/asset bounds, native encrypted wrappers, stale-tag refusal,
unchanged-field verification and successful receipts that omit their top-level zone. The
Worker checks also verify both tools and all seven advertised category-move inputs.

The Shopping implementation is committed as `69ddeea` and all four
[CI jobs passed](https://github.com/Xzese/icloud-reminders-mcp-for-cloudflare-workers/actions/runs/38280442389).
CI-pinned Gitleaks 8.30.1 found no leaks across the full Git history. Exact archive-backed
private Site version 45 deployed successfully with the existing audience and runtime
environment revision retained. The installed connection reports both Shopping capabilities
and all 35 tools. After client metadata refresh, hosted tool reads returned the empty custom
category and all three memberships. Hosted moves to the custom category and back to
Household were confirmed by normal receipts and immediately appeared in Reminders. Milk
remained under Dairy, Eggs & Cheese. Its Apple generation and fixed expiry are unchanged.

Native screen checks, CloudKit receipts, exact readback and asset verification passed.
The scoped Shopping/search/concurrency fixtures were removed by native recoverable List
deletion, and exact API reads confirmed all five retired Lists. Recently Deleted was not
purged. The remaining inventory is separate backlog, not pending scoped acceptance.
See [the tool contracts](mcp-api.md#shopping-categories), Apple's
[section-management guide](https://support.apple.com/en-gb/guide/reminders/remn14bf0e77/mac),
[category-only change-feed reference](https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/FetchingRecordZoneChanges(changeszone).html)
and [asset-upload reference](https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/UploadAssets.html).

## Apple classifier investigation

The owner requires this feature to remain Cloudflare-only and to use Apple's classifier.
No working remote categorisation request has been identified; this is an investigated gap,
not a claim that every undocumented Apple endpoint has been ruled out.

A fresh native Shopping fixture contained one MCP-created Milk identity. Exact-version
CloudKit writes appended that identity to native `ReminderIDs` ordering, then changed
`ShouldCategorizeGroceryItems` from 1 to 0 and back to 1 with its encrypted wrapper and
resolution token preserved. All three writes committed, and the native toolbar reflected
both setting changes, but the item remained uncategorised with no membership asset. These
were diagnostic writes only; no category was selected or written by the connector.

A committed native title edit of that same identity to Whole milk caused Apple to create
Dairy, Eggs & Cheese and assign the item. A subsequent normal MCP title edit to Carrots
preserved its Dairy membership instead of reclassifying it as Produce. Restoring Milk
through MCP also preserved membership. Earlier native edit attempts, including identical
text, were dismissed with Escape and did not commit; they are not classifier evidence.
The final fixture was removed by native recoverable List deletion;
exact API readback confirmed retirement, and the installed session generation/expiry stayed
unchanged. A separate create-then-assign witness was refused before writing because the
created identity was absent from explicit native List ordering.

Read-only runtime metadata exposes `autoCategorizeRemindersWithReminderIDs:` and
`unsavedReminderIDsForCategorization` on the native grocery change-item/storage types.
A pure constructed `REMListStorage` archived synthetic request IDs under that latter key,
without opening `REMStore` or a persistent store. The installed current Core Data model
does not contain that attribute on its List or Reminder entity; it contains a generic local
operation queue with configuration, operation type and completion fields. This supports a
native transaction/queue interpretation; it does not prove a universal absence of remote
request machinery. Persistent List flags, locale and ordering are not themselves evidence
that a per-item categorisation request syncs.

Anonymous inspection of Apple's public
[Reminders web bundle](https://www.icloud.com/applications/reminders2/2636Build17/en-us/main.js)
found no grocery classifier request or category-management path. Its asset download routine
explicitly skips Shopping memberships, grocery corrections and section ordering. This
inspection found no separate asynchronous application script-chunk loader. The observed
native categorisation step cannot currently be offered as a verified Cloudflare-only operation. No Mac
helper or replacement classifier was introduced.

## List-read client metadata correction

The refreshed hosted connector rejected a valid `get_reminders` List ID before contacting
the server: its generated prefix-only schema pattern was treated as a full match by the
client adapter. The advertised input now shares the server's complete bounded List-ID
schema. Backend authorization and read behavior are unchanged. The existing Worker journey
checks the actual `tools/list` pattern against a canonical UUID ID and malformed path/space
IDs. All 191 tests and the required lint/type/local/Worker/build/artifact/public-source
checks pass for this correction.

Private Site version 46 deployed the correction with its existing private audience and
runtime environment retained. After the owner refreshed the connection, a fresh tool
context accepted the canonical List ID and returned zero reminders with `complete=true`,
`paginationComplete=true`, no continuation, no pending reason and no record errors. The
older running context still retained its previous input schema; the successful fresh
context confirms the refresh reached the installed connection. The additional empty
metadata fixture was then soft-deleted through the normal guarded MCP tool. Exact readback
confirmed its retired state, and it disappeared from the native Reminders sidebar. All six
scoped/metadata fixture Lists are retired; Recently Deleted was not purged. Generation 9
and the fixed session expiry were preserved. All four CI jobs passed for the code correction
in [c87ccc6](https://github.com/Xzese/icloud-reminders-mcp-for-cloudflare-workers/actions/runs/38290247119).


## Concurrency query-lag repair

The family/List concurrency work now also covers a membership commit before the first
versioned read while Apple's query index still omits the child or its current parent.
Discovery resolves native List ordering and queried identities exactly before planning.
Ordinary/subtask creation atomically appends its stable identity to ordering, and parent
changes guard the full List as well as affected roots. Existing stale-version fences remain.
The 188-test suite and built production API journeys pass; live creations/replays, native
attachment with a withheld query, full-family completion/reopening and a post-inspection
native `CONFLICT` passed in [the lifecycle acceptance](lifecycle-protocol.md#query-lag-repair-acceptance).

The earlier creation-ordering prerequisite for manual Shopping assignment is now established
by the atomic creation recipe. This does not add automatic Apple classification; the classifier
investigation and broader capability boundaries above remain separate.


Hosted version 48 verified the normal creation/subtask/replay and family lifecycle tools with
the same private audience and session. Final cleanup removed all ten remaining disposable
appearance/lifecycle Lists and 31 synthetic reminders from this work, including older completed
histories. Exact API retirement reads, the refreshed catalogue and native sidebar confirmed
cleanup. The existing Test list had no MCP-prefixed samples; unrelated Lists remained and
Recently Deleted was not purged.
