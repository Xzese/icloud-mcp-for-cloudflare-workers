# iCloud service expansion plan

Research date: 13 October 2026. Repository baseline: `15f2d3a335f2fd8f30b47f836d2154ca5cc4f335`.
Status: implementation delivered in the working tree. This document records the research and
original design; [the Drive guide](icloud-drive.md) is the current operational contract.
Synthetic tests, Worker acceptance and a live read/write run on one retained Apple account
cover the implementation; see the Drive guide for the measured scope and remaining limits.
Destination collision checks are preflight checks, not an atomic create-only
guarantee against concurrent native edits.

Extend this server with iCloud Drive through the existing Apple web session. The first release
must support browsing folders, finding files, reading and downloading files, uploading files,
and creating, renaming and moving folders and files. Users must choose the enabled services
and operation groups in the dashboard. Update the README as part of that release so these
choices, defaults, limitations and setup steps are clear.

Deliver the release in small, independently reviewable steps, but do not call a read-only Drive
prototype the completed first milestone. Preserve existing Reminders tools and both deployment
targets. Subsequent services should reuse the shared account and capability infrastructure.

## Feasibility and protocol evidence

**Drive is a credible extension of the current integration.** The repository already derives
protocol code from `timlaing/pyicloud`, pinned in [provenance/sources.json](../provenance/sources.json)
at `e2e44ab875d47dab4475096021da60030f26c35e`. That exact upstream revision also includes Drive.
It shares account authentication, cookies and service discovery, but uses different application
endpoints from the Reminders CloudKit client.

The pinned [account implementation](https://github.com/timlaing/pyicloud/blob/e2e44ab875d47dab4475096021da60030f26c35e/pyicloud/base.py#L1646)
requests PCS access with `appName: "iclouddrive"` and discovers `drivews` and `docws`.
Use this as a protocol reference; do not inherit upstream password storage or authentication
fallbacks. This project's browser proof and trusted-device requirements remain in force.

The pinned [Drive implementation](https://github.com/timlaing/pyicloud/blob/e2e44ab875d47dab4475096021da60030f26c35e/pyicloud/services/drive.py)
provides these reference operations:

- Browse/lookup: `POST drivews/retrieveItemDetailsInFolders`; the ordinary root is
  `FOLDER::com.apple.CloudDocs::root`.
- Download preparation: `GET docws/ws/{zone}/download/by_id`, followed by a data or package URL.
- Upload: `POST docws/ws/{zone}/upload/web`, multipart bytes to its returned content URL,
  then `POST docws/ws/{zone}/update/documents` to attach the uploaded data to its destination.
- Organisation: `createFolders`, `renameItems` and `moveItems`. Rename and move include item etags.
- Distinct identities matter: `drivewsid` identifies directory items; `docwsid` and `zone`
  address document operations. Do not interchange them or derive one from an unchecked path.

Upstream uses `allow_conflict: true` during upload finalisation and temporary client IDs during
folder creation. Neither is evidence of a safe overwrite policy or Apple-side idempotency.
Confirm response semantics and reconciliation before implementing writes.

The upstream head inspected was `fb56ed6652f2d99ca8dc3cf515f7db0b319fcf1d`, dated 12 October 2026.
Its [Drive implementation](https://github.com/timlaing/pyicloud/blob/fb56ed6652f2d99ca8dc3cf515f7db0b319fcf1d/pyicloud/services/drive.py#L77)
adds owner-specific addressing for downloads inside shared folders. Treat shared content as a
separate scope; it must not silently behave like owned content. Record exact revisions and
attribution for any implementation derived from either reference.

Apple documents separate category access under Advanced Data Protection. Together with upstream's
distinct PCS app names, this supports the design choice to track Drive consent independently
from Reminders; verify its precise expiry and recovery behavior during the protocol proof.
Enabled web access and a logged-in account do not alone establish Drive readiness. See
[Apple's web-access guidance](https://support.apple.com/en-us/102630).

Apple's current [Drive search documentation](https://support.apple.com/en-nz/guide/icloud/mmebf050837b/icloud)
describes search supplied by a trusted device with Allow Search enabled. The first connector
search should instead be explicitly described as bounded filename/folder-name traversal;
native device-backed search and full-text indexing need separate research.

Apple's public [CloudKit JS API](https://developer.apple.com/documentation/CloudKitJS)
addresses an application's configured containers. It is not a documented replacement for
browsing a user's entire Drive. This proposal continues the repository's unofficial web-protocol
approach. Reference implementations established feasibility. The subsequent live Drive
acceptance run verified the implemented read/write journeys on one account, with corrections
for actual allocation hosts, exact-file lookup envelopes and parent document identities.

## Dashboard configuration and enforcement

Add a **Services** section to the existing dashboard. Each implemented service gets an enable
switch, operation-group switches, effective status and an actionable explanation when blocked.
Show future services as planned information only, without working-looking enable switches.

Initial controls:

- **Reminders:** enable service; read; write. Write covers the currently supported reminder,
  list, organisation and job mutations. Existing fine-grained capability/status information
  remains available beneath these user preferences.
- **iCloud Drive:** enable service; browse and find; read and download file contents; upload
  new files; create and organise folders/files. The organisation group covers create-folder,
  rename and move; it does not imply deletion, sharing or overwriting file contents.

Use browse/metadata access as an explicit prerequisite for the other Drive groups. Enabling
uploads does not require enabling content downloads. Explain dependencies beside the controls;
reject contradictory settings server-side. Reading and downloading share one permission because
both disclose file bytes. Keep file deletion, permanent deletion, public sharing, replacement of
existing files and shared-folder mutations outside this first release.

Defaults and persistence:

- Preserve today's Reminders behaviour when an existing deployment has no settings row.
  Drive and every future service default off. A new deployment selects Reminders enabled,
  read enabled and write enabled, subject to all existing deployment/authentication gates;
  present those choices before Apple connection. All Drive operation groups start disabled.
- Store explicit, versioned preferences in an owner-scoped settings table, separate from Apple
  credentials. Persist changes across refreshes, restarts and reconnects. Missing initial settings
  have documented defaults; a database failure must not be interpreted as permission to enable
  anything. An explicit disabled setting must never fall back to enabled defaults.
- Save using a settings revision/CAS check. One stale dashboard tab must not overwrite another
  tab's changes. A successful save reports the committed settings and effective capabilities.
- Enabling a service records intent. A separate visible Connect/Approve action starts any
  required Apple consent. Reading status, listing tools and polling the dashboard stay local
  and must not trigger device notifications.
- Turning a service off stops new service operations and future job/transfer steps. It leaves
  other enabled services usable. Explain that disabling local access is different from revoking
  Apple's remembered-browser trust. Disconnect still clears the common Apple session.

Derive effective access from **implemented capability + deployment policy + owner preference +
current account/session/consent state**. User settings may restrict deployment policy, never
override it. Keep login status, selected preferences and actual service availability distinct.

Create one capability/tool registry used by dashboard status, `connection_status`, MCP tool
registration and dispatch guards. The current server is reconstructed per request, so new
`tools/list` requests can reflect enabled groups. Always keep `connection_status` available.
Cached tool lists are not authority: enforce settings in the shared service methods used by
MCP, HTTP and reminder-job continuation. Prefer a clear disabled-capability error for stale
calls; use the SDK's enable/disable mechanism if it supports that contract.

Recheck relevant preferences immediately before upstream dispatch and before releasing read
results. Bind cursors and transfer intents to the relevant permission revision, owner and
session generation. Disabling access invalidates affected continuations and future commit steps.
An already dispatched Apple mutation cannot be undone by a toggle; report its outcome honestly.
Do not expose permission-enabling tools to the MCP agent: configuration belongs in the
authenticated dashboard.

## Repository changes and compatibility

The following locations are the starting points for implementation:

- [src/auth/apple/http.ts](../src/auth/apple/http.ts): `/accountLogin` and `/validate` currently
  extract only `ckdatabasews` and require Reminders. Add bounded, typed service discovery and
  separate trusted-account validation from any particular app being available.
- [src/auth/apple/flow.ts](../src/auth/apple/flow.ts),
  [pcs.ts](../src/auth/apple/pcs.ts) and
  [session-renewal.ts](../src/auth/apple/session-renewal.ts): separate common login from
  per-service readiness, consent attempts and errors. Drive-only configuration must connect
  without requesting Reminders keys. Loss of Drive consent must not disconnect valid Reminders.
- [src/persistence/apple-sessions.ts](../src/persistence/apple-sessions.ts): the existing strict
  payload, account key `apple-reminders` and envelope associated data are compatibility boundaries.
  Keep the DB account key and envelope AAD binding stable. Introduce an explicitly versioned
  payload for common account state and per-service state, with strict legacy decoding and a
  tested migration preserving cookies, owner, account, generation, assurance and expiry.
  Ship migration-aware readers before writing the new payload. A pre-migration binary is not
  a safe rollback target; document a compatible rollback build or tested reverse migration.
- [src/transport/apple-http.ts](../src/transport/apple-http.ts): the current transport accepts
  string bodies, buffers at most 1 MiB and imposes an eight-second timeout. Keep these bounds
  for existing metadata requests. Add a separate bounded streaming transfer path and reviewed
  Drive service/content URL policies, rather than widening the existing policy globally.
- Add a focused Drive client under `src/icloud/` and domain schemas/services under `src/drive/`.
  Do not put Drive into the large `CloudKitRemindersClient` or reuse Reminders record semantics.
- Add settings persistence/policy under `src/persistence/` and a small shared service/capability
  module. Add owner-authenticated GET/POST settings routes in
  [src/api/router.ts](../src/api/router.ts); dashboard writes use the existing same-origin guard.
  Add explicit Drive operation and transfer routes with their own body limits.
- [src/mcp/handler.ts](../src/mcp/handler.ts) and
  [schemas.ts](../src/mcp/schemas.ts): register typed Drive tools, apply permission guards, and
  add per-service status while retaining compatible Reminders fields/tool names. Update
  [src/auth/service.ts](../src/auth/service.ts) and `src/jobs/service.ts` so existing HTTP and
  job paths cannot bypass newly configurable Reminders permissions.
- [src/app/page.tsx](../src/app/page.tsx) and
  [apple-connection.tsx](../src/app/apple-connection.tsx): add service settings and independent
  readiness views. A small file picker/transfer panel can support browser uploads/downloads;
  a complete replacement for Apple's file manager is unnecessary.
- [schema.sql](../schema.sql): add settings and encrypted operation/transfer-intent tables with
  an explicit existing-deployment migration. File bodies do not belong in D1. Use separate
  Drive persistence rather than repurposing the reminder-specific job kind/receipt contracts.

No HTTP proxy change is presently indicated: `scripts/dev/local-icloud-gateway.mjs` forwards
to the local Worker; the separate push relay is unrelated to Drive HTTP. Sites connected-app
bindings in `src/lib/connector-contract.mts` are also a separate mechanism from this MCP server.

## First release contracts

Proposed MCP tool names; settle schemas before implementation and keep one tool catalogue:

- `list_icloud_drive_items`: list root or an exact folder, returning normalized IDs, names,
  types, sizes, dates, etags and supported actions.
- `get_icloud_drive_item`: live exact metadata lookup for selection, version checks and recovery.
- `search_icloud_drive`: filename/folder-name matching within a chosen root, with bounded
  traversal, progress, explicit completeness and an opaque continuation.
- `read_icloud_drive_file`: bounded UTF-8 text or bounded binary bytes with explicit encoding,
  file identity/version and truncation/continuation information. Treat file text as untrusted
  content, not instructions to change permissions or execute other tools.
- `download_icloud_drive_file`: obtain a short-lived, owner-authenticated application transfer
  handle. The application streams bytes; raw Apple signed URLs never reach public outputs.
- `upload_icloud_drive_file`: create a new file using bounded inline bytes, or finalize an
  owner-bound staged transfer from the application's upload route. Return the actual Apple
  item identity/name/version and an operation ID.
- `create_icloud_drive_folder`, `rename_icloud_drive_item`, `move_icloud_drive_item`: one explicit
  operation per call, using stable operation keys and current versions where Apple supports them.
- `get_icloud_drive_operation`: inspect/reconcile a previous write without replaying it.

Use IDs as authority and paths as display information. Resolve targets live under the
authenticated owned namespace. Refuse unsupported app-library/package/shared items explicitly,
rather than mislabelling them as ordinary writable folders. Validate names, Unicode, separators,
root immutability, destination type and self/descendant moves. Bound ancestor inspection and
acknowledge that local preflight alone is not a transaction lock against another Apple client.

**Search completeness:** the inspected upstream lookup requests full folder contents; it does
not establish native pagination. Prove how large folders behave before claiming full traversal.
If a folder exceeds safe bounds or a cursor repeats, return an incomplete/unsupported result,
never a fabricated complete result. Keep search continuations bounded and expiring, without
persisting a whole-account index. Use a separate Drive cursor store when session-size limits
would otherwise be exceeded.

**File transfer:** a remote Worker cannot read a caller's local filesystem path. Implement both
an authenticated browser/HTTP binary-transfer path and a portable, size-capped MCP inline-byte
path. The implemented caps are 64 KiB of decoded inline content, an 8 KiB UTF-8 preview, and 25 MiB per streamed file;
these are application targets, not claims about Apple limits. Verify both hosting targets before
publishing final caps. Do not accept arbitrary URL imports in the initial upload interface.
Large-file access from an MCP client depends on its authenticated transfer support; verify the
intended client and document the browser fallback instead of claiming transparent attachment
support. Binary documents can be downloaded/read as bytes; PDF/Office extraction, OCR and iWork
conversion are separate features, not implicit promises of the text-reading tool.

Workers have a per-isolate memory limit and recommend streaming bodies; do not load entire
transfers into JSON, `arrayBuffer()` or `FormData` buffers. See the
[Cloudflare limits documentation](https://developers.cloudflare.com/workers/platform/limits/).
Implement backpressure, actual byte counts, abort propagation and bounded transfer lifetimes.
Use authenticated handles bound to owner/account/generation/item/version, with expiry and
`private, no-store` responses. Download URLs must not be public bearer links. Serve file bodies
as attachments with safe filenames and `nosniff`; do not execute uploaded HTML in the dashboard.

**URL trust:** validate discovered metadata endpoints and returned content URLs separately,
including scheme, host, port, path and each allowed redirect. Discover and pin required CDN
patterns from evidence. Avoid a wildcard for all Apple/iCloud hosts. Session cookies/headers
must not follow cross-origin content requests by default; permit only credentials demonstrated
necessary for that particular endpoint. Upload tokens, wrapping material, receipts and signed
URLs remain encrypted/internal and absent from logs.

**Writes and recovery:** upload is an allocation, byte-transfer and metadata-commit state machine.
Persist encrypted intent and received identifiers/receipts before advancing a phase. Record
dispatch before every mutation; an uncertain phase is reconciled by reads, not blindly retried.
The same operation key with different input must conflict. Store content length/hash and bound
destination/name in the intent; verify received bytes before finalisation. Handle zero-byte
files explicitly. Read back the committed result before reporting success.

Folder creation also needs durable intent; a temporary client ID does not prove deduplication.
Use exact returned identities for reconciliation. Finding a same-named folder alone does not
prove that this operation created it. Rename/move use caller-observed etags and refuse stale
versions. Initial uploads create new items and never intentionally overwrite an existing one;
test native collision behavior, including concurrent native changes. Report Apple's actual
result or a conflict/unknown outcome instead of claiming an unproven atomic name reservation.

The existing operation lease is 30 seconds. Large transfers need an explicit bounded lease
design: keep common-session credential exchanges/commits under the existing fence, use a
separate expiring transfer intent during byte streaming, and reacquire/recheck session and
permission fences before finalisation. Document cancellation during dispatch and mid-stream
disconnect behavior. Avoid holding or extending a generic read lease indefinitely. Pending
operation status never executes Apple writes, and no background worker is needed for v1.
Set receipt retention explicitly, bounded by the session lifetime; discard sensitive transfer
state on disconnect. Explain that unfinalized remote upload artifacts may require expiry or
later cleanup; do not invent an unverified Apple cleanup operation.

## Implementation sequence and acceptance

1. **Protocol and transfer proof.** Pin the Drive reference files and create synthetic fixtures
   for discovery, `iclouddrive` consent, metadata, upload phases, rename/move and error responses.
   Establish large-folder behavior, content URL patterns, collision semantics and both hosting
   targets' authenticated binary-transfer support. Use a dedicated disposable folder for any
   separately authorized live experiment. Record verified, inferred and unresolved behavior in
   `docs/icloud-drive.md`; do not generalize one account's result to all account modes.
2. **Service settings.** Add the owner settings table, revisioned API, capability registry and
   dashboard controls. Gate existing Reminders reads/writes/jobs as well as future Drive actions.
   Accept when settings survive reload, stale saves conflict, Drive defaults off, and disabling
   Reminders writes blocks direct MCP/HTTP/job dispatch while reads still work.
3. **Shared account and Drive consent.** Add typed service discovery, the compatible payload
   migration, independent readiness and renewal. Accept existing sessions without reconnecting,
   Drive-only connection without Reminders consent, and independent consent loss/recovery.
   Review the auth, encryption and migration diff independently before proceeding.
4. **Drive reads and transfer download.** Implement browse, exact lookup, bounded filename search,
   text/byte reads and authenticated streaming downloads. Accept a complete selected-folder
   journey, truthful partial results, hash-matching downloads and correct refusal of unsupported
   items. Verify permission changes and disconnect invalidate subsequent reads/handles.
5. **Drive upload and organisation.** Implement the intent ledger, inline/stream upload,
   create-folder, rename and move. Accept an upload into a newly created folder, download/hash
   comparison, rename and move with native read-back. Exercise stale versions, duplicate keys,
   collision, zero bytes, interrupted response and disabled permission before finalisation.
   Uncertain operations must not dispatch again merely because the client retries.
6. **Documentation and release validation.** Complete README/dashboard copy, the detailed Drive
   and settings references, MCP API docs, provenance and migration/rollback instructions. Run
   repository checks and controlled end-to-end acceptance on both targets. The first release
   is complete only when all requested Drive groups and dashboard enforcement pass.

Use one implementation owner for the shared auth/settings contracts; parallel writers should
not touch those files. A bounded researcher can establish missing protocol evidence, followed
by one builder for the clear modules. Use independent review for session migration, capability
enforcement and transfer/write recovery. Do not launch one agent per tool or per test.

Extend existing auth, persistence, renewal, security and Worker integration coverage where it
catches the new regression. Add focused Drive coverage for the materially new transfer state
machine and protocol behavior. Prefer a few representative journeys through real MCP/HTTP
entry points over tests of internal call counts or source text. Include wrong-owner requests,
off-service bypass attempts, malformed discovered URLs/CDN redirects, oversized bodies, changed
permissions during a transfer, and a commit accepted by Apple whose response is lost.

Required implementation checks:

```sh
npm run lint
npm run typecheck
npm test
npm run public-config:check
npm run build
npm run test:worker
npm run verify:artifact
npm run build:check
```

Before pushing, run the Git-history secret scan with the version pinned in CI (currently
Gitleaks 8.30.1), with redacted output. Keep synthetic fixtures invented and live captures,
file contents and signed links out of public source. Application edits belong in the canonical
root; preserve the existing private Sites binding and regenerate its deployment checkout using
the documented Sites workflow only when publishing is authorized.

## README requirements

Rewrite the opening and tool summary around the actually shipped multi-service capabilities;
retain the repository URL, existing MCP names and operator setup compatibility. Do not advertise
this plan as a working feature. Put the following information near the top, with links to
details rather than requiring readers to discover it deep in protocol documentation:

- This is a self-hosted, single-owner, unofficial iCloud integration using Apple's web session.
  Enumerate implemented services; distinguish future plans clearly.
- Explain **Dashboard → Services → enable service → choose operation groups → Save → approve
  Apple access when prompted**. Show the exact current defaults, prerequisites and status labels.
- Define every group in plain language. Read/download exposes file contents; upload adds new
  files; organise creates/renames/moves folders and files. Describe existing Reminders write
  scope and make deletion exclusions explicit for Drive.
- Give three worked configurations: Reminders only; Drive browsing/downloads; Drive with uploads
  and organisation. Show the resulting tools and how to verify them with `connection_status`.
- Explain service-specific Apple approval, ADP/web access, renewal and the difference between
  disabling a service and disconnecting the account. Do not recommend disabling ADP.
- Publish measured file/request limits, supported text formats, binary download/upload paths,
  large-file client requirements, filename-search completeness, and unsupported shared/package
  behavior. Include one small-file MCP example and one authenticated browser transfer example.
- Explain encrypted session/intent retention, no permanent file-body cache, operation keys,
  stale-version conflicts and uncertain-write recovery in actionable language.
- Include database upgrade and compatible rollback steps for both existing deployment modes,
  tool-list refresh/reconnection advice where clients cache schemas, and actual live-validation
  scope. Keep public configuration templates free of operator-specific values.

Check README examples against actual schemas and acceptance results. The settings UI labels,
README, `connection_status` and `tools/list` must describe the same capabilities and defaults.

## Other services after Drive

The same upstream lists Calendar, Contacts, Notes, Photos, account/storage and Hide My Email,
among other services. This supports further investigation, not an assumption of identical APIs.
See its [service catalogue](https://github.com/timlaing/pyicloud/tree/fb56ed6652f2d99ca8dc3cf515f7db0b319fcf1d/docs/services).

Suggested order, subject to user priorities:

1. **Calendar:** time-bounded event reads, then narrowly scoped writes; useful alongside Reminders.
   Upstream documents calendars/events, alarms and invitees. Notifications, recurrence and time
   zones need explicit semantics before writes. [Calendar reference](https://github.com/timlaing/pyicloud/blob/main/docs/services/calendar.md).
2. **Contacts:** bounded lookup/read first, with account and pagination checks.
   [Contacts reference](https://github.com/timlaing/pyicloud/blob/main/docs/services/contacts.md).
3. **Notes:** folder/note reads with separate consent, content decoding and locked-note handling.
   Upstream uses PCS app name `notes3`; do not guess service names. Attachments and HTML rendering
   introduce additional scope. [Notes reference](https://github.com/timlaing/pyicloud/blob/main/docs/services/notes.md).
4. **Photos and other services:** separate feasibility work for assets, pagination and mutations.
   Device location/actions, sharing, alias creation and other services stay disabled until
   specifically implemented and selected in the dashboard.

Reuse the account, policy registry and bounded transport primitives. Keep each service's
protocol, consent, capabilities and acceptance evidence independent. Add every new capability
disabled by default; never enable future services through a broad stored wildcard.

## Handoff to the implementation agent

Implement the first release described in this plan: configurable Reminders and iCloud Drive,
including browse/find/read/download/upload and create/rename/move, with server-enforced dashboard
settings and a clear README. Start by reading repository instructions and verifying the current
baseline. Preserve unrelated work, existing Reminders behavior, session identity/retention and
both deployment targets. Do not rewrite authentication or import the Python runtime.

Complete the six acceptance steps in order, reporting any protocol evidence that changes a
contract before depending on it. Keep unsupported functions unavailable and describe concrete
blockers rather than silently dropping upload or organisation from v1. Use synthetic tests
until controlled live access has been authorized for a dedicated folder. Return the implemented
capability list, checks actually run, migration/rollback instructions and remaining limits.
