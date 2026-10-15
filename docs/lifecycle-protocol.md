# Native reminder lifecycle observations

Observed on 11–12 October 2026 using a fresh disposable private list in the live Mac
Reminders app. The observations below use synthetic reminders. Raw records, signed
asset URLs, account identifiers and encryption metadata remain in ignored private
captures. This evidence does not establish notification delivery.

## Ordinary parent and child completion

Native Indent attached an existing reminder to a root through `ParentReminder`.
The child, parent and List versions advanced. The parent changed
`LastModifiedDate` and its resolution token without acquiring a child-ID array.
The List changed `ReminderIDs` and `reminderIDsMergeableOrdering`.

Completing a parent completed its open children. The parent and those children
stored the same millisecond `CompletionDate`; their `completed`, `completionDate`
and `lastModifiedDate` resolution tokens advanced. A child already completed
independently retained its prior completion timestamp and version. The List
version did not change during completion.

Reopening a parent reopened children completed in that parent cascade, while
retaining independently completed children. This was observed both with a single
child and a mixed two-child family. The cascaded child's previous
`CompletionDate` equalled the parent's previous date; the retained child's date
was earlier. The connector's bounded recipe uses that exact equality, rather
than reopening every completed descendant.

Completing all children individually left the parent open. Reopening one child
while the parent was completed left the parent completed. Independent child
completion/reopening preserved its parent reference and changed only that child.

## Membership and concurrent changes

Two native root creations advanced the List's version. Both observed native
child attachments advanced the parent's and List's versions. A native child
deletion also advanced both. These observations support exact-version guards for
these recipes; they do not prove that every possible native membership event
advances an existing participant.

The connector previously created ordinary reminders without changing or guarding
the List, so its own create could race a verified-empty List deletion. Ordinary
creation now includes the exact List in its atomic group. Family completion and
reopening guard the known family and List together. Existing subtask creation and
reparenting protect their parent records, allowing the connector's own family
changes to conflict at commit time rather than relying only on a preflight scan.

The family must be discovered completely within the inspection budget and fit
one atomic group. Unchanged children are guarded as well as children being
changed: an independently completed child must not silently change during a
parent reopening. A child operation guards its root and siblings while changing
only the selected child. Recurring, early/location-alarmed and deeper families still need their
separate lifecycle recipes. One absolute-date pair per ordinary member now has the
composite recipe described below.

## Committed membership hidden by query lag

Exact current versions alone do not establish that an indexed query is complete. A child
can commit before the initial parent/List lookup while the compound query still omits it
or carries its previous parent reference. Those new guard versions would permit an
incomplete family mutation. A regression reproduced this sequence before the repair.

Mutation inspection now unions the completely paginated query identities with the exact
List snapshot's native `ReminderIDs`, then resolves every identity through bounded exact
lookups. Parent references come from those exact records. Both the selected family and
childless transfer/category/bulk-delete checks use this discovery. Explicit ordering can
retain retired identities: a definite exact `NOT_FOUND` or deleted record is ignored;
omitted responses, foreign/moved live members, unknown relationship fields, duplicate
inventory and budget overruns refuse dispatch. At most 1,000 identities are inspected in
200-ID batches with a 256 KiB exact-record budget, in addition to the existing query budget.
The final family still fits one 32-record/64-KiB atomic group under the original List version.

Ordinary and subtask creation now append the stable identity to native List ordering and
advance only its ordering token in the same atomic group as creation. The exact-version
List update precedes creation, including for a pristine List; subtask creation also guards
its root. Existing membership representations and unrelated fields remain intact. Matching
stable-key reconciliation remains read-only. Parent changes also guard the full exact List.
These writes give newly created connector identities an exact discovery path before the
query index catches up. No Queue or background runner is introduced.

## Native late-child conflict acceptance

A fresh ordinary two-member family was inspected by the built Worker. Its prepared
atomic completion contained exactly that parent, the known child and the List;
a separate root was absent from the family operations. Native Indent then attached
that root as a new child. Exact captures confirmed that the parent and List tags
advanced, while the existing child's tag and completion state were unchanged.

The staged network request reached its normal timeout before forwarding, so the
first probe made zero Apple writes. This is safe deadline evidence, not a successful
live commit-race test. A separate controlled transport probe submitted exactly the
retained three-operation request once, preserving its original stale tags and normal
HTTP timeout. Real Apple returned an atomic `CONFLICT`; exact rereads showed every
participant tag unchanged and all three reminders still open. No tag was refreshed
and no completion was replayed.

Direct native creation at the subtask level was captured separately, without first
creating a root and indenting it. That event also advanced the parent and List tags,
changed the parent's modification fields and the List's membership/order fields,
and preserved the existing children. The current atomic guards therefore cover both
observed native ways to introduce a child after discovery. This evidence is bounded
to these native events and the connector's guarded membership recipes; it does not
establish a server predicate lock over arbitrary unseen record creation.

## Full-service API concurrency acceptance

On 12 October 2026, two further real-Apple journeys exercised the normal built MCP
service with an independent guarded API actor. This removes the manual UI timing
dependency while retaining the original eight-second read deadline; it is separate
from the native-app observations above.

For parent completion, the final exact read of the two-member family was held after
Apple returned it. The peer attached the separate late child and atomically guarded
the parent and List. Fresh exact reads established the attachment and advanced guard
versions before the original old response was released. Normal MCP then dispatched
its original three-record completion once. Apple returned `CONFLICT`; all three
reminders remained open and every peer-result version stayed unchanged.

For empty-list deletion, the normal MCP completed its empty-content scan. Its final
List lookup response was held while the peer created one ordinary reminder with an
exact List guard. The fresh item and advanced List tag were verified before releasing
the original response. MCP dispatched the retained deletion once and received
`CONFLICT`. The List remained live, the new item remained open, and both peer-result
versions were unchanged. Peer commits and verification took under one second in each
held read. Neither service changed its session generation or fixed expiry.

These are full-service commit-race checks for the connector's guarded recipes. They
do not establish protection for an arbitrary native event that leaves every known
participant's version unchanged. The earlier native captures and stale atomic
rejection remain independent evidence.

## Full-service native UI concurrency acceptance

Both equivalent normal-MCP journeys subsequently passed with Reminders itself making
the competing edits. Native Indent attached the late child after the exact two-member
family response was captured. Exact lookups established the new parent relationship
and advanced parent/List tags before the retained three-record completion dispatched
once. Apple returned `CONFLICT`; all three reminders remained open.

On a pristine disposable List, the complete empty-content scan and final List response
were captured before native creation committed. The List's new membership UUID and
exact reminder read established the expected open item and advanced List version.
The retained deletion dispatched once and returned `CONFLICT`, preserving the live
List, new item and both versions. Reminders visibly showed the surviving item.

The successful held-read checks took 4,778 ms for the family and 5,590 ms for the
List, within the existing 6,500 ms test hold and original eight-second HTTP deadline.
Earlier manual tool handoffs exceeded that deadline and made zero writes. Scheduling
the MCP start and prepared native command before invocation removed the handoff delay;
no production timeout was increased. List queries also lagged direct native membership
lookups. Reused native ordering could retain retired UUIDs, so the final creation test
used a pristine List and exact-ID confirmation rather than treating ordering entries
as proof of live reminders.

Both journeys preserved the session generation and fixed expiry. The five scoped
Shopping/search/concurrency Lists and their samples were removed through native
recoverable deletion afterward; exact API reads confirmed their retirement. Recently
Deleted was not purged. These checks cover the observed guarded native events, not a
universal predicate lock over arbitrary unseen membership changes.

## Native soft deletion

Deleting one ordinary child moved it to Recently Deleted. Its `Deleted` marker
became one, its List and parent references were removed, and its List membership
was removed. The parent advanced `LastModifiedDate`. Its sibling was unchanged.

Deleting the parent displayed a confirmation explicitly including completed
subtasks, then soft-deleted both the root and its remaining completed child. The
root lost its List reference and was removed from `ReminderIDs`. The cascaded
child retained its List/parent references and membership, while changing its
`Deleted` marker. Its completion timestamp and resolution tokens were retained.
This differs from directly deleting that child. Recently Deleted was not purged.

The ordinary deletion implementation follows these distinct recipes with the
complete family and List guarded atomically. Exact reads return `listId: null`
for the selected detached deleted record. A deletion marker does not establish
a native restore recipe.

The connector's first native direct-child deletion committed once and removed
the child from the app. Apple's modify receipt still carried the old intrinsic
parent, while exact readback at the same version had identical fields and no
intrinsic parent. The request was reported uncertain rather than replayed.
Apple also materialized previously absent empty alarm, tag, recurrence,
assignment and attachment collections. Deletion confirmation therefore needs
a bounded exact read at the confirmed version, strict preservation of its
fields, and absent/empty equivalence only for validated known relationships.
An empty relationship becoming populated is rejected even when the receipt and
exact read agree.

A fresh connector-created child exposed a distinct request representation:
`parent: null` left its intrinsic parent present in both receipt and exact read.
After read-only reconciliation, one exact-version probe using
`parent: { recordName: null }` removed that reference and preserved all fields.
The deletion transport uses this dictionary and still requires exact readback.
Apple's [record dictionary reference](https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/Types.html)
describes `parent` as a dictionary; the removal behavior here comes from the
synthetic live probe rather than an undocumented assumption.

## Recurring completion and history

A timed weekly root initially had a RecurrenceRule and no date alarm. Completing
it kept the original Reminder identity open and advanced its due date by one
calendar week. The same RecurrenceRule identity, version and fields were retained.
A fresh Reminder identity represented the completed occurrence at the old due
date, with a completion timestamp and no RecurrenceRule link.

The next completion crossed the Europe/London clock change. The active due date
advanced from 19 October at `08:00Z` to 26 October at `09:00Z`, preserving 09:00
local time. Adding a fixed number of UTC hours would not reproduce this behavior.

An all-day monthly sample advanced from 31 January to 28 February and then back
to 31 March 2027, with a fresh completed history for each old date. Its native
RecurrenceRule represented the last day through `DaysOfTheMonth=[28,29,30,31]`
and `SetPositions=[-1]`, both base64 JSON byte fields. This is an observed native
pattern, not evidence that every monthly rule carries a hidden anchor. The
ordinary recurrence-edit reader does not support `SetPositions`; completion has
a separate reader for this observed pattern.

Reopening the completed history made that history record an independent open
reminder at its old due date. The active recurring root and its next date remained
unchanged; reopening history did not rewind recurrence.

Restoring time through the native editor created a date Alarm and AlarmTrigger.
Completing that alarmed weekly occurrence retained the original active Reminder
and RecurrenceRule, but created fresh Alarm/AlarmTrigger identities for both the
next active occurrence and the completed history. The old Alarm and AlarmTrigger
returned `NOT_FOUND` on exact read. History retained its own old-date alarm graph
and had no recurrence link. This is a graph transition, not a `Completed=1`
update of the active recurring root.

Reopening the alarmed history retained that history's Alarm/AlarmTrigger
identities, versions and fields. Directly soft-deleting it set `Deleted=1` on its
Reminder, Alarm and AlarmTrigger, retaining the related-record backlinks. The
active recurrence and its own alarm graph were unchanged.

Native deletion of the active recurrence offered two choices. **Delete This
Reminder Only** advanced the same active Reminder to the next weekly due date,
kept the RecurrenceRule unchanged, retired the old Alarm/AlarmTrigger with
`NOT_FOUND` results, and created a fresh next-date alarm graph. It did not create
a completed history record. **Delete All Future Reminders** then soft-deleted
the active Reminder and set `Deleted=1` on its current RecurrenceRule, Alarm and
AlarmTrigger, retaining their backlinks. Earlier history records were unchanged.
These distinct actions require an explicit recurring deletion scope.

An all-day daily sample advanced from 20 to 21 and then 22 October 2026, retaining
the active identity and creating an independent completed history each time. Its
native frequency was daily with interval one. Editing its repeat end date in the
native Details panel replaced the RecurrenceRule identity. The end date was
inclusive: with an end date of 22 October, completing the 21 October occurrence
advanced to 22 October; completing that final occurrence marked the original
active Reminder completed without creating history or advancing its due date.
The final completion retained the RecurrenceRule identity, version, fields and
link, and the List version. Only the Reminder's completion/date/last-modified
fields and resolution tokens changed, apart from a refreshed signed asset URL.
Reopening that final completed occurrence retained its due date and recurrence
rule, cleared completion, and changed its last-modified fields and tokens. It
created no new occurrence or history.

A second daily end was created through the native End Repeat menu rather than
from an API midnight instant. Details displayed 25 October, while the rule stored
`2026-10-24T23:51:29Z`; the all-day Reminder still had no stored time zone.
Native completion advanced 24 October to 25 October and then completed the same
active 25 October record without history. The final Rule and List tags were
unchanged. Comparing the end instant directly with midnight UTC due dates would
end this sample early. This native form needs explicit calendar-zone handling;
the connector now supports it through an explicit `recurrenceCalendarTimeZone` on complete/reopen, retaining the midnight-UTC recipe when omitted.

Native reopening and soft deletion were also exercised on connector-created
weekly history. Reopening retained the exact Alarm/AlarmTrigger identities,
versions and fields; native collection wrapper representations became known
empty collections. Direct deletion detached the Reminder from its List and
intrinsic parent, changed its deletion/modification fields and tokens, and set
only `Deleted=1` on the Alarm and AlarmTrigger while retaining their backlinks.
The active weekly series stayed unchanged. The reminder remains recoverable;
Recently Deleted was not purged.

Root-only interval-one weekly, all-day daily and last-day monthly completion now
have guarded connector recipes and live acceptance in [the parity register](native-reminders-parity.md).
They retain durable occurrence identities and reconcile uncertain acknowledgements
through exact reads. Standalone roots with one absolute-date pair now have a guarded complete/reopen/delete recipe. Live Worker deletion changed only `Deleted` on the pair, preserving its native backlinks and intrinsic parents; the root was detached and exactly reread. Lost completion acknowledgement followed by original stale arguments caused zero redispatches. Recurring deletion and other alarm/lifecycle variants remain outstanding.
The midnight UTC daily final-date transition and reopening are implemented.
Explicit calendar-zone daily endings are implemented and verified through the native display, advancement/final/reopen transitions and original-request read-only reconciliation. Occurrence-count endings, exceptions and other variants remain separate work.

## Same-version signed asset URLs

Repeated exact reads preserved record versions, asset checksums, sizes and
encryption metadata, while changing `downloadURL` inside the native
`UrgentPresentationAlarmsAsData` and List
`MembershipsOfRemindersInSectionsAsData` ASSETID fields. Guard comparisons exclude
only those observed URL properties and preserve all other fields and metadata.
The same URL refresh also occurred between a verified recurrence end-date update
and its receipt. Update verification must apply this exact normalization while
still comparing checksums, sizes and encryption metadata.
The List membership asset appeared during native recurring-history creation;
its presence alone does not establish a section-editing recipe.

## Timed weekly end and scheduled-family follow-up

The native timed weekly sample advanced its 2 November occurrence to the
9 November end, producing separate completed history and two new date pairs.
Final completion and reopening changed the active reminder in place and retained
the exact Rule, List and date-pair versions and semantic fields. The connector's
same-clock, cadence-aligned interval-one weekly terminal recipe now matches
that behavior, including original-request read-only reconciliation.

A new native scheduled family established the ordinary selective timestamp
recipe with date alarms on both the root and one child. Completion/reopening
retained both pairs and the List versions. Native root deletion detached only
the selected root; soft-deleted children kept their relationships. All four
scheduling records changed only `Deleted=1`, retaining backlinks and intrinsic
parents. Only the root's List membership was removed; cascaded children retained membership.

A second native family established direct dated-child completion/reopening and deletion.
Child completion/reopening preserved its parent and all pair fields/versions, even when
reopening under a completed parent. Direct deletion removed that child's List/ParentReminder
and intrinsic parent, retired only its own pair with `Deleted=1`, and advanced only the root's
modification fields/tokens. Sibling and root pairs retained their fields and intrinsic parents.

The connector now composes this recipe over the exact original family snapshots and all
member pairs, including undated members, in one bounded atomic group. It does not remove parent
references temporarily to reuse a root-only planner. Built Worker acceptance reproduced the
native cascade, selective reopening, independent child actions and both deletion scopes.
Lost acknowledgements confirmed by exact reads; original stale arguments conflicted with zero
redispatches. Strict full-field/asset/intrinsic receipts and detached-target rereads are required.
Guard markers advance API versions without changing pair semantics. These known-participant
guards do not prove a universal native phantom-child exclusion.

A further native timed weekly sample had its end set through On Date to the same
local day as its active due date. Deleting that final sample presented no scope
menu: the root detached and soft-deleted, and its current Rule/Alarm/Trigger changed
only `Deleted=1`; no history or successor was created. The root's urgency asset
kept the same file checksum and size, and bounded downloads confirmed identical
159-byte file content. Its wrapping key and reference checksum changed across
intrinsic-parent detachment, alongside the signed URL. This is evidence of reference
metadata rotation, not permission to ignore encryption metadata in strict receipts.
Ended weekly deletion and that reference-verification recipe remain under investigation.

A fresh native all-day interval-one daily sample had no stored time zone and no
Alarm/AlarmTrigger. Delete This Reminder Only advanced its same active ID from
19 to 20 October as midnight-UTC calendar labels. Only DueDate, LastModifiedDate
and their resolution tokens changed; Rule/List tags and fields, completion fields
and empty alarm relationships stayed unchanged. No pair, history or new ID was created.
Delete All Future Reminders then detached and soft-deleted the root and set only
Deleted on its Rule, retaining its backlink and intrinsic parent. Its empty List
membership stayed unchanged, but the reminderIDsMergeableOrdering token advanced
from counter one to two. This establishes a distinct three-participant deletion
recipe. The built Worker reproduced same-ID advancement from 19 to 20 October,
then a lost-acknowledgement advance to 21 October. Original arguments reconciled
with zero writes; changed scope conflicted and omitted scope failed validation
before dispatch. Lost all-future retirement detached the root and changed only
Deleted on its Rule; original arguments again reconciled read-only. The established
active List member was removed and its ordering token advanced. No pair, history
or new record IDs were created, all unrelated versions and fields stayed unchanged,
and Reminders displayed the date advancement and final empty List. Strict asset
and intrinsic metadata verification and the retained session expiry were preserved.

A separate native all-day daily sample ended on its current calendar day. Delete
removed it immediately without a scope menu. The root detached from its List and
intrinsic parent and changed only List, Deleted, LastModifiedDate and their
resolution tokens. Its Rule changed only Deleted and retained its native links.
The List initially had an empty membership despite two query-visible active
roots; native deletion rebuilt it to contain the other active root and advanced
its ordering token. All unrelated records retained their exact versions and
fields. This confirms the
terminal retirement shape. Calendar interpretation and durable ended daily
occurrence intents are implemented and live verified below.

First creation into a pristine connector-created List failed when its exact
version guard followed the Reminder create. The same guard preceding creation
succeeded without changing any creation field, membership field or native parent.
Initial List chain metadata appeared with the first intrinsic child; its implicit
initialization is the inferred collision cause. The runtime preserves logical
receipt ordering while dispatching the exact parent List guard first. Full List
snapshots are required for subtask guard receipt validation; projected summary
fields are sufficient only for authorization reads.


A further native ended all-day daily sample skipped its 19 October occurrence to
20 October while its inclusive end remained 21 October. Only the root's due and
modification fields/tokens changed; Rule and List fields and versions stayed
unchanged, with no pair, history or new ID. Delete All Future at that penultimate
date detached and soft-deleted the root and changed only Deleted on the Rule,
retaining its links. Native List membership was rebuilt from empty to the other
active root, with an ordering-token advance; unrelated records retained exact
versions and fields. The connector retains its established-membership removal
recipe rather than reconstructing missing sibling memberships.

The first built Worker explicit-zone ended deletion stopped before any Apple
POST because prepared/dispatched intent JSON field order differed from schema
restoration. The same failure appeared in the representative Worker journey.
The corrected construction preserves the original retained request, IDs/time,
source/outcome hashes and phase; acceptance resumes those original arguments
rather than replacing the request or its version tag.

The repaired built Worker resumed the identical retained prepared request and
advanced its same ID to the inclusive final date with one Apple POST. Final
`occurrence` deletion then retired that root and Rule under a deliberately lost
acknowledgement; original ID/tag/scope/zone arguments reconciled with zero writes.
Changing scope or calendar zone on the original stale request conflicted before
dispatch. Omitting the zone for the native nonmidnight end was refused with zero
writes. Exact captures showed only the intended root/List fields and Rule marker
changes, retained due/completion fields and strict asset/intrinsic metadata, no new
history/pair/IDs and unchanged unrelated records. Reminders displayed the final
date and subsequent removal; retained session generation and fixed expiry stayed
unchanged. A regression now checks the full calendar-bound phase transition;
the representative Worker journey passes final retirement and lost-acknowledgement
reconciliation with both explicit and omitted calendar-zone recipes.


## Native ended weekly deletion boundaries

A timed weekly sample displayed 19 October 2026 at 09:00 London and an end date
of 26 October. Its stored end instant was 26 October 06:15:53 UTC, earlier than
the next weekly due instant, 09:00 UTC after the clock change. Delete This Reminder
Only briefly hid the item but saved no Apple change; exact repeated reads retained
all original fields and versions, and switching lists restored the unchanged item.
The native error log reported a zero due-date advance. This is a verified native
no-advance edge, rather than evidence of successful retirement or synchronization.
Explicit Delete All Future then detached and soft-deleted the root and changed only
Deleted on its Rule and current pair, retaining backlinks and intrinsic parents.
The List membership/ordering changed; unrelated participants remained unchanged.

A separate sample due at 09:00 London on its end calendar day was deleted immediately
without a scope menu, even though its stored end clock preceded its due time. The
root and current Rule/pair followed the same retirement shape. Final deletion thus
uses local end-day identity, whereas earlier timed advancement needs an actual next
instant within the stored end. A further 05:00 London sample advanced across the
clock change from 19 to 26 October with its same active identity and retained end.
That next instant fit before the nonmidnight end; final native deletion then
retired only the same active root and current Rule/pair, with no scope menu.

The built Worker reproduced these recipes on three fresh native graphs. It
advanced 19 to 26 October at 05:00 London with one POST and no history. A lost
final occurrence acknowledgement reconciled from the original arguments with
zero writes; changed-scope stale arguments conflicted before dispatch. The
no-advance graph was refused with actionable all-future guidance and zero POSTs;
explicit all-future retirement then saved once under a lost acknowledgement and
reconciled read-only. A separate same-day end-before-due-clock occurrence retired
normally and its identical replay sent no write. Exact raw comparisons retained
completion/due/end fields, full asset crypto and intrinsic metadata, and all
unrelated fields/versions. Retirement advanced the List ordering token even with
absent established membership; it did not reconstruct missing sibling members.
Reminders displayed advancement and final removal. Session generation and fixed
expiry remained unchanged. New ended-weekly intent fields preserve legacy
serialization and hashes; caller scope is never changed implicitly.

Private Site version 41 reproduced the same boundaries through the installed connector
on three fresh native graphs. The 05:00 sample advanced across the clock change and its
final occurrence retired in place; the 09:00 no-advance sample stayed unchanged until
explicit all-future retirement; another 09:00 sample retired on its end calendar day
despite an earlier stored end clock. Original successful arguments replayed read-only
with unchanged result tags. Exact raw comparisons verified pair replacement and
Deleted-only retirement, retained dates/backlinks/crypto and unchanged prior histories.
The app displayed advancement and final removal, with generation and expiry preserved.
The refreshed Delete calendar field also passed the retained nonmidnight daily witness:
explicit London final retirement and original replay succeeded with only the intended
root, rule and List changes.

## Native last-day monthly deletion

A fresh all-day sample due 31 October 2026 used Monthly with no end condition,
stored time zone or alarms. Its native rule had interval one, month days
`[28,29,30,31]` and set positions `[-1]`. Delete This Reminder Only advanced
the same active identity to 30 November at midnight UTC. Only its due date,
last-modified date and resolution tokens changed; Rule and List fields and
versions remained unchanged. No completed history, new record or pair was created.

Delete All Future then detached and soft-deleted the root, preserving its date,
completion state and rule IDs. Only Deleted changed on the current Rule; its
backlink, intrinsic parent and crypto metadata remained intact. The List ordering
counter advanced from 7 to 8 while its existing empty ReminderIDs stayed empty.
Unrelated historical records retained their exact fields and versions. The app
displayed the November advancement and final removal. These captures establish
this particular no-end, no-pair last-day rule; they do not establish arbitrary
monthly days, end conditions, alarms or recurring families.

The built Worker reproduced advancement and retirement on a fresh native graph.
Both deliberately lost acknowledgements reconciled from their original arguments
with zero further dispatches. Changed-scope replay conflicted, missing scope failed
validation, and a caller calendar zone was refused, all before writes. Advancement
changed only the intended root fields; exact-version no-op guards advanced Rule/List
versions while preserving their fields. Retirement matched the native root/Rule/List
shape, preserving crypto and intrinsic backlinks, earlier histories and unrelated
fields/versions. The app displayed advancement and final removal; session generation
and the original fixed expiry remained unchanged.


## Query-lag repair acceptance

On 12 October 2026, all 188 unit tests, TypeScript, lint, built-Worker/local integration,
public configuration, Sites and standalone Cloudflare build/dry-run/integration checks passed.
The existing normal MCP integration family journey now includes a child committed into native
ordering before inspection but withheld from the indexed query; the full family is completed.
Missing lookup responses, stale guards, hidden deeper families and retired ordering entries
remain covered. Creation receipts preserve unrelated List fields and non-null List parent
metadata; changed receipt metadata returns uncertainty. Independent review found no remaining
issues after the List-parent comparison correction.

The current production bundle then made three real-Apple creations in a fresh disposable
List: an ordinary root, a guarded subtask and a separate ordinary root. Each atomic receipt
confirmed the List ordering/token update before creation, and each original stable-key replay
sent zero additional writes. All three appeared in Reminders. Native Indent attached the
separate root as a second child before MCP's first mutation read. The test adapter withheld
that real child's identity from the query response while forwarding all exact lookups unchanged.
Normal MCP completion still mutated all three family members in one atomic operation; exact
readbacks and Reminders showed three completed reminders. Reopening under the same withheld
query restored all three. This verifies committed membership hidden by query-index lag, rather
than relying on a stale version to expose it.

After native Outdent, a separate held-read journey attached that same child through Reminders
after MCP captured its final two-member family. The retained completion made exactly one stale
atomic attempt and returned `CONFLICT`; all three reminders stayed open. The held read completed
in 6,617 ms under the original eight-second HTTP deadline. No production timeout, session
generation, fixed expiry, D1 schema, Queue or background runner changed.


Hosted version 48 then passed ordinary/subtask creation, original-key reconciliation,
two-member family completion and reopening through the installed connection. Exact native
capture confirmed all five current fixture identities in List ordering, and Reminders showed
both open families. The private audience, runtime environment revision 9, generation and
fixed expiry were preserved. All four [runtime CI jobs passed for b171dfe](https://github.com/Xzese/icloud-reminders-mcp-for-cloudflare-workers/actions/runs/38305994399).

At the owner's request, all ten remaining disposable appearance/lifecycle Lists from this
work and their 31 synthetic reminders, including completed histories, were removed through
native recoverable deletion. Complete pre-cleanup inventory confirmed synthetic contents;
exact post-cleanup API reads confirmed all ten Lists retired and all 31 reminders deleted or
absent. The native sidebar and refreshed MCP catalogue showed no remaining test Lists. The
existing Test list contained no MCP-prefixed samples. Unrelated Lists were retained and
Recently Deleted was not purged. Private captures remain ignored; no Apple data or credentials
were added to source.

## Interval-aware completion

Completion now carries the stored interval (1–999) from the rule classifier into
calendar advancement for the existing daily, weekly and monthly recipes. Timed
rules retain their local clock; all-day rules retain calendar-date labels. Ordinary
monthly completion checks the target month rather than each intervening month, so
31 January every two months advances to 31 March. Missing target dates, ambiguous
or missing local times, unsupported rule patterns and overdue skipping still fail
before dispatch. Hourly and yearly completion remain separate unsupported recipes.

Ended timed weekly and all-day daily completion require the end to align with the
stored interval cadence. Final completion and reopening retain the exact active
record and rule. Recurring deletion still requires interval one, with an explicit
check preventing the shared classifier from expanding deletion eligibility.

Synthetic planner tests cover intervals 2, 3 and 999, leap years, clock changes,
month boundaries, aligned/misaligned ends and retained history identities. The
production Worker acceptance moves an every-two-days reminder, completes it across
a London clock change, and reconciles a lost acknowledgement without another
write or history record. This extends calendar calculation over the previously
observed record transitions; it is not a new native Apple interval observation.
Unknown alarm date-component payloads remain unsupported independently of interval.
