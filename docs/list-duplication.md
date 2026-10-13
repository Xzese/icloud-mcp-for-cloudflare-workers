# Reminder list duplication

`duplicate_reminder_list` makes a bounded plain-content snapshot in a new owned private Standard list. It accepts a stable `duplicationId`, exact source list ID and current source list version, a destination name, and the current Apple session generation. Keep the complete request unchanged when reconciling an uncertain result.

Before creating anything, the connector resolves the exact source List version, reads every page of open reminders (up to ten pages and 30 seconds), and inspects each selected root. The supported snapshot is at most 20 open, ordinary, undated, childless roots. Each may contain plain title and notes, supported priority and flag values, zero or one ordinary URL, and literal reminder tags. The existing native copy planner remains the final eligibility gate. Completed history, list groups, sections, ordering, appearance, and schedules are not copied. This is a plain connector snapshot, not an Apple Reminders template or native list-template feature.

The source list and reminder tags are checked again before every copy. The destination list version advances only after the connector confirms its own operation; a separately changed source or destination stops later writes. The encrypted durable manifest is bound to the authenticated owner, Apple account, generation, and duplication ID. Its list creation and each reminder copy have a persisted `started` stage before dispatch. A repeated request after a started but unconfirmed stage performs exact-ID reads only and never resends that stage or starts later items. Matching completed requests are read-only. Reusing the ID with different inputs, account, or generation returns `CONFLICT`.

Manifest ciphertext contains copied bodies, URLs, tags, and exact source versions. Tool output contains IDs, status, and confirmed or explicitly observed version tags only. Duplication requires enabled Reminders write permission and independent Apple Reminders approval; preflight and recovery reads also require read permission. Migration `0007_list_duplication.sql` is required; a missing table returns `CONFIGURATION_REQUIRED`.

A source URL/tag snapshot retains each exact related-record version as well as its value.
The final native planner rejects a changed related version and carries the same records into
its atomic version guards. No later read silently replaces that approved source snapshot.
Manifests remain encrypted as no-replay evidence; there is no ledger purge endpoint.
