# Reminders list management

The MCP tools `get_reminder_list`, `create_reminder_list`, `rename_reminder_list` and
`delete_reminder_list` use the existing authenticated private CloudKit connection.

## Scope and limits

- **Create:** supply a name and a UUID idempotency key. This creates a standard list with
  manual sorting and automatic categorisation disabled. Keep the same key and input after an
  uncertain result. A matching existing list is returned without another write; a different
  name for that key conflicts. Appearance, grouping, smart and grocery lists are not created.
- **Read:** `get_reminder_list` returns the exact name and current `recordChangeTag`, including
  a soft-deleted list for reconciliation. `get_reminder_lists` supplies selectable IDs without
  tags. A native standard list may omit its count, so `count: null` is not proof of emptiness.
- **Rename:** supply the exact ID, its current tag and the new name. The native name token
  advances on its existing replica; unrelated fields and tokens are preserved. Stale versions
  fail without forcing or retrying a write.
- **Delete:** supply the exact ID, tag and current title as `confirmName`. Only private,
  non-group, empty lists qualify. The server requires explicitly empty `ReminderIDs`, rejects
  any nonzero count, checks all bounded pages including completed reminders, then rereads
  metadata before the tagged atomic mutation. Missing membership, incomplete reads and any
  observed reminder reject deletion. Up to 25 pages of 200 records are checked within the
  normal operation deadline. No reminder cascade is exposed.
- Sharing metadata, foreign owner/zone records and groups are refused. Omitted zone metadata
  from an authenticated private-zone exact lookup is bound to that same trusted zone; an
  explicit foreign zone is never accepted.
- A native client could add a reminder after preflight without advancing the list's version.
  The empty-list check is a bounded preflight, not a proven transaction lock over membership.
  Concurrent list-version changes reject the mutation. Nonempty deletion remains excluded.
- Lost or malformed acknowledgements return `WRITE_OUTCOME_UNKNOWN`. Inspect the exact
  list before deciding on a new operation. Never automatically retry an uncertain mutation,
  allocate a replacement create key, or force a stale tag. Definitive Apple conflicts remain
  conflicts. Session generation, write leases and absolute retention deadlines are preserved.

## Native protocol evidence

An explicitly disposable standard list was created, renamed and deleted through Apple
Reminders. Complete exact lookups were captured privately before and after each action;
account identifiers, native record IDs and raw records are not checked in.

Creation uses `Name`, `SortingStyle=manual`, `IsLinkedToAccount=1`, `Imported=0`, `IsGroup=0`,
`Deleted=0`, `ReminderIDs=[]`, the encrypted INT64 categorisation fields set to zero, and
`ResolutionTokenMap`. Native creation has no `Count`, `Color`, `CreationDate` or
`LastModifiedDate` fields. The creation token map contains `minimumSupportedVersion`,
`sortingStyle`, `parentAccount`, `name`, both categorisation names and
`reminderIDsMergeableOrdering`.

Native rename changes only `Name` and its resolution token. Native deletion sets `Deleted=1`
and `IsLinkedToAccount=0`, advancing only the `parentAccount` token. The connector matches
those recipes and verifies all submitted fields in Apple's acknowledgement. List-name writes
also require `isEncrypted: true`: a native read can omit this flag, but an unflagged name
was rejected as an invalid byte value. A bounded probe established the encrypted-string
serialization and the resulting name appeared correctly in Apple Reminders.

## Verification

Automated checks use synthetic account state and intercept every outbound Apple request.
They exercise the production MCP tools through create, exact read, name change and deletion,
including absent count/zone metadata, completed and open reminder refusal, stale tags,
wrong confirmation names, ownership/groups, matching and conflicting create keys, and
committed but lost responses. No live account credentials or reminder contents enter CI.

Controlled live acceptance created a fresh disposable list through the production MCP tool,
confirmed its name in Apple Reminders, renamed the same identity and confirmed the new
name, then deleted it only after removing its sole synthetic reminder. It disappeared from
the native sidebar; exact lookup retained the soft-deleted state. Matching create-key
reconciliation made no second write. Different-name key reuse and stale versions conflicted
without dispatch. Both an open reminder and a completed reminder prevented deletion, even
when the sidebar showed zero open reminders. Session generation and retention deadline
were preserved. The native evidence list and protocol probe were cleaned up; unrelated
lists remained intact. No unconfirmed mutation was replayed.

Existing sessions, authentication settings and D1 schema are unchanged.
