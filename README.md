# iCloud MCP for Cloudflare Worker

<p align="center">
  <a href="https://github.com/Xzese/icloud-reminders-mcp-for-cloudflare-workers/stargazers"><img src="https://img.shields.io/github/stars/Xzese/icloud-reminders-mcp-for-cloudflare-workers?style=flat-square" alt="Stars"></a>
  <a href="https://github.com/Xzese/icloud-reminders-mcp-for-cloudflare-workers/commits/main"><img src="https://img.shields.io/github/last-commit/Xzese/icloud-reminders-mcp-for-cloudflare-workers?style=flat-square" alt="Last commit"></a>
  <a href="https://github.com/Xzese/icloud-reminders-mcp-for-cloudflare-workers"><img src="https://img.shields.io/github/languages/top/Xzese/icloud-reminders-mcp-for-cloudflare-workers?style=flat-square" alt="Top language"></a>
  <a href="https://github.com/Xzese/icloud-reminders-mcp-for-cloudflare-workers/actions/workflows/ci.yml"><img src="https://github.com/Xzese/icloud-reminders-mcp-for-cloudflare-workers/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://workers.cloudflare.com"><img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white" alt="Cloudflare Workers"></a>
  <a href="https://github.com/Xzese/icloud-reminders-mcp-for-cloudflare-workers/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT License"></a>
</p>

A remote MCP server and private dashboard for iCloud, with configurable **Reminders** and
**iCloud Drive** access. The owner chooses each service and its permissions. Reminders keeps
its existing read and write defaults. **Drive is off by default** and requires separate Apple service approval.
Deploy it through **ChatGPT Sites** or to your own **Cloudflare Worker** protected by Cloudflare
Access and Managed OAuth. No containers, Python runtime, KV namespace or Durable Objects are required.

The browser performs the Apple password proof exchange. The Worker stores Apple session cookies,
tokens, list summaries, pagination state and private Drive operation receipts encrypted with
AES-256-GCM in D1. Reminder contents and Drive file bodies are fetched on demand and are not
cached in D1. Service preferences are ordinary owner-scoped configuration.

**Experimental, unofficial integration.** This project uses Apple's undocumented web protocols,
not Sign in with Apple or an official public iCloud API. The login page is served by your deployment;
you must trust its browser code with your password input. Cryptographic reference tests are not an
independent security audit. Reminder reads and mutations use unofficial Apple protocols;
review the supported fields and limitations before using them.

## Table of contents

- [Public source, private deployments](#public-source-private-deployments)
- [iCloud service options](#icloud-service-options)
- [Tools](#tools)
- [Reminder write access](#reminder-write-access)
- [Resources and configuration](#resources-and-configuration)
- [Local setup](#local-setup)
- [ChatGPT Sites setup](#chatgpt-sites-setup)
- [Cloudflare Worker setup](#cloudflare-worker-setup)
- [Connect ChatGPT](#connect-chatgpt)
- [Connect your Apple account](#connect-your-apple-account)
- [Use the dashboard](#use-the-dashboard)
- [Direct retrieval and pagination](#direct-retrieval-and-pagination)
- [Cloudflare repository builds](#cloudflare-repository-builds)
- [Development and project structure](#development-and-project-structure)
- [Security and licensing](#security-and-licensing)

## Public source, private deployments

This repository publishes source under the MIT License. It does not provide a shared public
iCloud service. Each operator creates their own private deployment, database, access policy
and encryption keys. One deployment is restricted to one explicitly bound owner and one Apple
session. Do not configure it as a multi-tenant service or share the owner's MCP connection.

The development checkout is also the public source repository. The checked-in `wrangler.toml`
and `.openai/hosting.json` remain public templates. Keep the private Site binding in ignored
`.sites-runtime/hosting.json`; keep Worker-specific values in ignored deployment configuration
or the hosting platform. Never commit `.dev.vars`,
`.env`, `wrangler.production.toml`, `wrangler.generated.toml`, encryption keys, Apple cookies,
verification codes, session exports, real CloudKit records or signed asset URLs.
`npm run public-config:check` also rejects private/generated files accidentally tracked by Git.
Review Git history before publishing a repository that previously contained private metadata.

## iCloud service options

Only **Reminders** and **iCloud Drive** are implemented and configurable today.

| Implemented service | Available operations | Dashboard options |
| --- | --- | --- |
| Reminders | Read/search lists and reminders; create, edit, complete, reopen and delete supported reminders; supported list and organisation operations | Enable/disable; read; write |
| iCloud Drive | Browse/search folders and files; read/preview/download; upload new files; create folders; rename and move ordinary owned items | Enable/disable; browse; contents; upload; organise |

### Potential improvements

The upstream iCloud web-protocol client contains references for these additional services.
They are **potential improvements only**, not confirmed work in progress, scheduled features,
or supported options in this project. They have no dashboard switches or MCP tools here.

| Potential service | Capabilities worth investigating | Upstream evidence |
| --- | --- | --- |
| Calendar | Read calendars, date-range events and event details | [Calendar client](https://github.com/timlaing/pyicloud/blob/e2e44ab875d47dab4475096021da60030f26c35e/pyicloud/services/calendar.py) |
| Contacts | Browse contacts stored in iCloud | [Contacts client](https://github.com/timlaing/pyicloud/blob/e2e44ab875d47dab4475096021da60030f26c35e/pyicloud/services/contacts.py) |
| Photos | Browse albums/assets and download photo versions | [Photos client](https://github.com/timlaing/pyicloud/blob/e2e44ab875d47dab4475096021da60030f26c35e/pyicloud/services/photos.py) |
| Notes | Read folders/notes and export notes or download attachments; upstream reference is read-oriented | [Notes client](https://github.com/timlaing/pyicloud/blob/fb56ed6652f2d99ca8dc3cf515f7db0b319fcf1d/pyicloud/services/notes/service.py) |
| Find My | Read device inventory, status and location, with explicit controls for location access | [Find My client](https://github.com/timlaing/pyicloud/blob/fb56ed6652f2d99ca8dc3cf515f7db0b319fcf1d/pyicloud/services/findmyiphone.py) |
| Hide My Email | List, create and manage aliases where the account is eligible | [Alias client](https://github.com/timlaing/pyicloud/blob/fb56ed6652f2d99ca8dc3cf515f7db0b319fcf1d/pyicloud/services/hidemyemail.py) |

These clients can share account authentication, but each service needs its own endpoint policy,
data model, permissions, consent handling and live validation. Notes and Hide My Email were
checked at the newer upstream revision linked above, not this project's older provenance pin.
A Drive folder belonging to Notes or Mail does not establish access to notes or mailboxes.

### Configure the implemented services

Open **Services** on the dashboard to save your agent's permissions. Each service has an
on/off switch; Reminders has read/write controls, and Drive has **browse**, **contents**
(read/download), **upload**, and **organise** (create folders, rename, move) controls.
Drive browse is required for the other Drive operations. Upload does not grant file-content
reading. These choices are enforced for dashboard, HTTP and MCP calls, including cached tools.
Saved preferences and actual Apple readiness are shown separately.

To start: apply migrations `0002_service_settings.sql` and `0003_drive_operations.sql`, save
Drive permissions, connect Apple, select **Approve Drive access**, approve on your trusted
device and check approval. For Drive-only use, disable Reminders before connecting. Changing
settings or refreshing status never initiates Apple consent. Refresh your MCP client's tool
list after changing permissions.

Drive supports browsing folders, finding names within a selected folder tree, reading files,
private downloads, uploading new files, creating folders, and renaming/moving ordinary owned
files and folders. It excludes deletion, content replacement, sharing, packages and app-library
operations. Search is bounded and explicitly reports incomplete results.

- Inline MCP full reads/uploads: **64 KiB** of decoded bytes, UTF-8 or base64.
- Text previews: **8 KiB** of leading UTF-8 bytes, with explicit truncation, for files up to 64 MiB.
- Dashboard/HTTP uploads and private downloads: **64 MiB** (67,108,864 bytes), with a five-minute transfer timeout.
- Downloads require owner authentication. A returned URL is not a public share or an attachment
  automatically available to every MCP client; use the dashboard if the client cannot fetch it.
- Retain each write's UUID `operationId`. After a timeout or `WRITE_OUTCOME_UNKNOWN`, inspect
  the same operation before trying again. Never automatically use a fresh key.

**Drive is experimental.** Live checks on one retained Apple account verified browsing,
name search, reads, uploads/downloads, folder creation, rename and move on 13 October 2026.
Read [the Drive guide](docs/icloud-drive.md) for measured live transfer boundaries, every tool,
exact HTTP transfer steps, consent troubleshooting, limits, migration and
rollback instructions. The [extension research/design](docs/icloud-services-plan.md) records
upstream protocol evidence and the intended service architecture.

## Tools

Read the [MCP and API reference](docs/mcp-api.md) and [Drive guide](docs/icloud-drive.md) for **tool inputs, results,
behaviour and rationale**, including how recurring completion, reopening, deletion and
subtask actions follow the observed Apple Reminders lifecycle. The reference distinguishes
native behaviour from connector safeguards and links the supporting live evidence and limits.

| Tool | Behaviour |
| --- | --- |
| `connection_status` | Report account/service readiness, saved permissions, session generation and tool availability; does not contact Apple. |
| `list_icloud_drive_items`, `get_icloud_drive_item`, `search_icloud_drive` | Browse exact metadata and search names within a selected folder tree. |
| `read_icloud_drive_file`, `download_icloud_drive_file` | Read bounded text/base64 or prepare a private authenticated download. |
| `upload_icloud_drive_file`, `create_icloud_drive_folder` | Add new files or folders using retained operation UUIDs. |
| `rename_icloud_drive_item`, `move_icloud_drive_item` | Organise owned items using current etags. |
| `get_icloud_drive_operation` | Inspect a retained operation without replaying an uncertain write. |
| `get_reminder_lists` | Query current selectable private-zone lists directly, without historical scanning. |
| `get_reminders` | Authorize an exact `listId` live, then fetch one current page without catalogue synchronization; open reminders by default. |
| `get_all_open_reminders` | Discover selectable lists once per operation, then fetch open reminders with resumable per-list pages. |
| `get_reminder` | Read one exact ID, including completed or soft-deleted state, for current version tags and recovery. |
| `search_reminders` | Search one or all selectable private lists by title/notes text, status, flag, priority, due range, literal tags and the separate native URL with bounded continuations. |
| `get_reminder_list` | Read one exact private list and its current version, including soft-deleted state for reconciliation. |
| `create_reminder_list`, `rename_reminder_list`, `delete_reminder_list` | Create or rename standard private lists, or soft-delete a fully verified empty list. |
| `get_reminder_list_appearance`, `update_reminder_list_appearance` | Read native appearance or set a built-in colour and/or emoji using the current List version. |
| `get_shopping_categories`, `set_reminder_category` | Read materialised Shopping categories, including empty categories, or move an ordinary item to an existing category using exact reminder/List/category versions. |
| `get_reminder_organization` | Read the separate native URL and literal tag names without exposing raw assets. |
| `set_reminder_url`, `set_reminder_tags` | Replace/clear the selected reminder's URL or complete tag selection atomically. |
| `move_reminder`, `copy_reminder` | Transfer an undated ordinary childless root between owned private standard lists with exact source/List versions. |
| `create_reminder` | Create one open reminder using a stable UUID `idempotencyKey`. |
| `create_subtask`, `set_reminder_parent` | Create an undated child or attach, reparent or return a simple reminder to top level in the same list. |
| `update_reminder` | Edit specified fields of one open reminder using its current `recordChangeTag`. |
| `complete_reminder` | Complete an ordinary reminder/family, or advance a supported recurrence and return completed occurrence history. |
| `reopen_reminder` | Reopen an ordinary reminder/family, independent occurrence history or a supported final daily/weekly occurrence at its end date. |
| `delete_reminder` | Follow native detach/cascade deletion, or explicitly skip one supported recurring occurrence or retire all future occurrences. |
| `prepare_reminder_update` | Preview an exact simple edit or supported timed recurring/absolute-alarm date update. |
| `create_reminder_job`, `append_reminder_job_items` | Stage encrypted, bounded immutable bulk manifests with stable UUID keys. |
| `preview_reminder_job`, `start_reminder_job` | Seal/review and accept a manifest without executing Apple mutations. |
| `get_reminder_job`, `cancel_reminder_job` | Read ordered progress or stop future dispatch; cancellation is not rollback. |
| `resume_reminder_job`, `continue_reminder_job` | Resume the same authorized scope and execute/reconcile at most three items per request. |

Tools return `structuredContent` plus a text copy for client compatibility. Every tool advertises
a typed output schema for successful results and describes its parameters in the input schema.
Application failures return `isError: true` with a
sanitized error object and matching JSON text, including recovery IDs when a write is uncertain.
Use `structuredContent.error.code`, `retryable` and `requestId` for connector diagnostics.
The hosted adapter can rewrite the outer `error_code` to `INVALID_ARGUMENT` even when the
raw MCP response carries a specific protocol or conflict code; the nested code remains intact.
Read tools are marked read-only; Apple-facing tools use `openWorldHint: true`. Creation is additive,
while editing, completion, reopening and deletion are marked destructive. All mutation tools
use `idempotentHint: true`: identical creation inputs reuse the same UUID, and existing-item writes
cannot apply twice with the same version tag. A repeated request can return `CONFLICT`; idempotency
does not promise repeated success or authorize a new request with a fresh tag.

Use the IDs returned by `get_reminder_lists`. `get_reminders` accepts `includeCompleted`, `limit`
(1–200) and its returned
`continuation`. An all-open result with `complete: false` may include a separate opaque continuation;
call `get_all_open_reminders` again with that value and combine the returned records. Inspect errors
before retrying and respect any `retryAfterSeconds`. A partial result is not the entire collection.

Search reads one live Apple page per call. An empty result can still have a continuation;
repeat the same filters and newly returned single-use token until `complete` is true. Omitting
`listId` fixes the discovered owned private list selection for that search. Pages do not form
an immutable snapshot. Native tag/URL filters are available; synced custom Smart Lists are not implemented.

Organization changes use native linked URL and tag records, preserving unrelated content.
Shopping moves update Apple's native category membership, item ordering and grocery-learning
correction, so later copies of the same product title follow the manual choice. Category reads
use a category-only metadata feed and can require multiple pages; only the selected list's
categories are returned. See [the Shopping tool contracts and limits](docs/mcp-api.md#shopping-categories).
Moves preserve identity; copies create a new reminder plus new URL/tag identities, with title
and notes copied as plain text. Transfers exclude schedules, recurrence, alarms, descendants,
assignments, sections and other attachments. Copy keys and request/content hashes are stored
in the encrypted session before dispatch so an uncertain response can be reconciled with the
same key and inputs. Replayed copies perform no write, even after guard versions advance;
changed copied content or reused keys with different inputs conflict. Read the
[capability map and remaining limits](docs/native-reminders-parity.md) for the broader backlog.

## List management

The MCP tools `get_reminder_list`, `create_reminder_list`, `rename_reminder_list`, and `delete_reminder_list` manage standard owned private lists. Creation, rename and empty-list deletion were verified through the live Apple Reminders app. Deletion requires explicitly empty membership, complete checks including completed reminders, and the current name and version tag. Review the native protocol, reconciliation rules and concurrent-membership limit in [docs/list-management.md](docs/list-management.md).

## Reminder write access

Creation, editing, completion, reopening and soft deletion are available to the authenticated
owner once the Apple session is ready, in both deployment modes and the local launcher. There
is no separate write approval flag. Review [the write protocol and limitations](docs/write-access.md).
`connection_status` reports `writeEnabled` and the create/update/complete/reopen/delete
capabilities based on the current connection state.

[Durable jobs](docs/reminder-jobs.md) use authenticated continuation on both deployment targets.
Simple bulk creation is a normal ready-account capability once the additive job schema is
installed; no feature flag is required. Timed absolute-alarm date updates, including the active
occurrence of a recurring reminder, are also permanent ready-account capabilities.
Bulk deletion of simple reminders is permanent too: each item gets the single-delete exact-version and
subtask checks, and a subtask attached natively during commit is reported, not cascaded.
Only `continue_reminder_job` advances a job; status and start requests do not execute Apple
writes. No Cloudflare Queue or cron runner is used. See
[the linked-date recipe and live evidence](docs/linked-record-protocol.md#permanent-in-place-absolute-date-updates)
for exact scope, preservation rules and remaining unsupported transitions.

Use `get_reminder_lists` to select a list and `get_reminders` to obtain reminder IDs and current
version tags. Creates need a new UUID `idempotencyKey` for each distinct reminder; reuse that
same key and content after an uncertain result. Updates need the last-read `recordChangeTag`
and a nonempty `changes` object. `get_reminder` reads the exact current item, including completed
or soft-deleted state, without scanning history. Only specified fields change. Supported fields are title, notes,
priority, flag, due date, time zone and all-day status, plus bounded custom recurrence creation,
editing and removal, early reminders and location alarm creation, editing and removal. Scheduling updates support
one absolute date alarm, optionally one location alarm and one known recurrence. Date moves also preserve
Apple's acknowledged early-alert metadata and the observed monthly final-selection rule for days 28/29;
editing that acknowledgement-bearing offset or special recurrence still requires a separate native recipe.
Linked date clearing and explicit
timed/all-day conversion retire the old date-alarm pair atomically. Subtask scheduling guards
the exact open parent in the same list. See [supported recipes](docs/linked-record-protocol.md)
for required inputs and refusal boundaries. Completion and reopening support ordinary one-level
families with the known family and List guarded in one atomic group. Parent completion completes
open children; reopening restores only children completed with that parent, preserving independently
completed children. A child action changes only the selected child. `affectedRecords` identifies
changed reminders. Recurring, early/location-alarmed and deeper families remain excluded;
ordinary members can have one supported absolute-date pair. Direct deletion
detaches the selected reminder from its List and parent; parent deletion soft-deletes its
children while preserving their native links and completion state. Exact reads of a detached
deleted reminder return `listId: null`. No hard-delete or restore tool is exposed.
Root-only recurring completion supports interval-one timed weekly recurrence, optionally with
one absolute date alarm, all-day daily recurrence and the observed last-day monthly pattern.
The active ID remains open at its next calendar due date; `completedOccurrence` returns fresh
completed history at the old date. Weekly alarm pairs are replaced separately for the active
record and history. Retain the original ID/tag arguments: durable occurrence intents reconcile
uncertain acknowledgements by exact reads without creating another history. An all-day daily
interval-one root with an inclusive end calendar date, or a timed interval-one weekly root
ending on its exact local cadence, completes its final occurrence in place, returning no
history, and can reopen at that same date. Daily end instants outside midnight UTC require
the explicit `recurrenceCalendarTimeZone`; timed weekly rules use their stored zone.
Recurring deletion requires explicit `occurrence` or `all_future` scope and has its own
bounded daily, weekly and last-day monthly recipes. These distinctions match the observed
native app; see the [recurring lifecycle explanation](docs/mcp-api.md#recurring-reminders-why-completion-can-leave-a-reminder-open).
Other end conditions, overdue
skipping and recurrence patterns still require separate recipes.
A complete bounded family inspection fails closed on read errors or
unfinished pagination. Observed native additions advanced root/List versions, but universal
protection against unreferenced native additions remains unproven. See
[native lifecycle evidence](docs/lifecycle-protocol.md). Bounded ordinary move/copy is described
in [the parity contracts](docs/native-reminders-parity.md); arbitrary linked-record editing and
recurrence anchor changes remain excluded. New early reminders use an exact-version
witness from another native early reminder in the same list to obtain Apple's account metadata;
the connector never derives that identifier from credentials or zone owners.

The `create_subtask` and `set_reminder_parent` tools create undated children, move a
simple childless reminder under a root, reparent it or return it to top level.
They are permanent ready-account capabilities; `capabilities.subtasks` reports session availability.
They require same-list, open, undated, non-recurring/un-alarmed nodes and exact child/destination
tags, with affected parents guarded in one atomic group. Relationship changes refuse deeper
nesting; family lifecycle uses the separate native recipes described above. Simple bulk-create
jobs still reject parent inputs. Ordinary and subtask creation atomically append their
identities to native List ordering. Lifecycle inspection resolves query and ordering identities
exactly before planning, covering committed children hidden by query-index lag. List and parent
version guards reject changes after inspection, including concurrent connector List deletion. See
[subtask contracts and limits](docs/write-access.md#subtask-relationships).

`CONFLICT` requires a fresh read and review. `WRITE_OUTCOME_UNKNOWN` means Apple may have saved
the change: read the indicated reminder before retrying, and never choose a new creation key
for that attempt. No mutation tool automatically retries writes or bypasses version conflicts.
Use a dedicated test reminder for your first live test. The [local acceptance procedure](docs/write-access.md#local-live-acceptance)
includes a command that creates, edits, completes, reopens and deletes only its own test item.

## Resources and configuration

| Resource | ChatGPT Sites | Standalone Cloudflare |
| --- | --- | --- |
| Worker and HTTPS origin | Created and managed by Sites | Create a Worker; use its Access-protected hostname or a custom domain. |
| D1 database, binding `DB` | Declared in `.openai/hosting.json`; Sites provisions it and applies the packaged current schema. | Create D1, configure its UUID and execute `schema.sql`. |
| Owner authentication | Sites' dispatch-owned ChatGPT sign-in and Site-scoped identity | Cloudflare Access application, restrictive policy and Managed OAuth; Worker verifies Access JWTs. |
| Encryption | Operator-provided Worker secret | Operator-provided Worker secret |
| MCP registration | Site-hosted plugin at `/mcp` | Register `/mcp` as a custom OAuth MCP connection. |

No R2 bucket, Workers KV, Durable Object, Apple developer application or OpenAI API key is
used by this implementation. Your Cloudflare plan must support the CPU/memory needs of login
cryptography, streamed file hashing and your Access configuration; validate those limits in your deployment.

| Runtime setting | Purpose |
| --- | --- |
| `APP_ORIGIN` | Exact HTTPS origin, without a path or trailing slash. |
| `REMINDERS_OWNER_ID` | Exact authenticated principal, obtained through `/api/bootstrap/identity`; never auto-claimed. |
| `ENCRYPTION_KEY_ID` | Active key name, for example `primary`. |
| `ENCRYPTION_KEYS_JSON` **secret** | JSON key ring, for example `{"primary":"<32-byte base64 key>"}`. |
| `LIVE_APPLE_CONNECTION_APPROVED` | `controlled-device-v2` enables the operator-approved account test. |
| `APPLE_CRYPTO_REVIEW_APPROVED` | `device-proof-v2` acknowledges the operator's review of the browser proof protocol. |
| `APPLE_SESSION_RETENTION_WRITES` | `absolute-30d-v1` enables new 30-day interactive sessions **after** all readers are compatible. Empty keeps the compatibility writer on version 2. |
| `APPLE_SESSION_RETENTION_MIGRATION_JSON` **private setting** | One-time server approval with `migrationId`, `owner`, `account: "apple-reminders"` and the eligible `generation`. Disabled by default; never obtain scope from a request body. |
| `APPLE_SESSION_RENEWAL_ENABLED` | `saved-tokens-v1` enables bounded request-driven validation and saved-token exchange, independently of migration. Disabled by default. |
| `APPLE_SESSION_CHECK_INTERVAL_MS` | Our engineering check interval, default `21600000` (six hours); supported range five minutes–24 hours. Not an Apple validity guarantee. |
| `TEAM_DOMAIN` | Standalone only: `https://<team>.cloudflareaccess.com`. |
| `POLICY_AUD` | Standalone only: Access application's audience tag. |

The two Apple login approval settings default to empty. They are operator acknowledgements, not a review
or audit performed by the software. Do not enable them before reviewing the trust boundary and
accepting the account connection. A ready authenticated Apple connection enables reads and the
supported reminder mutations.

## Local setup

Use Node.js **24 or later**, npm and the locked dependencies:

```bash
git clone https://github.com/Xzese/icloud-reminders-mcp-for-cloudflare-workers.git
cd icloud-reminders-mcp-for-cloudflare-workers
npm run install:ci
node scripts/setup/create-local-env.mjs
npm run build
npm run db:setup:local
npm run dev
```

Open `http://127.0.0.1:5173/`. This loopback-only development preview uses a synthetic ChatGPT
identity and leaves live Apple login disabled. The environment helper creates an ignored private
`.dev.vars` with a random local encryption key and refuses to overwrite an existing file.
The database setup command executes `schema.sql` against the local preview database. Its
`CREATE TABLE IF NOT EXISTS` statement allows setup to be repeated without clearing session data.

For an explicitly approved live account investigation using the existing dashboard:

```bash
npm run build
npm run dev:icloud
```

The local launcher enables new 30-day sessions by default. Their deadline is fixed from
device verification; saved-token renewal does not extend it. Set
`APPLE_SESSION_RETENTION_WRITES=` explicitly only to test the legacy one-day writer.
Existing one-day sessions require the owner-authorised retention migration described below.
Both the launcher and migration accept `LOCAL_ICLOUD_STATE_DIR` to reuse an existing private
state directory and its keys without creating a replacement login.
`LOCAL_ICLOUD_PORT` selects a different loopback port (default `5173`); pass the same port
to the migration command so it can check that the server is stopped.

The live launcher creates a separate encrypted local session and explicitly enables the controlled
login protocol. It listens only on IPv4 loopback, enforces a private local cookie and strips supplied
identity headers. It must remain running for local access and its automatic checks. Disconnect clears
the stored session. Its ignored `.sites-runtime/local-icloud/` is private account state, not a fixture.

Local tests and CI use synthetic data and do not require an Apple account.

The normal local launcher supports reminder changes after sign-in. Use a dedicated test reminder
for the acceptance procedure in [the write documentation](docs/write-access.md#local-live-acceptance).
The diagnostic command
`node scripts/dev/inspect-local-icloud.mjs write-shapes` performs bounded reads and reports only
field types/version presence; it does not submit a write or print reminder contents.

## ChatGPT Sites setup

You need ChatGPT Sites access and its Site-hosted MCP/plugin capability. The platform owns the
Worker, D1 binding, ChatGPT sign-in, MCP connection and publication. Do not deploy its generated
configuration with Wrangler as a substitute for Sites publication.

1. Make this source available to a Sites-capable coding session. Ask it to create a **new private
   Site** from this repository with D1 binding `DB` and MCP capability. The public manifest starts
   without a `project_id`; the platform must register your Site. Save its exact returned identifier
   in ignored `.sites-runtime/hosting.json` as `{"project_id":"<your-project-id>"}`.
   Reuse that identifier for later updates. Never copy another operator's project ID.
2. Keep `.openai/hosting.json` configured with `"d1": "DB"` and `"capabilities": ["mcp"]`.
   Have the Sites-capable session open the Site's private source checkout in
   `.sites-runtime/sites-source` through the native Sites workflow. Run `npm run sites:prepare`
   from the main checkout to copy the current public source and add the private binding there.
   Build and publish **from that generated checkout** through the Sites source/version workflow,
   including the complete build output. The helper can reuse the main checkout's installed
   dependencies; otherwise install them in the generated checkout. Edit application code in
   the main checkout, and reconcile any unsaved Site-source changes before preparing another copy.
   The build packages `schema.sql` in Sites'
   expected SQL initialization layout; Sites provisions the logical D1 binding and applies it.
   Fresh-install `schema.sql` and the additive SQL migration need no Drizzle installation or migration generation.
3. Obtain the published HTTPS origin. In the Site's runtime settings, set `APP_ORIGIN` to that exact
   origin and `ENCRYPTION_KEY_ID` to `primary`. Generate the key ring locally:

   ```bash
   node scripts/deploy/create-encryption-key.mjs primary
   ```

   This output is a secret. Enter it directly as the Site secret `ENCRYPTION_KEYS_JSON`; do not
   paste it into chat or commit it. Keep both Apple approval settings empty at this stage.
4. Open the private Site and **Sign in with ChatGPT**. Use **Copy Site identity**, or open
   `/api/bootstrap/identity`, and bind the returned `authenticatedUserId` as `REMINDERS_OWNER_ID`
   in the Site runtime settings. This identifier is scoped to that Site. Refresh the dashboard.
5. Review the login protocol and security policy. If you approve the controlled test, set the two
   Apple approval settings to the exact values in the configuration table. Environment changes
   must be activated by the platform's environment/deployment workflow. Complete Apple setup as
   described below; verify the hosted connection and a small read before wider use.
6. Open the Site's plugin connection settings. Install and connect its generated plugin in ChatGPT,
   then choose it in a new chat. The endpoint is `https://<your-site>/mcp`. Sites manages the MCP
   OAuth connection; its non-user service token is not a substitute for the owner's identity.

List and all-open MCP calls discover current lists directly. No historical scanning or scheduled
refresh is required. Dashboard polling reads the encrypted saved snapshot without contacting Apple.

## Cloudflare Worker setup

### 1. Create the Worker and database

Use your own Cloudflare account and Zero Trust organization. Copy the public configuration:

```bash
npx wrangler login
cp wrangler.toml wrangler.production.toml
npx wrangler d1 create icloud-reminders
```

In `wrangler.production.toml`, set your Worker `name` and the returned D1 `database_id`; retain
binding `DB`. Set `APP_ORIGIN` to your intended Worker HTTPS origin.
Keep Apple login disabled and owner identity empty. The generated Worker name determines the
`*.workers.dev` hostname; a custom-domain deployment must use that exact domain as `APP_ORIGIN`.

```bash
npx wrangler d1 execute icloud-reminders --remote --config wrangler.production.toml --file schema.sql
npm run deploy:cloudflare
```

The first deployment intentionally rejects requests until Access is configured. The build uses
`src/index.ts`, not the Sites-only entrypoint, and routes static assets through the verified Worker
before serving them. `wrangler.production.toml` and the generated config are ignored by Git.

### 2. Configure Cloudflare Access and Managed OAuth

1. Create an Access application covering the **entire Worker hostname**, including the dashboard,
   `/api/`, `/connect/apple`, authentication WebSockets and `/mcp`. Use a self-hosted application
   with Managed OAuth, or the current MCP application flow in your Cloudflare dashboard.
2. Restrict its Allow policy to the single intended owner. Configure your identity provider and
   MFA. Do not use a public Allow-all or Bypass policy.
3. Enable **Managed OAuth** for the application and allow only redirect URIs needed by your MCP
   clients. This makes Access's OAuth flow available to ChatGPT while the browser uses Access
   sign-in. Do not replace the assertion with a shared bearer token.
4. Copy the team domain and application AUD into `TEAM_DOMAIN` and `POLICY_AUD` in your ignored
   production config. Cover every reachable hostname with Access. Disable unused `workers.dev`
   routes if using a custom domain; preview URLs are disabled by the generated configuration.
5. Redeploy with `npm run deploy:cloudflare`.

The Worker independently verifies the signed `Cf-Access-Jwt-Assertion`, issuer, audience, validity
and owner identity before API, dashboard or WebSocket routing. Client-supplied ChatGPT identity
headers are removed. Managed OAuth tokens are opaque; Access resolves them at the edge and
forwards a signed user assertion. The Worker does not treat an arbitrary OAuth bearer as a JWT.

See Cloudflare's [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
and [JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
guides for current application setup and token behaviour.

### 3. Bind your owner and install encryption

Sign in through Access, then open `https://<worker-host>/api/bootstrap/identity`. Copy the verified
`authenticatedUserId` into `REMINDERS_OWNER_ID`. The server never claims the first visitor as owner.
Other routes remain unavailable until this binding is configured.

For a **brand-new** deployment, install the key ring without writing it to a file:

```bash
node scripts/deploy/create-encryption-key.mjs primary | npx wrangler secret put ENCRYPTION_KEYS_JSON --config wrangler.production.toml
```

Set `ENCRYPTION_KEY_ID` to `primary`. Do not replace the key ring on an existing deployment: existing
sessions need their original key. Keep previous keys available during intentional rotation, or
explicitly disconnect sessions before removing their keys.

After reviewing the browser proof protocol and approving a controlled account test, set
`LIVE_APPLE_CONNECTION_APPROVED` and `APPLE_CRYPTO_REVIEW_APPROVED` to the values in the table,
then deploy:

```bash
npm run deploy:cloudflare
```

Open `https://<worker-host>/` and complete the Apple setup below. Verify Access denial for an
unauthenticated request, correct owner binding, device verification and a controlled reminder read
on your actual deployment. Synthetic tests do not prove the deployed Access policy or Apple flow.

## Connect ChatGPT

For a standalone Worker, add this endpoint as a custom OAuth MCP connection:

```text
https://<worker-host>/mcp
```

Enable developer/custom MCP connections where available in your ChatGPT account, create the
connection using the endpoint and **OAuth**, and complete Cloudflare Access sign-in. ChatGPT UI
labels and account availability can change; use the current custom plugin/app connection flow.
Choose the connection in a new chat and ask it to call `connection_status`, then
`get_all_open_reminders`. For ChatGPT Sites, use the generated Site plugin instead.

Never send your Apple password, device code, encryption keys or cookies to the chat or an MCP tool.

## Connect your Apple account

1. Open your own private deployment and select its iCloud connection action. The dedicated
   credential page opens at `/connect/apple`; it is your project's page, not an Apple OAuth page.
2. Enter your Apple Account and password there. The browser derives authentication proofs; the
   application API does not accept the raw password or password-derived keys.
3. Read and accept the remembered-browser and encrypted-session consent statements. Apple's
   remembered trust may last longer than this application's local session limit.
4. Approve the trusted-device prompt and enter the six-digit code **on the credential page** when
   its code field appears. SMS, voice and legacy device-code fallbacks are not supported.
5. Return to the dashboard. If Apple separately requires web access to your Reminders keys,
   approve that request on your device. The dashboard checks approval automatically while visible,
   respecting Apple’s retry time. **Check Apple approval** remains available if automatic checks
   pause after repeated errors or their safety limit. Device verification and Reminders-data
   approval are separate steps.
6. Confirm the session is ready, then use a reminder MCP tool. Known-list reads verify access and
   fetch reminders directly. List discovery uses the direct query described below.

The approved local application session lasts at most **30 days from the original device verification**:
`expiresAt = verifiedAt + 2_592_000_000`. Reads, writes and saved-token renewal never extend it. Apple can
reject it sooner; reconnect when required. Disconnect deletes the encrypted session record,
list snapshots and reminder continuations. Expired records are cleared on next access, not by a timed purge.

Both strict login-assurance versions remain readable. Legacy version 2 keeps its exact 24-hour
deadline until the configured owner authorises a generation-scoped migration. Migration changes
only encrypted retention evidence and the row version; it makes no Apple requests and preserves
the original verification, credentials and list state. Roll out compatible readers first, migrate,
remove the one-time approval, then enable renewal and future 30-day sign-ins. See
[session retention, deployment and compatible rollback](docs/session-retention.md).
Status exposes the local deadline and separate validation/operation/renewal timestamps, never tokens.
“Connected” reports restored saved state, not a fresh Apple check or a promise of 30 days of Apple access.

## Use the dashboard

Sign in to your private workspace, then select **Connect Apple account**. **Your lists** shows the
saved list count and last successful retrieval time. **Refresh lists**
fetches current lists; a failed refresh keeps the previous snapshot visible and reports an error.
The 15-second display polling reads saved status only and does not contact Apple.

- **Preview reminders** verifies the selected list live and fetches open reminders. **Include
  completed reminders** and **Show more reminders** retain their existing behavior.
- **Testing & details** contains exact list lookup, response details and bounded reminder diagnostics.
- **Disconnect Apple account** deletes the encrypted session, snapshots and continuations.
  Workspace sign-out does not disconnect Apple.

## Direct retrieval and pagination

Direct CloudKit querying is the sole list-discovery path. Historical scanning, checkpoints,
automatic catalogue work and strategy selection have been removed. If Apple rejects the query,
the call reports the classified error; it does not switch to a historical fallback. Known-list
reminder reads can still authorize a list and fetch its contents independently of discovery.

Direct discovery validates the authenticated private Reminders zone, sends `query.recordType=Lists`
and accepts singular `List` records. It follows opaque `continuationMarker` pages without any
`/changes/zone` calls. List membership, reminder titles, notes and attachments are not requested;
no field projection is sent because support for `desiredKeys` on this special query is unverified.
Extra returned fields are discarded from summaries. Empty lists are retained; MCP list results and
all-open selection exclude deleted lists and groups. Shared-database lists are not discovered.

**Live validation is limited to one account.** An approved local test on 2026-10-09 returned the
owner's three expected lists, picked up a new list and removed it after deletion, with zero change
calls. Live pagination, groups, renamed/old/empty-list coverage and shared-list completeness remain
unverified. Direct discovery is now the only path at the owner’s request; these remaining limits
are not evidence of broader completeness. The [pinned external reference](https://github.com/fineyh/icloud-reminders-desktop/blob/3dbbbed9eef3d2f3a6d13be28475c2d4585504a0/src/backend/reminders_api.py)
supports the request format, while synthetic tests cover parsing and bounded continuation handling. See
[discovery evidence and validation procedure](docs/direct-list-retrieval.md).

Each direct refresh is bounded to 25 query pages, 20 seconds, 1,000 identifiers and a 1 MiB summary
budget with response overhead reserved. Individual transport timeouts still apply. A complete
refresh atomically replaces the encrypted snapshot, including removals. Duplicate identical
summaries are deduplicated; conflicting summaries, malformed records or wrong owners fail safely.
Repeated continuations and incomplete/error pages never publish a complete catalogue. A bounded
incomplete discovery returns `UNSUPPORTED_FEATURE` and preserves the last snapshot. List discovery
does not expose a resumable MCP cursor; collections exceeding these bounds cannot currently
complete list discovery. Retry a transient failure; persistent limits or unsupported queries require
a future protocol change. There is no historical fallback.

Direct list responses report `source: "direct-cloudkit-query"` and `freshness.mode: "live"`.
There is no TTL cache: normal direct list calls and explicit refreshes contact Apple. Saved dashboard
summaries are display-only and are never proof of authorization for a reminder read.
`get_reminders` validates its exact list ID with a current owner-bound lookup, rejects inaccessible,
deleted or group records, then runs the existing live `reminderList` query. A missing, pending or
expired historical checkpoint does not block this path, in either discovery mode.

`get_reminders` returns one bounded page; pass its continuation with the same list ID and completed
option. `get_all_open_reminders` discovers lists once when starting and saves its selection in the
encrypted session. Resumptions use that original selection even after a separate refresh. It keeps
independent 20-page/20-second, 5,000-record and response-size bounds, with a single-use, ten-minute
owner/session-bound continuation. Combine successful pages, inspect failures before retrying and
respect `retryAfterSeconds`. `complete: true` requires every selected list to finish successfully.
Results across lists are not an atomic Apple snapshot. Reminder contents are never persisted.

Existing encrypted version-1 sessions remain compatible; no D1 migration or session reset is
required. Recognized historical checkpoint, scheduler and recovery fields are ignored on load and
removed on the next successful encrypted commit. Their old all-open continuations are retired;
start a new all-open operation if one conflicts after upgrade. Valid direct-query continuations,
credentials, list snapshots, owner boundaries and absolute expiry remain intact. Unknown active
fields still fail strict validation.

Remove old `REMINDERS_LIST_DISCOVERY`, `CATALOGUE_BACKGROUND_RUNNER` and
`REMINDERS_ENABLE_CRON` settings from operator configuration. They no longer select a strategy or
start work. Remove previously provisioned catalogue Cron triggers when deploying the upgrade;
the Worker no longer exports a scheduled handler. Generated deployment configs omit triggers.
No production configuration is changed by this source update.

## Cloudflare repository builds

Keep actual resource identifiers and runtime settings in Cloudflare, not in public Git source:

1. Configure `REMINDERS_D1_DATABASE_ID` as a protected **build** environment variable. Set
   `REMINDERS_WORKER_NAME` if your Worker name differs from `icloud-reminders-mcp-server`.
2. Configure runtime plaintext settings from the table in the Worker dashboard, and install
   `ENCRYPTION_KEYS_JSON` as a runtime secret. Build variables are not runtime variables.
3. Use `npm run install:ci` to install, and `npm run deploy:cloudflare` as the deployment command.
   Initialize a new D1 database by executing `schema.sql` before its first deployment. The generated config uses
   `keep_vars = true` and omits `[vars]` in this path so dashboard configuration is retained.

No GitHub workflow in this repository deploys production or receives Apple credentials.

## Development and project structure

Dependabot checks weekly and groups routine minor/patch updates into one npm PR and one GitHub
Actions PR. Routine bot updates enable squash auto-merge automatically; the four protected-branch
CI checks must pass before merging. Major upgrades remain manual, and failed updates stay blocked.
Minor/patch npm security fixes are grouped separately and handled when alerts arrive.
Merged branches are deleted automatically. The automation follows the
[email MCP server's workflow](https://github.com/Xzese/email-mcp-for-cloudflare-workers/blob/main/.github/workflows/dependabot-auto-merge.yml).
Builds also refresh the dependency inventory and third-party notices automatically, so a
dependency update ships current attribution without a separate generated-file PR. The local
and acceptance runners declare their Miniflare API version explicitly; a Wrangler update
does not silently migrate those runners to a new major API.

```text
src/
  index.ts           Standalone Cloudflare Worker entrypoint with Access verification
  worker.ts          Shared application Worker and Sites entrypoint
  app/               Private dashboard and isolated browser login client
  components/        Shared UI components
  hooks/             React hooks
  lib/               Shared utilities and connector helpers
  types/             Application and Worker type declarations
  api/               Authenticated API routing
  mcp/               MCP read and reminder mutation tools
  auth/              Apple authentication and direct reminder reads
  crypto/            Protocol cryptography and encrypted storage envelopes
  icloud/            CloudKit transport and record normalization
  persistence/       Native D1 session and encrypted job storage
  jobs/              Durable manifests, lifecycle and bounded request-driven runner
  platform/          Sites and Cloudflare authentication adapters
  reminders/         Reminder document codec and bounded write schemas/payloads
  transport/         Bounded Apple HTTP and WebSocket transports
scripts/
  build/             Vite plugins, framework build runner and artifact checks
  deploy/            Cloudflare deployment preparation and encryption-key generator
  dev/               Opt-in local iCloud runner and connector preview helpers
  lib/               Shared execution-profile and environment helpers
  release/           Clean public exports and third-party notices
  setup/             Dependency installation and local environment setup
tests/               Behavioural protocol, persistence and authorization tests
  fixtures/          Invented reference vectors; never real Apple transcripts
  helpers/           Shared synthetic test helpers
  integration/       Built Worker, standalone Access and local transport acceptance checks
wrangler.toml        Public standalone Worker configuration template
schema.sql           Current D1 schema for a new deployment
provenance/           Pinned upstream sources and preserved third-party notices
docs/                Architecture and release guidance
.github/             Synthetic CI and dependency-update configuration
```

Copy `wrangler.toml` to ignored `wrangler.production.toml` for your own deployment settings.
Deployment preparation produces ignored `wrangler.generated.toml`. The minimal
`wrangler.build.toml` isolates framework builds from production settings. Vite generates
`dist/server/wrangler.json` internally; that generated file is not an editable source configuration.

The source contains `apple_session_state` and the additive encrypted job ledger. The Worker uses
native D1 prepared statements. The Sites build derives its platform SQL package from `schema.sql`.
Fresh databases use that definition; existing databases apply `migrations/0001_reminder_jobs.sql`
using the [documented upgrade path](docs/reminder-jobs.md), followed by the service settings and
Drive migrations in the [Drive guide](docs/icloud-drive.md#database-upgrade-and-rollback), without
resetting session data.

Run the checks before contributing:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:worker
npm run test:local
npm run verify:artifact
npm run public-config:check
npm run build:check
```

The standalone bundle check is a dry run: it does not upload or deploy. It leaves a standalone
build in `dist/`; run `npm run build` again before running the Sites/local live launcher.
See [CONTRIBUTING.md](CONTRIBUTING.md) for pull-request expectations.

## Security and licensing

See [SECURITY.md](SECURITY.md) for responsible reporting, trust boundaries and deployment duties.
The owner of the Worker and its encryption key can decrypt stored session credentials. Encryption
at rest does not protect against a compromised server, browser login script or operator account.
Use restrictive access, protect the encryption key, and keep dependencies current.

Original project contributions use the [MIT License](LICENSE). Preserve upstream notices in
[provenance/NOTICE.md](provenance/NOTICE.md) and `provenance/licenses/`. The Sites build adapter and
vendored UI assets have their own preserved notices. MIT licensing does not establish rights in
Apple protocols, trademarks or account data. Apple, iCloud and Reminders are trademarks of Apple Inc.;
this project is not affiliated with Apple.
