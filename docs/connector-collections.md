# Connector collections

`src/reminders/collection.ts` provides a read-only helper for higher-level connector views and bounded JSON or CSV export. It does not call Apple directly, cache reminder bodies, or perform writes. A caller supplies the existing paged search operation as `searchPage`.

## Collection contract

`ReminderCollectionInput` accepts a view (`all`, `overdue`, `today`, `upcoming`, or `untagged`; default `all`), an IANA `timeZone`, an explicit ISO 8601 `referenceInstant`, and optional `upcomingDays` from 1 through 90 (default 7). Optional `filters` uses the existing `SearchFilters` schema and defaults to open reminders. The caller should capture one reference instant for the entire operation.

The page callback accepts `{ expectedGeneration, filters, continuation }` and returns the existing service envelope shape: `{ generation, result: { records, scannedRecords, complete, paginationComplete, continuation } }`. Each page must have `complete: true`. The helper sends the first response generation back as `expectedGeneration` on later calls and rejects a changed generation. It refuses incomplete pages, duplicate reminder IDs, repeated cursors, malformed terminal pagination, and exceeded page, reminder, byte, or elapsed-time bounds. Results are available only after a terminal page with `paginationComplete: true` and `continuation: null`; errors never return partial records.

All-day due dates use the first ten stored date characters as their calendar date and are compared with the reference date in the requested time zone. Timed due dates compare instants; local day boundaries are calculated in the requested time zone, including daylight-saving transitions. Upcoming excludes today and spans the next `upcomingDays` calendar days. Untagged collection asks search to apply `hasTags: false`; do not combine that view with tag filters or `hasTags: true`.

Complete results sort by the requested `sortBy`: due date (default), native priority (high, medium, low, none), case-folded title or creation date, then exact ID. Missing values sort last. `exportReminderCollection` accepts `json` or `csv`; it enforces an output byte cap and refuses truncation. CSV cells are quoted and spreadsheet formula prefixes (including leading whitespace before `=`, `+`, `-`, or `@`) are neutralized with an apostrophe.

## Public tools

`get_reminder_view` accepts the collection fields and optional `expectedGeneration`. `export_reminders` adds `format: "json" | "csv"` and returns inline `content` with the count and the same collection metadata. JSON contains normalized records; CSV does not include raw assets, credentials or signed download links. Both tools require explicit `timeZone` and `referenceInstant`, enabled Reminders read permission, and independent Apple Reminders approval.

Public requests scan at most **25 pages, 1,000 reminders, 512 KiB of normalized records and 30 seconds**. The scan budget counts native Reminder records before all search filters. The fixed 100-record page size remains cursor-bound; when a remaining budget cannot fit another full page, narrow the search. A nonterminal search page may contain no matches: the reader still follows its cursor. Native search's `complete` means the whole scan has finished; the collection adapter checks page errors separately and uses `paginationComplete` for termination. It never treats a partial result as globally sorted or exports truncated content. Reminder bodies exist only in request memory. Concurrent searches can replace a cursor and cause an explicit conflict.

The returned `consistency: "live-pages-not-snapshot"` is deliberate. Complete pagination is not an immutable snapshot or a promise of shared-list discovery.

## Saved connector filters

Migration **0005_connector_filters.sql** adds independent encrypted, owner-scoped definitions. `save_reminder_filter` accepts a stable `filterId` UUID, visible `name`, `definition` (the collection fields without `referenceInstant`) and optional `expectedRevision`. Omit the revision to create; provide the exact returned revision to update. Identical creation/update retries return the saved definition without another change. Different requests with stale revisions conflict.

`get_reminder_filters` lists up to 32 owner-scoped definitions. `run_reminder_filter` accepts `filterId`, a new explicit `referenceInstant` and optional `expectedGeneration`; it runs the same bounded reader. `delete_reminder_filter` requires the exact revision. Definitions survive Apple reconnection and contain no reminder bodies, tokens or frozen date boundaries. They are connector preferences; they do not create native synced Smart Lists or templates.

Fresh databases use `schema.sql`; existing databases apply migrations in order. These migrations are packaged with the application and do not modify Apple session rows. Configure the existing encryption key ring before saving filters. Reading and running filters require Reminders read permission; saving and deleting filters require Reminders write permission. Disabled Reminders hides all these tools and blocks direct calls. Missing storage returns `CONFIGURATION_REQUIRED` with migration guidance.
