# iCloud Drive and service permissions

This release adds ordinary owned and supported shared iCloud Drive files and folders to the same Apple account
connection used by Reminders. Drive is **off by default**. No separate Apple password or
app-specific password is required. Drive uses Apple's undocumented web protocols. Synthetic
protocol tests and a live acceptance run on one retained Apple account cover the operations
below, including a full 64 MiB transfer. **Drive remains experimental; these checks do not
establish compatibility with every account or every failure scenario.**

## Enable the services you want

1. Apply the additive database migrations below and deploy the updated application.
2. Sign in as the deployment owner and open **Services** on the dashboard.
3. Save the service and operation permissions you want. For a Drive-only connection, turn
   Reminders off before connecting Apple.
4. Connect your Apple account if necessary. Use **Approve Drive access**, approve Apple's
   request on your trusted device, and then **Check Apple approval**. Service consent is
   independent: working Reminders access does not imply working Drive access.
5. Refresh your MCP client's tools if it caches them. Test browsing a disposable folder first.

Changing preferences does not send an Apple approval prompt. Status polling and `tools/list`
are local reads. Apple may deny web access or ask for renewed approval. A saved preference
only expresses what is allowed; the dashboard separately shows whether the account and service
are ready. If a legacy session has no Drive discovery, explicit approval first attempts a
bounded account refresh when `APPLE_SESSION_RENEWAL_ENABLED=saved-tokens-v1` is configured.
Enable that existing saved-token renewal option for a retained connection, or reconnect if
renewal is unavailable. Do not change the saved encryption keys or clear the session database.

Common configurations:

- **Reminders only:** keep the Reminders defaults and leave Drive disabled.
- **Drive browsing and downloads:** enable Drive, browse and contents; leave upload and
  organise off. Disable Reminders if you do not want its tools.
- **Drive with uploads and organisation:** enable Drive and browse, then upload and organise.
  Add contents only if the agent should also be able to read/download existing file bytes.

| Setting | Default | Grants |
| --- | --- | --- |
| Reminders enabled | On | Makes selected Reminders operations available |
| Reminders read | On | Lists, reminders, search, previews and job status |
| Reminders write | On | Supported Reminders mutations and job execution |
| Drive enabled | Off | Makes selected Drive operations available |
| Drive browse | Off | Folder listings, exact metadata, name search and operation status |
| Drive contents | Off | UTF-8/base64 reads and private downloads |
| Drive upload | Off | Add new files; does not require contents permission |
| Drive organise | Off | Create folders, rename and move ordinary files/folders |

Drive browse is a prerequisite for its other groups. Permissions apply to MCP, HTTP and
dashboard actions. Disabled tools disappear from each new MCP tool listing; cached/direct
calls still face server checks. Preference saves use a revision check: a stale dashboard must
reload rather than replace a newer choice. In-progress work rechecks permissions and account
generation; bytes or a write already sent to Apple cannot be recalled. Disabling a service
does not erase iCloud data, revoke Apple's own web-access grant or disconnect the other service.

## Agent tools

All inputs are strict JSON objects. `expectedGeneration` is optional and pins the account
generation from `connection_status`. Use exact opaque IDs returned by the tools, never a
filesystem path, filename, Apple URL or another account's item ID. The path resolver below
accepts folder names and returns an exact ID when it can verify every parent.

| Tool | Input in addition to optional `expectedGeneration` | Result |
| --- | --- | --- |
| `list_icloud_drive_items` | Optional `folderId`, defaults to Drive root; optional `shareContext` | `folder`, `items`, `complete`, `reasons`, `counts` |
| `get_icloud_drive_item` | `itemId`, optional `shareContext` | `item` with current `etag` |
| `search_icloud_drive` | `query`, optional `folderId`, `shareContext`, `continuation` | Matching `items`, `complete`, `reasons`, cumulative `incompleteFolders`, next `continuation` |
| `traverse_icloud_drive` | Optional `folderId`, `shareContext`, `query`, `limit`, `maxItems`, `maxFolders`, `maxDepth`, `continuation` | Recursive `items` with `relativePath` and `depth`, `progress`, `complete`, `reasons`, cumulative `incompleteFolders`, next `continuation` |
| `resolve_icloud_drive_folder_path` | `path`, optional starting `folderId` (Drive root by default), `shareContext` | `status`, `reason`, resolved `folder` or `choices`, `resolvedPath`, `remainingSegments`, `parentListing`, `foldersRead` |
| `read_icloud_drive_file` | `itemId`, optional `shareContext`, optional `encoding`: `utf8` (default) or `base64`, optional `previewBytes`: 1–8192 for UTF-8 previews | `item`, `encoding`, `content`, `bytesRead`, `truncated` |
| `download_icloud_drive_file` | `itemId`, optional `shareContext` | `item`, private `url`, `handleId`, `expiresAt` |
| `upload_icloud_drive_file` | `parentId`, `name`, `operationId`, `size`, `sha256`, `contentBase64`, optional `contentType` | Operation status |
| `create_icloud_drive_folder` | `parentId`, `name`, `operationId` | Operation status |
| `rename_icloud_drive_item` | `itemId`, current `etag`, `name`, `operationId` | Operation status |
| `move_icloud_drive_item` | `itemId`, current `etag`, `destinationId`, `operationId` | Operation status |
| `get_icloud_drive_operation` | `operationId` | `operationId`, `phase`, safe `result` and `generation` |

All successful results also carry the account generation, except the upload preparation HTTP
response. Mutation results use `result.item` when confirmed. Stable UUID operation keys belong
to one exact input and account generation. Using a key for different input returns `CONFLICT`.
Use a new key only for an intentionally new operation after reviewing the previous outcome.

Search is a bounded, case-insensitive name substring traversal of one selected folder tree;
it does not index your account or search document contents. A call visits up to three folders
and returns up to 200 matches, with an overall 1,000-item traversal budget. Continue with the
same root and query and the newly returned token. Tokens are single-use and expire after ten
minutes or a settings/session change. Incomplete folders or exhausted limits remain explicit;
an empty result does not prove the entire account has no matches. Listings are live pages,
not an atomic snapshot.

### Recursive listing and search

Use `POST /api/drive/traverse` or `traverse_icloud_drive` to list a selected folder's descendants.
Omit `query` for an inventory, or provide a case-insensitive filename substring to filter results.
The starting folder is excluded; its immediate files and folders have depth 1. Each returned
item includes its ordinary metadata, exact ID and optional share context, plus a relative
display path. Paths are labels, not identities or filesystem paths; use IDs for subsequent actions.

```json
{
  "folderId": "FOLDER::com.apple.CloudDocs::root",
  "limit": 200,
  "maxItems": 10000,
  "maxFolders": 1000,
  "maxDepth": 64
}
```

To search, add `"query": "invoice"`. To continue, repeat the same folder, share context,
query and limits with the returned `continuation`. Combine all successful pages. An empty
page can still have a continuation. A successfully advanced cursor is single-use; it expires
after ten minutes without a successful page, a settings/account change, or session expiry.
Encrypted queue state survives Worker restarts. Failed Apple reads and failed session
checkpoints do not advance the input cursor. If a successful response is lost, its old cursor
cannot be replayed; restart the read-only traversal.

Traversal is breadth-first, with at most three folder listings and 200 returned items per call.
Each discovered `(folder ID, share context)` is listed once in a successful traversal; retries
after a failed page may reread that page's folders. Pending metadata carries across pages so
small output pages do not refetch large parent listings. `progress` reports cumulative inspected
`visited` items, `foldersVisited`, returned matches, and `queuedFolders` still awaiting processing.
The traversal inspects names and metadata, not file contents, and does not build an account index.

Defaults are 10,000 inspected items, 1,000 discovered folders including the starting folder,
and depth 64; upper bounds are 100,000 items, 5,000 folders and depth 64. `limit` is 1–200.
Limits apply to the entire traversal, not just matches. Item exhaustion ends the traversal;
folder/depth limits skip additional branches while already queued work can continue. Reasons
include `traversal_item_limit`, `traversal_folder_limit`, `traversal_depth_limit` and
`traversal_state_limit` (the shared 512,000-byte plaintext encryption budget). `continuation_required` marks
remaining work. `complete` is true only after all discovered work finishes without omissions
or limits; cumulative `incompleteFolders` preserves Apple's listing diagnostics through the final page.

Apple's per-folder 1,000-item boundary and unsupported entries still apply. Continuations
cannot recover children omitted by Apple. Successful pages keep referenced shared contexts
alive for the same ten-minute inactivity window; expired contexts are never revived. Concurrent
native edits can change later pages: the result is a live traversal, not an atomic snapshot.

### Incomplete listings and missing shared folders

Listings return all applicable `reasons`; `complete: true` has an empty array.

| Reason | Meaning |
| --- | --- |
| `missing_direct_children_count` | Apple omitted a valid nonnegative integer `directChildrenCount`; completeness cannot be proved. `numberOfItems` includes descendants and is not a substitute. |
| `upstream_count_mismatch` | The received child count differs from Apple's direct-child count. This identifies an upstream gap or inconsistency, without claiming that a pagination protocol is supported. |
| `item_limit` | The response contained more than 1,000 children; only the first 1,000 were processed. |
| `excluded_shared_entries` | Shared entries lack a supported sharing descriptor or inherited scope and were excluded. Supported shared entries are included. |
| `excluded_app_library_entries` | Returned app libraries/containers were excluded. |
| `excluded_other_zone_entries` | Other entries outside the ordinary CloudDocs zone were excluded. |

`counts` reports `expected` (Apple's direct count, or `null`), `received` (raw response
children), `processed` (at most 1,000), `returned` (visible supported entries), `excluded`,
`excludedShared`, `excludedAppLibrary`, `excludedOtherZone`, and `unprocessed`. Exclusion
categories count each processed entry once, prioritising unsupported sharing metadata, then app library, then other
zone. Entries beyond the local limit are counted only as `unprocessed`.
Thus `processed = returned + excluded` and `received = processed + unprocessed`.
These counts describe this response; they do not count shared entries Apple never sent.

Search returns cumulative per-folder listing reasons and counts in `incompleteFolders`,
including across continuations. Its `reasons` also distinguish `continuation_required` from
`search_item_limit` (the overall traversal budget). A still-valid handle created before these
diagnostics were available can report `listing_details_unavailable`. A continuation walks
only already-discovered folders: it cannot recover a child omitted from Documents.
Concurrent session operations can return retryable `CONFLICT`; a search rejected before
acquiring the session lease does not consume its continuation.

For a known folder path, call:

```json
{"path":"Documents/Snap Heaven/01/FY 2026"}
```

The resolver reads only the parent at each level, with up to 64 segments and 4,096 path
characters. Paths use single forward slashes without leading/trailing slashes, empty segments,
dot segments, backslashes or control characters. Spaces inside folder names are preserved.
Optional `folderId` starts relative to an already-known folder, such as Documents.
Matching prefers exact names, then Unicode NFC equivalence, then locale-independent lowercase
NFC equivalence. Accents and compatibility characters are not discarded. Multiple matches at
the preferred tier return `status: "ambiguous"`, `reason: "ambiguous_name"`, and exact folder
`choices`; choose an ID explicitly rather than guessing. Files never match folder segments.

`status: "resolved"` returns the final folder and actual matched `resolvedPath`.
`status: "not_found"` with `reason: "folder_not_found"` is returned only after a complete
parent listing contains no matching folder. An incomplete parent always returns
`status: "unresolved"`, `reason: "parent_listing_incomplete"`, its diagnostic `parentListing`,
the verified prefix and remaining segments, even if an exact name is visible. This also
applies to an incomplete Drive root; an explicitly known starting folder ID can avoid that
root lookup. The final folder's own contents are not listed or certified complete by resolution.

### Shared-folder reads

Supported shared folders such as Snap Heaven are included in ordinary parent listings.
The connector recognises CloudDocs `SHARED_FOLDER` roots, `FOLDER`/`FILE` identities and their
`FOLDER_IN_SHARED_FOLDER`/`FILE_IN_SHARED_FOLDER` variants. It sends Apple's sharing descriptor
with scoped metadata requests and inherits it when Apple omits it from descendants. Nested
folder walking and search continuations retain each branch's own share context.

Shared items include an opaque UUID `shareContext`. Pass that value alongside `folderId` or
`itemId` to list, look up, resolve, search, read or download inside the share. For example,
resolve `Snap Heaven/01/FY 2026` from the known Documents `folderId`, then use the final folder's
`id` **and** `shareContext`. The dashboard carries this context automatically. Repeat the
starting `shareContext` when continuing a search started inside a share. A root-based search
retains discovered share contexts internally.

Sharing descriptors and owner record names stay encrypted in the existing `drive_handles`
table; no database migration is required. References are reusable for ten minutes, capped by
session expiry, and bound to the authenticated owner, Apple account, generation and settings
revision. An expired reference returns `CONFLICT`; browse the shared parent again. Repeated
listings reuse a context per share, including when the active-handle budget is full. Shared
contexts count toward the existing 128-handle budget. Distinct shares remain distinct even
when provider item IDs coincide.

Content reads use Apple's owner-scoped download endpoint for indirectly shared files when
Apple supplies an owner. Missing owner metadata fails explicitly instead of attempting an
unscoped download. Supported package tokens download complete ZIP archives under the same
10 GiB streamed-byte cap. Packages expose `package: true` when Apple identifies their type;
inline reads, previews and range downloads are unavailable for archives. Shared access is read-only in this
connector: uploads, folder creation, renames and moves involving shared items are refused.
Successful path resolution never bypasses the complete destination listing required for
owned-item writes. For shared descendants with an Apple `item_id`, the connector stores an encrypted mapping
inside the existing share context and uses the read-only `docws /v1/item` and `/v1/enumerate`
endpoints. Shared roots with a known mapping can also fall back after a 400/404 Drive lookup.
Descendants returned without a normal Drive ID receive stable connector IDs scoped by the
share context. Apple item IDs and signed download URLs remain server-side. Mappings reuse one
handle per share, with at most 2,000 references and a 256 KB mapping budget. A complete parent
listing still requires a direct-child count: enumeration without one reports
`missing_direct_children_count`, so path resolution remains unresolved even when children are
visible. Upstream pagination is still unsupported; an omitted child cannot be recovered by a
traversal continuation.

Protocol references: [rclone’s unmerged shared-folder PR #9487](https://github.com/rclone/rclone/pull/9487), [pyicloud's shareID request and owner-scoped download implementation](https://github.com/timlaing/pyicloud/blob/1b340462f3e3c8177b907e612d4713543bb1201b/pyicloud/services/drive.py)
and [iFetch's descendant-context regression notes](https://github.com/roshanlam/iFetch/blob/master/docs/shared-folder-validation.md).
The shared-folder behavior is covered by synthetic client, service and Worker tests. The deeper
live pass below also verifies shared metadata listing and traversal. Owner-scoped shared
content downloads and `docws` fallback remain covered by synthetic tests rather than that pass.

## File transfer limits and client support

| Transfer | Limit | How |
| --- | --- | --- |
| MCP full read/upload | 64 KiB of decoded file bytes | UTF-8/base64 response or base64 upload input |
| Text preview | Up to 8 KiB of leading UTF-8 bytes | Set `previewBytes` on the read tool/HTTP route; file must be within 10 GiB |
| Direct HTTP upload | 64 MiB | Prepare metadata, then stream binary bytes |
| Dashboard/multipart upload | 10 GiB | Stage 8 MiB parts in private R2, then stream to Apple |
| Experimental direct stream | 10 GiB | Browser WebSocket relays bytes to Apple without R2; no byte resume |
| Private download | 10 GiB | Authenticated same-origin URL, single use, ten-minute lifetime |

An MCP download result is an application-relative authenticated URL. It is not a public share
link or an attachment automatically imported into ChatGPT. A client must retain the owner's
deployment authentication to fetch it. If your MCP client cannot do that, use the dashboard
download button. Never send Apple cookies or sign-in credentials as tool arguments.

The dashboard can browse owned and shared folders, search names, preview text and download files.
Folder creation and uploads are available in owned folders.
Agents can also rename and move files/folders using current IDs and etags. `read` decodes text
or returns raw base64; it does not extract text from PDF, Office documents or images. Treat all
filenames and file contents as untrusted data, including instructions embedded inside them.

For a larger text file, call `read_icloud_drive_file` with `{"itemId":"<exact returned ID>",
"previewBytes":8192}` and UTF-8 encoding. The server consumes only the bounded prefix and
cancels the remaining stream. `bytesRead` counts prefix bytes consumed; `truncated` indicates
that file bytes were omitted. An unfinished final UTF-8 character is omitted rather than
replaced. A preview validates only the decoded prefix and does not verify the unread suffix
or full content length. Use an authenticated download for the complete file. Invalid UTF-8
prefixes fail explicitly; base64 previews are not supported.

Files above 10 GiB remain eligible for ordinary metadata browsing, search, rename and move,
but content reads, previews and transfers refuse them. The MCP JSON upload request budget is
96 KiB to accommodate base64 and metadata; the file-byte cap remains 64 KiB. Oversized inline
requests direct clients to dashboard Upload or the HTTP prepare-upload/binary flow.

Uploads require exact byte size and lowercase SHA-256. The server verifies both before
finalizing the new file. File bodies are never persisted in D1. Transfers have a 30-minute
budget; the exclusive Apple upload lease lasts 31 minutes, capped by the saved session.
The browser hashes files incrementally and never loads a complete large file into memory.
Downloads are streamed attachments with exact Workers fixed-length framing, no caching,
and no forwarded Apple credentials, signed URLs or private receipt fields.
Full transfers coalesce small network chunks into at most 16 MiB authorization blocks.
Before releasing each block, one primary D1 snapshot checks the pinned account/session version
and permission revision. A changed session is decrypted and revalidated before any more bytes
are released; a changed generation or revoked permission stops the transfer. This avoids
per-socket-chunk queries while keeping a 10 GiB invocation below D1's 1,000-query paid limit.
Text reads/previews retain 4 KiB blocks so a preview never consumes a large transfer block.

### Multi-gigabyte transfers on Workers and Sites

The dashboard also offers **Stream file directly (experimental)**. This sends the browser's
file through an authenticated, same-origin WebSocket into Apple's existing single-request
upload. It creates no R2 object and works without a `BUCKET` binding. The existing Upload
button retains resumable R2 staging.

Direct streaming first hashes the file incrementally and saves its original operation UUID
and metadata in tab-local session storage. `POST /api/drive/prepare-stream-upload` prepares a
distinct `stream-upload` intent and returns its same-origin `socketPath`. Connect using
WebSocket subprotocol `icloud-drive-upload-v1`, with no query parameters. The server sends
`{type:"pull", operationId, offset, bytes}` for each frame; send exactly the requested binary
bytes (up to 1 MiB), once per credit. Credits follow consumption by the Apple upload stream,
so the browser cannot queue the complete file in Worker memory. The existing 16 MiB
authorization blocks, exact length/full SHA-256 checks and encrypted mutation ledger apply.
Apple credentials, allocation URLs and private receipts remain server-side.

The server returns `{type:"result", operationId, operation}` only after saving the result;
errors use `{type:"failed", operationId, error}`. Keep the page open during streaming and
finalization. A disconnect, malformed frame, checksum failure or uncertain Apple response
retains the original operation ID and never automatically resends the Apple upload. Reselect
the original file to recover only a safe allocated intent or a durably saved receipt. An
`unknown`/`uploading`/`committing` outcome must first be inspected, not retried under a new key.
This mode has no byte-level resume or durable file copy. WebSocket gateway behavior and live
Apple transfers remain subject to live acceptance; local synthetic success does not prove them.

Run `DRIVE_LARGE_TEST_TRANSPORT=stream npm run test:drive:large` after building either target
for the 2 GiB + 17-byte direct-stream journey without an R2 binding. Standard Worker journeys
also cover malformed frames, disconnects and full-file checksum failures without unsafe replay.

The 10 GiB limit is an application ceiling, not a guarantee of that size on every deployment.
Both targets use the same R2 `BUCKET` binding. Sites provisions it from the logical
`r2: "BUCKET"` manifest entry. For standalone Workers, create a private R2 bucket and replace
`bucket_name` in ignored `wrangler.production.toml`; the generator retains this binding.
Existing metadata, downloads and direct uploads still work without R2. Multipart preparation
fails with an actionable configuration error when the binding is missing.

A large upload uses these authenticated, same-origin steps:

1. Hash the file, retain one operation UUID, and POST metadata to
   `/api/drive/prepare-multipart-upload`. The result includes `partBytes`, `uploadedParts`,
   the operation phase and its expiry. No Apple allocation or mutation happens yet.
2. POST each numbered part to `/api/drive/uploads/<operationId>/parts/<partNumber>` with
   `Content-Type: application/octet-stream` and lowercase `X-Content-SHA256`. Every part is
   exactly 8 MiB except the final part. Each request is bounded to one part, with a 60-second
   receive deadline; it does not hold an Apple metadata lease while awaiting the client.
3. Repeat preparation with the exact original metadata to resume after interruption. Parts
   may arrive out of order. Replaying an acknowledged part with identical bytes is safe;
   different bytes under an acknowledged number are refused. Account generation, settings
   revision, exact size, full-file hash and intent remain pinned by the encrypted ledger.
4. POST `{ "operationId": "<original UUID>" }` to `/api/drive/complete-multipart-upload`.
   The server seals R2 and streams its object to Apple with backpressure and full SHA-256
   verification before finalization. Keep the request connected. This Apple byte transfer
   is a single request, not resumable Apple multipart. A timeout, crash or lost Apple
   acknowledgment retains `unknown`; inspect the operation instead of starting a new key.

The dashboard retains the original metadata and operation UUID in this tab's session storage.
Reselect the same file in its original folder to resume staging after refresh. It reports
part progress, preserves the operation ID on errors, and offers **Discard staged data**.
The discard endpoint is `/api/drive/discard-multipart-upload`; it removes R2 data without
replaying or erasing the retained Apple mutation receipt. Only a confirmed result clears
staged bytes automatically. Completed Apple transfers can be replayed for their confirmed
receipt without allocating, uploading or committing again.
Discarding an uncertain Apple transfer keeps its browser record and reports that its outcome
is unresolved. It does not silently issue a replacement operation ID. Invalid or unavailable
browser storage fails explicitly before a new staged request is sent.

Staging introduces a temporary server-side copy encrypted at rest by R2. Its private object
key and multipart IDs remain in the encrypted operation envelope, never public responses.
Staging shares the operation expiry (at most 24 hours, or the earlier Apple session deadline).
New multipart preparations sweep up to 20 expired complete objects. R2 automatically aborts
incomplete uploads after seven days; a crash can leave an orphan until then. On a standalone
bucket, configure a one-day object expiration rule for `drive-staging/v1/` and an incomplete
multipart cleanup rule. On Sites, explicit discard and request-driven sweeping work without
bucket administration. If no requests arrive, expired complete objects can remain stored
until the next sweep; authorization still refuses expired operations.

Each incoming file request stays at 8 MiB, below Cloudflare's documented account-plan body
limits; streaming a single giant incoming request would not bypass those limits. Outbound
R2-to-Apple transfers and downloads do not buffer gigabytes into the 128 MB Worker isolate.
Hashing still consumes CPU: provision a paid Workers plan and appropriate CPU allowance (for paid
Workers, up to `limits.cpu_ms = 300000` in deployment configuration). Local workerd does not
prove production CPU, bandwidth, gateway timeout or runtime-restart behavior. Sites does not
publish a per-request transfer ceiling in its current documentation, so its live gateway and
CPU limits must be tested separately. No external queue, cron or background service is required.

For interrupted ordinary downloads, obtain a fresh handle and request one `Range`. Compare
the returned item identity, etag and size with the original before appending bytes. A changed
file must be restarted; each handle is single-use. The dashboard uses a native streaming
browser download, not an in-memory Blob. Automatic browser resume to the same consumed URL
is not supported. Package archives still require a complete transfer without byte ranges.

References: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[R2 multipart bindings](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2multipartupload-definition),
[ChatGPT Sites storage and usage](https://learn.chatgpt.com/docs/sites?surface=web).

Run `npm run test:drive:large` after building either target to exercise **2 GiB plus 17 bytes**
through real local workerd D1/R2 bindings and synthetic Apple endpoints. The fixture generates,
streams and hashes bytes incrementally, verifies the complete upload/download SHA-256, checks
range offsets above 2 GiB, safe part replay, durable resume, confirmed replay and R2 cleanup.
This journey passed locally on 15 October 2026 with 2,147,483,665 bytes and SHA-256
`dcf96c60a9531a5d7ba66eac1fd77a2650750d036cc2f1ebdec8fc3b04a327c6`.
The R2-to-synthetic-Apple leg completed in about 19 seconds after replacing repeated session
decryption around each network chunk with bounded, version-fenced authorization blocks.
Unit coverage additionally streams a fragmented 10 GiB download under a 1,000-query budget.
Set `DRIVE_LARGE_TEST_BYTES` to another size within 10 GiB. The standard bundle journeys also
exercise a smaller actual R2 multipart transfer on both targets. These tests never contact
Apple and do not establish live multi-gigabyte Apple/Sites support. The earlier 64 MiB live
validation below remains the last established production transfer boundary until a new live
pass is recorded.

## HTTP API

All routes require the same authenticated owner as `/mcp`. JSON POST routes require the
configured application `Origin` and `Content-Type: application/json`. Downloads also require
owner authentication; knowing a handle does not grant access.

| Route | Method and body |
| --- | --- |
| `/api/settings` | GET returns `{revision, available, settings}`; POST `{expectedRevision, settings}` |
| `/api/drive/approve` | POST `{expectedGeneration, restartApproval?: boolean}` |
| `/api/reminders/approve` | POST `{expectedGeneration, restartApproval?: boolean}` |
| `/api/drive/list`, `/lookup`, `/search`, `/traverse`, `/resolve-folder-path`, `/read`, `/download` | POST corresponding tool input |
| `/api/drive/upload`, `/create-folder`, `/rename`, `/move`, `/operation` | POST corresponding tool input |
| `/api/drive/prepare-upload` | POST upload metadata without `contentBase64`; returns `operationId`, `uploadPath` |
| `/api/drive/prepare-stream-upload` | POST upload metadata; returns `operationId`, `phase`, `socketPath` for direct streaming |
| `/api/drive/uploads/<operationId>/stream` | GET WebSocket upgrade, same origin and `icloud-drive-upload-v1` subprotocol; binary frames only on server credit |
| `/api/drive/uploads/<operationId>/content` | POST raw bytes, `Content-Type: application/octet-stream`, configured application `Origin` |
| `/api/drive/prepare-multipart-upload` | POST upload metadata; returns phase, part size and acknowledged part numbers |
| `/api/drive/uploads/<operationId>/parts/<partNumber>` | POST one binary part with `X-Content-SHA256` and configured application `Origin` |
| `/api/drive/complete-multipart-upload`, `/discard-multipart-upload` | POST `{operationId, expectedGeneration?}` |
| `/api/drive/downloads/<handleId>` | GET a prepared download once |

For direct uploads up to 64 MiB, compute the digest first, retain the operation UUID, prepare
the metadata, and POST the bytes to `uploadPath`. For larger files use the multipart flow above.
Do not invent another UUID after a timeout. Application
errors contain sanitized codes/messages and a request ID; inspect operation status for recovery.

## Read recovery and download compatibility

Metadata reads and download opening retry transient network failures and HTTP 408, 429, 500,
502, 503 and 504 at most twice. Metadata calls share an eight-second deadline including waits;
read dispatches within a client are paced at least 100 ms apart. Retries honor `Retry-After`
when the wait fits the opening budget; longer delays are returned without retrying early.
Writes, upload allocation/finalization and uploads are never automatically replayed by this
transport. Download retries stop once streaming begins.

An HTTP 423 metadata response marks only Drive approval as pending. Reads and status checks
never send a device prompt; use the existing explicit approval action. When protected storage
is enabled, an Apple approval success response is accepted only after a nonempty, unexpired
`X-APPLE-WEBAUTH-PCS-Documents` cookie applies to the discovered Drive host.

Private download GETs accept one HTTP `Range: bytes=start-end`, open-ended, or suffix range.
They return 206 with an exact `Content-Range` and validate Apple's range and total against the
pinned file metadata. Invalid/unsatisfiable ranges return 416; package ranges are refused.
Each request consumes its download handle, including invalid ranges: request a fresh handle
for each part or retry. Files still must fit the 10 GiB file cap. Apple servers that ignore the
range fail explicitly instead of returning different bytes.

Only Apple's nonstandard 330 content redirect is followed, with at most three hops, loop
rejection and the existing signed Apple content URL validation at every hop. No Apple cookies
or authorization headers are sent to the content server. Package archive sizes may differ
from their unpacked metadata sizes, so archive downloads omit the metadata `Content-Length`
and enforce the actual streamed-byte cap.

The new paths have synthetic protocol and Worker coverage. Ordinary file ranges also passed
the live acceptance run below. Live verification of shared `docws` reads, package archives
and 330 redirects remains pending.

## Interrupted operations and boundaries

The encrypted operation ledger records intent, allocation, transfer receipt and finalization
phases before any corresponding write. It does not blindly repeat an uncertain mutation.
`WRITE_OUTCOME_UNKNOWN` means Apple may have accepted a change. Inspect the same operation
and the affected folder/item; only a retained exact identity and version can confirm recovery.
Name-only matching never proves success. An incomplete upload can leave an uncommitted Apple
allocation; this release does not delete remote allocations automatically.

Renames and moves require a current etag. Writes check the destination for existing names and
refuse incomplete collision checks. Uploads allocate a new document ID and use the upstream `add_file` flow with
`allow_conflict: true`. Neither reference defines that flag's collision semantics. The
preflight check is not an atomic no-overwrite guarantee against another Apple client
creating the same name concurrently; avoid concurrent destination edits during initial testing.

Excluded: deletion/trash, replacing file contents, public sharing, shared-library mutations,
app-library operations and package writes, arbitrary URL imports, recursive uploads and whole-account
indexing. Unknown protocol shapes fail explicitly. Apple may change these undocumented endpoints.

Operation secrets expire at the earlier of the Apple session's local retention deadline or
24 hours. Operation keys remain non-reusable tombstones for that generation. There are at most
1,024 operation keys per generation and 128 active transfer/search/share-context handles per owner; reconnect
only after reviewing outstanding work if the operation limit is reached. Disconnect/reconnect
invalidates old handles and recovery scope. Local cleanup never removes iCloud files.

## Database upgrade and rollback

New deployments use `schema.sql`. Existing deployments must apply the additive migrations in
order, preserving the current database and encryption key ring:

```bash
npx wrangler d1 execute DB --remote --config wrangler.production.toml --file migrations/0002_service_settings.sql
npx wrangler d1 execute DB --remote --config wrangler.production.toml --file migrations/0003_drive_operations.sql
```

Use your deployment's actual private configuration; use `--local` for local development.
Sites operators use their platform's database/source deployment flow with the updated schema.
These migrations add tables and do not reset the existing Apple session or Reminders jobs.
Migration 0001 for Reminders jobs remains required when upgrading a database without it.
The integrated Reminders collection and workflow features additionally require pending
migrations `0004_bulk_change_jobs.sql`, `0005_connector_filters.sql`,
`0006_create_workflows.sql` and `0007_list_duplication.sql`; apply them in order using the
[Reminders upgrade guide](reminder-jobs.md#storage-migration-and-rollback).

If the settings table is absent, old Reminders defaults remain and Drive stays disabled;
saving preferences fails with an explicit migration message. Malformed stored settings fail
closed. Drive requires its operation tables before it can run.

To roll back operationally, turn Drive off in Services and stop active transfers. Keep the new
tables and encryption keys. **Do not deploy a pre-permission version as a settings rollback**:
it does not enforce saved service restrictions, and its strict session parser may reject the
new service extension. Reconnect through the older version only after deliberately accepting
its original Reminders access model. Never delete the database to resolve a migration error.

## Live acceptance evidence

On 13 October 2026, the updated local Worker reused an existing encrypted Apple session.
Saved-token renewal discovered Drive services; the owner approved Apple's separate Drive
web-access prompt on a trusted device. Reminders readiness was preserved. Test writes were
confined to a uniquely named sample folder inside an ordinary owned folder with a complete
listing; the root listing included unsupported entries and remained explicitly incomplete.

Verified against Apple:

- Root and folder browsing, exact file metadata, and selected-tree filename search.
- Folder creation and rename; file rename; file and folder moves with exact version checks.
- A 99-byte Unicode text upload, exact UTF-8/base64 reads, and a private attachment download.
- A 300 KiB binary upload through the HTTP transfer route, followed by a download with the
  same byte length and SHA-256 digest.
- Confirmed same-key upload replay, single-use download handles, and live MCP reads and
  confirmed upload replay through the registered tools.
- Restoring the original Drive-off settings blocked a prepared download and a cached read
  while Reminders remained ready.

This run corrected three gaps in the synthetic fixtures: allocation uses the exact shared
host `cws.icloud-content.com` as well as supported regional hosts; file metadata uses
`/retrieveItemDetails` with an object containing `items` and an `items` response envelope;
upload commits identify their parent by its opaque document ID. The implementation still
binds transfers to the saved account, checks exact returned identities, and withholds cookies
from content hosts. Regression tests now include these observed wire shapes.

Early upload attempts retained `unknown` operation records and were never replayed under
replacement keys. Subsequent intentional tests used distinct sample filenames. The initial
run did not test concurrent native edits, deletion, shared libraries, packages or recovery
after a process crash. Disposable test items are retained for owner inspection.

The subsequent boundary pass on the same date verified empty HTTP files, exactly 64 KiB
through MCP, rejection at 64 KiB plus one byte, an 8 KiB preview that cuts through a UTF-8
character, a full 25 MiB HTTP upload/download with matching SHA-256, a bounded preview of
that large file, and rejection of upload metadata at 25 MiB plus one byte. Full inline reads
above 64 KiB return actionable preview/download guidance. The pass also disconnected a
partial upload and held another partial upload until transport failure; both retained
uncertain operation records without proceeding to finalization.
The original Drive-off preferences were restored after this pass.

The local account subsequently became disconnected without an Apple sign-in rejection in
the retained request log. The existing log does not establish why its local session record
was cleared. The owner subsequently signed in again. The local launcher now enables
30-day interactive sessions by default; the existing owner-authorised migration preserved
that new session's original verification and credentials while extending its legacy deadline
to 30 days, with zero Apple requests. Future
local validation failures emit only a fixed cause category and generation, never credentials
or decrypted session values.

The recovery pass used a private encrypted snapshot on a separate loopback port, leaving
the owner's dashboard and source session running. The test Worker was forcibly terminated
during a synthetic partial upload and restarted from its persisted state. After its operation
lease expired, replaying the original operation ID changed `uploading` to `unknown` and
returned `WRITE_OUTCOME_UNKNOWN`, without another Apple allocation or finalization request.
A client-cancelled upload likewise stayed `unknown` on replay. Neither partial sample appeared
in the complete test-folder listing. The real dashboard also rendered an 8 KiB text preview,
reported truncation, and safely omitted the unfinished UTF-8 character at its boundary.

Crash recovery during upload is now live-verified. A crash after mutation dispatch and
concurrent native edits remain unverified against Apple; synthetic recovery/version checks
cover these cases, and no atomic collision guarantee is claimed.

The 64 MiB follow-up used the real dashboard's file picker and incremental hashing path to
upload 67,108,864 synthetic bytes in the isolated test folder. Apple confirmed the exact item
in approximately 44 seconds. An authenticated HTTP download returned the same byte count
and SHA-256 in approximately 41 seconds. Upload metadata at 64 MiB plus one byte was refused
before Apple allocation; replay of the confirmed upload did not allocate or finalize another
file. An 8 KiB preview of the large file was also verified, and a cancelled download's handle
remained single-use. These measurements are from the
local Worker relay, not a deployed Cloudflare performance test.

On 14 October 2026, a read-only pass used the retained session through the centralized local
Worker. Root browsing preserved its explicit incomplete result for the upstream count mismatch
and excluded app libraries. Eighteen ordinary folders were browsed, and an exact folder lookup
was verified. The existing 99-byte test file returned identical bytes through an inline base64
read and authenticated attachment download. Reusing the download handle was refused; closed,
open-ended and suffix byte ranges returned HTTP 206 with the expected bytes, and a multiple-range
request returned HTTP 416. Reminders and Drive remained ready, with no Drive or Reminders data
writes. Local diagnostics omit filenames, document identities, signed URLs and file contents.

Centralization and a cold restart preserved the encryption key, session generation, original
device-verification time and fixed retention deadline. A live root read passed after restart.
All nine existing checkouts resolve to one protected shared store; the second current Worker was
refused even on a different port. Legacy paths contain credential-free redirects so older
launchers cannot open the newer retained session with an incompatible loader.

The bounded browse found no shared-folder or package-archive fixtures. Shared docws fallback,
package archives, HTTP 330 redirects, transient read retries and a new PCS/423 approval cycle
remain covered by synthetic tests rather than this live pass. Fresh sign-in request-context
corrections have synthetic coverage; this pass reused verified credentials instead of repeating
Apple's rejected password sign-in.

A subsequent read-only live pass verified `/api/drive/traverse` with a 100-item, 12-folder,
depth-4 budget and 20-item pages. Seven pages returned 100 metadata items after listing 11
folders; pages containing buffered metadata required no additional folder reads. The input
cursor survived a cold Worker restart. Changed-query requests were rejected without consuming
the cursor, successful-cursor replay was rejected, and a bounded name search found the selected
existing file. Relative paths, depth, cumulative progress and page sizes were checked without
logging names or identities. The final listing correctly remained incomplete because of the
root's upstream omissions and the configured scan limits. Drive and Reminders stayed ready,
and no Apple data writes were made. Shared-context retention beyond ten minutes and traversal
beyond 1,000 items are covered by synthetic regressions rather than this live pass.

A deeper metadata-only pass inspected 3,850 items across 500 folders and 169 recursive pages,
including 55 shared items and paths up to depth 5. Independent immediate-child listings of all
500 folders reproduced all 3,850 identities, names, types, parent references and relative paths
without mismatches. Parent-path checks covered 3,849 items and eight exact file lookups passed;
the independent reconciliation also covered the item whose provider parent reference did not
directly match a connector parent ID. The scan deliberately used a 500-folder discovery budget,
so its final result stayed incomplete with `traversal_folder_limit` and four upstream-incomplete
folder diagnostics; it is not a complete account inventory.

A 494-item source folder returned the same immediate contents with seven-item pages (71 pages)
and 200-item pages (three pages), fetching its parent once per traversal. Case-insensitive name
filtering, no-match search and live HTTP/MCP result parity passed. Depth, folder and item limits
were enforced. Four changed continuation scopes were refused without consuming the original
cursor; two concurrent advances produced one success and one conflict. Used and invented
cursors and invalid inputs were rejected. A separate pass certified an empty folder and a
five-file folder complete, with five one-item pages and no parent refetch, and matched the
root's incomplete counts to its direct listing. Drive and Reminders stayed ready and no Apple
data writes were made. No names, identities or file contents were logged. Package archives,
shared-context retention beyond ten minutes and induced upstream failures remain synthetic-only.
