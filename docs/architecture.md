# Architecture

The shared application exposes a private dashboard, isolated credential document and stateless
HTTP MCP at `/mcp`. `src/api/router.ts` authorizes API requests before database operations.

In Sites mode, `src/worker.ts` is the platform-dispatched entrypoint. In standalone mode,
`src/index.ts` verifies the Cloudflare Access assertion, removes supplied identity headers, and
passes only the verified principal to that shared Worker. Managed OAuth is handled by Cloudflare
Access at the edge; the application does not run an OAuth authorization server.

All application code is under `src/`: `src/app/` holds the dashboard and browser login client;
`src/components/`, `src/hooks/`, `src/lib/` and `src/types/` hold shared UI, helpers and declarations.
Build-time framework plugins live in `scripts/build/`. Operational commands are grouped by
purpose under `scripts/`; built Worker acceptance runners live in `tests/integration/`.
The editable standalone configuration is `wrangler.toml`, with private/generated TOML copies
excluded from public source. Framework-generated Wrangler JSON stays inside `dist/`.

D1 holds encrypted Apple-session envelopes in `apple_session_state`. Envelope associated data
binds owner/account/generation/schema. Versioned leases fence concurrent setup, consent, reads, writes
and disconnect. `schema.sql` defines the session, job, saved-filter and workflow tables for a new deployment. Local setup
and tests execute it directly using native D1. Standalone operators initialize D1 with Wrangler's
`d1 execute --file schema.sql`. The Sites build copies the immutable `migrations/0000`–`0007` history into
`dist/.openai/drizzle/`; pending migrations upgrade existing databases while preserving jobs
and encrypted sessions. Artifact verification compares fresh `schema.sql` and migrated schemas.
No Drizzle dependency or migration generation is needed. Standalone upgrades must apply their
missing migrations in order; repeating the fresh initializer does not upgrade existing tables.

The credential document's standalone browser bundle performs password proof processing. The
Worker handles bounded Apple HTTP/WebSocket exchanges, trusted-device verification and PCS
consent. It stores encrypted session credentials with an absolute local lifetime rather than
storing the password. The cryptography and protocol are unofficial and need independent review.

Fresh sign-in opens Apple's authorization context, performs the remembered-account federation
preflight, and only then requests the SRP challenge. The Apple-facing origin, current device-context
header, frame ID, cookies and evolving session headers are maintained across those steps; the
dashboard's localhost or LAN origin is not forwarded to Apple. Rejected or federated preflight
stops before SRP initialization. Apple security response `-20209` is recognized as either a
JSON number or string and never treated as a reason to repeat password-proof submission.
The error identifies the failed sign-in step without exposing Apple's raw response or account
details. It does not establish an account-wide lock or require recovery when a fresh sign-in
at iCloud.com with the same Apple Account succeeds.

Local development resolves private Apple state from the main Git checkout, including when launched
inside a linked worktree. A separate SQLite transaction locks that state across processes and
legacy redirects and symlink aliases; it releases on normal shutdown or process failure. Explicit state-directory
overrides remain available for isolated experiments. The centralization command takes consistent
encrypted database snapshots, preserves existing directories as private backups, and can link
legacy worktree state paths with credential-free redirect markers. Old launchers fail before
opening the shared database, preventing incompatible readers from clearing retained credentials.

The envelope and associated-data schema stay at version 1. Inside it, strict login assurance accepts
legacy version 2 (exactly 24 hours from verification) and version 3 (`absolute-30d-v1`, exactly 30 days).
The authentication policy remains `device-only-v2`; retention is not another Apple verification.
Server-controlled owner/account/generation approval enables a CAS migration before expiry cleanup
in every loader, including status. It preserves credentials and generation, records separate owner
approval, re-encrypts with a fresh nonce, advances row version, and reloads the committed fence.
Active leases defer migration without destructive expiry cleanup. No new D1 table is needed.

`session-renewal.ts` performs request-driven checks under the same exclusive short D1 lease, commits
them, then releases ownership before reminder preparation. The pinned setup `/validate` body is JSON
null. Accepted account/trust/service evidence reuses credentials; a recoverable rejection allows one
saved-token `/accountLogin` exchange, never a password fallback. The six-hour engineering interval is
configurable. Recent successful reminder operations suppress unnecessary proactive checks; full
validation, successful operation and exchange times are separate encrypted metadata. Failures retain
safe state, persist bounded cooldowns/Retry-After and expose required action without raw Apple data.
Local retention expiry and confirmed account rejection are separate from PCS consent or short cursor
expiry. Expired PCS attempts require an explicit new bounded approval request, not status prompts.

Renewal and reminder calls share a complete request budget. Client reconstruction uses committed
cookies and service information. Operation modes distinguish read-only, mutation preparation, cursor
progress and PCS. Authentication recovery may replay a read-only callback or undispatched preparation
once; mutation dispatch/confirmation and cursor progress are never replayed. Existing exact lookups,
idempotency keys, version checks and the final pre-dispatch lease check remain mandatory.
See [compatible rollout and rollback](session-retention.md).

List discovery uses the private CloudKit `Lists` query without reading history. Singular `List`
summaries are normalized across bounded continuations and committed only after complete retrieval.
The encrypted snapshot supports dashboard display; MCP list calls always fetch live data.
Historical discovery, scheduler execution and strategy selection have been removed.

Known-list reads use a live exact lookup within the authenticated Reminders zone before the existing
`reminderList` query. All-open starts with direct discovery, stores selected list summaries/IDs and
per-list cursors, and rotates single-use continuations before queries. Resumption never rediscovers
lists, and a dashboard refresh cannot skip outstanding pages. Reminder bodies are not persisted.
Every remote operation retains read leases, version/generation fences and absolute expiry checks
on commit.

Version-1 session compatibility strips only recognized obsolete catalogue fields. The next successful
commit removes those fields from encrypted storage. Historical or unmarked old all-open continuations
are retired without disconnecting the Apple session; direct operation selections remain valid.
No D1 migration or reset is needed. Unknown active fields still fail strict validation. Authenticated snapshots with current verified login evidence remain encrypted and untouched when their schema is unsupported; this checkout returns `PROTOCOL_CHANGED`. Missing/invalid login assurance, expired retention and tampered ciphertext still fail closed under the existing invalidation rules.

Dashboard polling reads saved state only. There is no scheduled handler, local background timer or
historical fallback. Generated standalone configs omit triggers; operators must remove previously
provisioned catalogue schedules during their own deployment. Direct discovery has synthetic coverage
and an approved one-account live test of existing lists and creation/deletion freshness. Live
pagination, groups and shared database completeness remain unknown. See
[direct discovery evidence](direct-list-retrieval.md).

Reminder creation, editing, completion, reopening and deletion use the same private CloudKit
transport and session lease. They require the bound authenticated owner and a ready unexpired
Apple session, with no separate write-approval flag. Exact lookups verify the current list and reminder before dispatch.
Creates derive the Apple record ID from the caller's UUID idempotency key, while updates send
only changed fields with an exact server change tag. Resolution tokens for untouched fields
are retained. Single-request reminder content and mutation receipts are not cached in D1. Bulk jobs separately
persist encrypted approved input, dispatch intent and item receipts under job-specific AAD;
their additive migration never changes session rows. The protocol rejects force-update,
replacement and hard deletion; single-request soft deletion uses a tagged update.

Writes are never automatically retried or redirected. An uncertain upstream response or a lost
session fence after submission returns `WRITE_OUTCOME_UNKNOWN`; local fencing cannot undo an
Apple request already in flight. Read current state before another edit, or reconcile creation
using the same UUID. Successful mutations invalidate an unfinished all-open continuation so it
cannot silently skip a newly created item in a previously scanned list. See `write-access.md`.

`src/jobs/` uses a durable owner/account/generation-bound ledger, immutable sealed manifests,
CAS account/job leases and bounded authenticated continuation on **both** targets.
Both entrypoints expose request handling only; no Queue consumer or scheduled outbox pump
exists. Only an authenticated continuation runs a slice. Status and start requests do not
execute work. Simple bulk creation is a permanent
ready-account capability once the job schema is installed;
simple bulk deletion reuses the single-delete checks per item, with a read-only preview preflight and post-commit subtask report.
Bulk updates and completion require migration `0004_bulk_change_jobs.sql` and exact-version
ordinary childless roots. Their previews and dispatch share the same mutation planner;
uncertain recovery compares the persisted write, including implicit date changes.
Recovered dispatch intent is read-only reconciled and stays unknown without a valid receipt.
The [job documentation](reminder-jobs.md) defines lifecycle, limits, retention and migration.

`inspect_reminder` reads bounded native relationships and runs the existing lifecycle and
transfer planners to report action eligibility. Unknown relationships remain explicit;
inspection neither reserves versions nor creates mutation intent.

Read-only update preparation fingerprints bounded allowlisted linked records and binds a
short-lived token to the exact request. The atomic executor preserves the Reminder mutation
allowlist and can protect unchanged Alarm, AlarmTrigger and RecurrenceRule records with exact
version-checked reassertions of their observed `Deleted=0` marker. Guards share the atomic
request and all bounds, and their complete confirmed fields must match the inspected records.
Controlled native stale-version experiments proved rejection without partial commits for those
three types. The bounded scheduling graph also follows the observed Alarm `TriggerID` UUID
to its exact AlarmTrigger. Structural completeness is separate from recipe support.
`src/reminders/sections.ts` performs bounded Standard-list section hydration with checksum
validation and List-version checks. Its independent encrypted continuation is bound to the
account, generation, exact List version and page size; no reminder bodies or signed asset
URLs are persisted. Native ordering is reported only when its explicit asset exists.

`src/reminders/linked-date.ts` validates timed absolute-date backlinks, components and nonce
consistency. Its narrow executor updates the existing Alarm nonce and Trigger components in
the same group as the Reminder, guarding optional unchanged recurrence. Every confirmed
dependency preserves the complete field set except its planned date field. The ordinary
atomic mutation interface remains Reminder-only; there is no arbitrary linked-record editor.
Native recurring-date move/restore acceptance passed without replacing linked IDs.
`src/reminders/scheduling-plan.ts` adds explicit clearing/conversion, known custom recurrence,
existing early edits, location creation/editing/soft retirement and same-list parent guards.
`src/reminders/recurrence.ts` validates the captured Gregorian frequency and pattern encodings.
Date-alarm retirement deletes the
exact-version trigger before its alarm in the root update batch; only those two types can be
retired this way. Existing resolution tokens retain their replica ID and advance their counter.
These recipes do not establish unreferenced-child protection, arbitrary calendar semantics
or parent/child lifecycle cascades. See
[Apple evidence and exact scope](linked-record-protocol.md).

`src/reminders/subtasks.ts` adds permanent one-level same-list relationship builders and
bounded child inspection. The API and MCP share `create_subtask` and `set_parent` mutations,
with `create_subtask`/`set_reminder_parent` MCP tools and a session-dependent `subtasks` capability.
No rollout flags control subtask relationships or simple bulk creation.
Creation keeps CloudKit ownership under the List and writes `ParentReminder` independently.
Movement changes only that reference and its modification tokens. Affected Reminder parents
are protected by exact-version marker guards in the same atomic group. Guard confirmations
must preserve their complete fields. The simple bulk-create schema is unchanged.
Creation atomically appends the new identity to native List ordering before creating the
Reminder; subtask creation also guards its root. Relationship changes guard the full List
and affected roots. Family and childless inspection resolve the union of queried and native
ordering identities through bounded exact lookups, covering query-index lag before the first
read as well as stale versions after inspection. Bulk deletion refuses discovered parents
and rescans after commit to report remaining subtasks. These protections cover the established
membership recipes; they do not invent a universal native predicate for unreferenced additions.

The provenance directory preserves upstream references and licenses. Checked-in synthetic fixtures
exercise the pinned protocol reference, not a live Apple account. See SECURITY.md for invariants
and README.md for separate provisioning and identity requirements.

## Connector collections and saved filters

The bounded collection helper composes the existing paginated search API. It freezes the requested
Apple generation, follows empty pages, refuses duplicate identities or incomplete pages, and sorts
only complete results. Timezone views compare all-day calendar components separately from timed
instants. JSON/CSV exports contain only normalized records; CSV cells neutralize formula prefixes.
Body collection stays in request memory, with no new catalogue or background scheduler.

Saved definitions are encrypted independently of Apple login in the owner-scoped
`connector_filters` table (migration 0005). SQL enforces quota and revision guards; native Smart List
storage is unaffected. See [connector collection contracts](connector-collections.md).
