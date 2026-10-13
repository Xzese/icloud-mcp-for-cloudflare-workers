# iCloud Drive and service permissions

This release adds ordinary owned iCloud Drive files and folders to the same Apple account
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
filesystem path, filename, Apple URL or another account's item ID.

| Tool | Input in addition to optional `expectedGeneration` | Result |
| --- | --- | --- |
| `list_icloud_drive_items` | Optional `folderId`, defaults to Drive root | `folder`, `items`, `complete` |
| `get_icloud_drive_item` | `itemId` | `item` with current `etag` |
| `search_icloud_drive` | `query`, optional `folderId`, optional `continuation` | Matching `items`, `complete`, next `continuation` |
| `read_icloud_drive_file` | `itemId`, optional `encoding`: `utf8` (default) or `base64`, optional `previewBytes`: 1–8192 for UTF-8 previews | `item`, `encoding`, `content`, `bytesRead`, `truncated` |
| `download_icloud_drive_file` | `itemId` | `item`, private `url`, `handleId`, `expiresAt` |
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

## File transfer limits and client support

| Transfer | Limit | How |
| --- | --- | --- |
| MCP full read/upload | 64 KiB of decoded file bytes | UTF-8/base64 response or base64 upload input |
| Text preview | Up to 8 KiB of leading UTF-8 bytes | Set `previewBytes` on the read tool/HTTP route; file must be within 64 MiB |
| Dashboard/HTTP upload | 64 MiB | Prepare metadata, then stream binary bytes |
| Private download | 64 MiB | Authenticated same-origin URL, single use, ten-minute lifetime |

An MCP download result is an application-relative authenticated URL. It is not a public share
link or an attachment automatically imported into ChatGPT. A client must retain the owner's
deployment authentication to fetch it. If your MCP client cannot do that, use the dashboard
download button. Never send Apple cookies or sign-in credentials as tool arguments.

The dashboard can browse folders, search names, create folders, preview text, upload and download files.
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

Files above 64 MiB remain eligible for ordinary metadata browsing, search, rename and move,
but content reads, previews and transfers refuse them. The MCP JSON upload request budget is
96 KiB to accommodate base64 and metadata; the file-byte cap remains 64 KiB. Oversized inline
requests direct clients to dashboard Upload or the HTTP prepare-upload/binary flow.

Uploads require exact byte size and lowercase SHA-256. The server verifies both before
finalizing the new file. File bodies are streamed and are never persisted in D1. Metadata
responses are bounded. Each content transfer has a five-minute timeout; upload operations
have a six-minute exclusive lease, capped by the saved session deadline. The dashboard hashes
file chunks before sending the file, without buffering the complete file for hashing.
Downloads are attachments, with no caching or forwarded Apple response headers. Signed Apple
URLs and upload receipts stay private.

The 64 MiB cap is 67,108,864 bytes, below Cloudflare Free/Pro’s 100 MB incoming-request
limit. Other hosting platforms may impose different limits. These are streamed transfers,
not bundled static assets. See [Cloudflare’s limits](https://developers.cloudflare.com/workers/platform/limits/).

## HTTP API

All routes require the same authenticated owner as `/mcp`. JSON POST routes require the
configured application `Origin` and `Content-Type: application/json`. Downloads also require
owner authentication; knowing a handle does not grant access.

| Route | Method and body |
| --- | --- |
| `/api/settings` | GET returns `{revision, available, settings}`; POST `{expectedRevision, settings}` |
| `/api/drive/approve` | POST `{expectedGeneration, restartApproval?: boolean}` |
| `/api/reminders/approve` | POST `{expectedGeneration, restartApproval?: boolean}` |
| `/api/drive/list`, `/lookup`, `/search`, `/read`, `/download` | POST corresponding tool input |
| `/api/drive/upload`, `/create-folder`, `/rename`, `/move`, `/operation` | POST corresponding tool input |
| `/api/drive/prepare-upload` | POST upload metadata without `contentBase64`; returns `operationId`, `uploadPath` |
| `/api/drive/uploads/<operationId>/content` | POST raw bytes, `Content-Type: application/octet-stream`, configured application `Origin` |
| `/api/drive/downloads/<handleId>` | GET a prepared download once |

For large uploads, compute the digest first, retain the operation UUID, prepare the metadata,
and POST the bytes to `uploadPath`. Do not invent another UUID after a timeout. Application
errors contain sanitized codes/messages and a request ID; inspect operation status for recovery.

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
app-library and package operations, arbitrary URL imports, recursive uploads and whole-account
indexing. Unknown protocol shapes fail explicitly. Apple may change these undocumented endpoints.

Operation secrets expire at the earlier of the Apple session's local retention deadline or
24 hours. Operation keys remain non-reusable tombstones for that generation. There are at most
1,024 operation keys per generation and 128 active transfer/search handles per owner; reconnect
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
