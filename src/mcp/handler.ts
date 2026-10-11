import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { AppleConnectionService, ControlledRead } from "../auth/service.ts";
import { publicError } from "../errors.ts";
import { omitField } from "../lib/omit-field.ts";
import type { RuntimeEnv } from "../platform/sites.ts";
import { CreateReminderInput, ReminderTargetInput } from "../reminders/writes.ts";
import { PrepareUpdateInput, PreparedUpdateInput } from "../reminders/preparation.ts";
import { CreateSubtaskInput, SetReminderParentInput } from "../reminders/subtasks.ts";
import { ReminderJobService } from "../jobs/service.ts";
import { CreateJob, AppendJob, PreviewJob, StartJob, GetJob, JobIdentity, JobOutput } from "../jobs/schemas.ts";
import { ExpectedGenerationInput, ListsOutput, RemindersPageOutput, AllOpenOutput, ReminderLookupOutput, MutationOutput, ConnectionStatusOutput, PrepareUpdateOutput } from "./schemas.ts";

export async function handleMCP(request: Request, env: RuntimeEnv, owner: string) {
  const server = new McpServer({ name: "hosted-icloud-reminders", version: "0.1.0" });
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  const expectedGeneration = ExpectedGenerationInput;
  const toolError = (error: unknown) => {
    const result = { error: publicError(error, crypto.randomUUID()) };
    return { isError: true, structuredContent: result, content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  };
  const liveRead = async (args: Record<string, unknown>) => {
    try {
      const apple = new AppleConnectionService(env, owner);
      const generation = args.expectedGeneration ?? (await apple.status()).generation;
      const response = await apple.readForMCP(ControlledRead.parse({ ...args, expectedGeneration: generation }));
      const page = response.result as Record<string, unknown>;
      // Return normalized reminder fields. Raw CloudKit records/traces can carry
      // signed asset links or opaque cursors and stay in the controlled UI.
      const records = (page.records as Record<string, unknown>[]).filter(record => args.action !== "saved-lists" || (!record.deleted && !record.isGroup)).map(record => {
        return omitField(record, "appleRecord");
      });
      const result = { generation: response.generation, records, complete: page.complete, paginationComplete: page.paginationComplete,
        continuation: page.continuation, pendingReason: page.pendingReason, ...(args.action === "reminders" ? { listId: page.listId } : {}),
        recordErrors: (page.recordErrors as Record<string, unknown>[]).map(error => ({ id: error.id, code: error.code })),
        source: page.source, freshness: page.freshness, writesEnabled: response.writesEnabled };
      return { structuredContent: result, content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (error) {
      return toolError(error);
    }
  };
  server.registerTool("get_reminder_lists", { title: "Get current iCloud reminder lists", description: "Retrieve the owner's current selectable lists directly from private-zone CloudKit Lists. The server follows bounded query pagination and saves only complete encrypted snapshots. Historical scanning is not used. An unsupported or incomplete discovery returns an actionable error and preserves the previous snapshot. Shared-database list discovery is not supported; broader live completeness remains under validation. expectedGeneration pins the Apple session. No reminders are modified.", inputSchema: z.object({ expectedGeneration }).strict(), outputSchema: ListsOutput, annotations: readAnnotations }, args => liveRead({ ...args, action: "saved-lists" }));
  server.registerTool("get_reminders", { title: "Get current reminders from an iCloud list", description: "Verify an exact listId with a live owner-bound lookup, then fetch one current Apple reminder page without historical catalogue synchronization. Open reminders only by default; includeCompleted includes completed items. Contents are live and never cached. Follow the opaque continuation with the same listId and includeCompleted option; paginationComplete indicates the final page. A saved list ID alone is not proof of access. Use the dedicated mutation tools for reminder changes.", inputSchema: z.object({ expectedGeneration, listId: z.string().min(6).max(512).startsWith("List/").describe("Exact list ID from get_reminder_lists; do not supply the list title."), includeCompleted: z.boolean().default(false).describe("False returns open reminders only. True includes completed history; use get_reminder for an exact completed item."), limit: z.number().int().min(1).max(200).default(200).describe("Maximum Apple page size, 1–200. Use 20 or 50 if compound history pages exceed the response budget."), continuation: z.string().min(1).max(8192).nullable().optional().describe("Opaque next-page value from get_reminders. Omit or use null for the first page; retain listId, includeCompleted and session when continuing.") }).strict(), outputSchema: RemindersPageOutput, annotations: readAnnotations }, args => liveRead({ ...args, action: "reminders" }));
  server.registerTool("get_all_open_reminders", { title: "Get open reminders across all iCloud lists", description: "Discover selectable private-zone lists directly from CloudKit, then read current open reminders across them without historical scanning. Unsupported or incomplete list discovery fails explicitly. Shared-database list discovery is not supported. Resumptions use the operation's saved list selection without rediscovery. A bounded incomplete reminder result includes progress and a single-use, ten-minute owner/session-bound continuation; combine returned records across successful pages. complete=true requires every selected list to finish. Inspect errors before retrying and respect retryAfterSeconds. Reminder contents are never persisted.", inputSchema: z.object({ expectedGeneration, continuation: z.string().uuid().nullable().optional().describe("Single-use continuation from get_all_open_reminders; omit or use null to start. Use the newly returned token for each subsequent page and combine records.") }).strict(), outputSchema: AllOpenOutput, annotations: readAnnotations }, async args => {
    try {
      const apple = new AppleConnectionService(env, owner);
      const generation = args.expectedGeneration ?? (await apple.status()).generation;
      const response = await apple.readAllOpenForMCP(generation, args.continuation);
      const page = response.result;
      const result = { ...page, generation: response.generation, records: page.records.map(record => omitField(record, "appleRecord")), writesEnabled: response.writesEnabled };
      return { structuredContent: result, content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (error) {
      return toolError(error);
    }
  });
  server.registerTool("get_reminder", {
    title: "Get one current iCloud reminder",
    description: "Read one exact reminder ID in its list, including completed or soft-deleted items, without scanning list history. Use listId and reminderId from prior results. Returns its normalized content and current recordChangeTag, or record=null and missing=true if Apple reports it absent. Useful to reconcile WRITE_OUTCOME_UNKNOWN before considering another change. No credentials, raw Apple records or write operations are accepted.",
    inputSchema: ReminderTargetInput.omit({ recordChangeTag: true }).extend({ expectedGeneration }).strict(),
    outputSchema: ReminderLookupOutput,
    annotations: readAnnotations,
  }, async args => {
    try {
      const apple = new AppleConnectionService(env, owner);
      const generation = args.expectedGeneration ?? (await apple.status()).generation;
      const result = await apple.readReminderForMCP(generation, args.listId, args.reminderId);
      return { structuredContent: result, content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (error) {
      return toolError(error);
    }
  });
  const write = async (action: "create" | "update" | "complete" | "reopen" | "delete" | "create_subtask" | "set_parent", args: Record<string, unknown>) => {
    try {
      const apple = new AppleConnectionService(env, owner);
      const generation = args.expectedGeneration ?? (await apple.status()).generation;
      const result = await apple.mutate({ ...args, action, expectedGeneration: generation });
      return { structuredContent: result, content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (error) {
      return toolError(error);
    }
  };
  server.registerTool("create_reminder", {
    title: "Create an iCloud reminder",
    description: "Create one open reminder in listId from get_reminder_lists. Requires the authenticated owner and a ready Apple session. Supply a new UUID idempotencyKey for each distinct reminder and keep that same key and input when retrying an uncertain creation; the UUID determines the Apple record ID and prevents duplicate items. Supports title, notes, priority (0 none, 1 high, 5 medium, 9 low), flagged, dueDate with an explicit ISO 8601 offset, timeZone and allDay. An all-day reminder requires a date and time zone. No alarms, recurrence, attachments, subtasks or completion changes are created. WRITE_OUTCOME_UNKNOWN means Apple may have committed: inspect the supplied reminderId and reuse the same idempotencyKey, never create a second key for that attempt. Returned replayed=true means the matching existing item was read and no new write was sent.",
    inputSchema: CreateReminderInput.extend({ expectedGeneration }).strict(),
    outputSchema: MutationOutput("create"),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, args => write("create", args));
  server.registerTool("create_subtask", {
    title: "Create an iCloud reminder subtask",
    description: "Create one undated, open reminder under an exact open root reminder in the same list. Available to the authenticated owner with a ready Apple session; parentReminder contains its reminderId and current recordChangeTag. Retain one UUID idempotencyKey and identical inputs for reconciliation; matching replay makes no further write even after the parent tag advances. The child create and parent version guard share one atomic group. Recurring, alarmed, dated or nested parents and deeper nesting are refused. Does not create recurrence, alarms or cascade actions. Read parentReminderId in get_reminder/get_reminders to inspect relationships. WRITE_OUTCOME_UNKNOWN requires exact-ID reconciliation, never a replacement create key.",
    inputSchema: CreateSubtaskInput.extend({ expectedGeneration }).strict(), outputSchema: MutationOutput("create_subtask"),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, args => write("create_subtask", args));
  server.registerTool("set_reminder_parent", {
    title: "Make an iCloud reminder a subtask or return it to top level",
    description: "Move one open undated childless reminder under an exact open root in the same list, or remove its existing parent with parentReminder=null. Requires capabilities.subtasks=true, exact list/reminder IDs and the child recordChangeTag. A destination parent includes its current reminderId and recordChangeTag. The server reads the previous parent from the versioned child and guards both affected parents atomically. Preserves content, dates and untouched tokens. Checks descendants with a bounded complete list read; refuses self-parenting, deeper nesting, cross-list moves, completed/dated/alarmed/recurring nodes and moving parents with children. This is not a bulk-delete eligibility proof or cascade operation. Stale tags return CONFLICT; never refresh them automatically to retry. Reconcile WRITE_OUTCOME_UNKNOWN before any further mutation.",
    inputSchema: SetReminderParentInput.extend({ expectedGeneration }).strict(), outputSchema: MutationOutput("set_parent"),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, args => write("set_parent", args));
  server.registerTool("update_reminder", {
    title: "Edit an open iCloud reminder",
    description: "Edit one open reminder using listId, reminderId and the current recordChangeTag from get_reminder or get_reminders. Requires the authenticated owner and a ready Apple session. Provide a nonempty changes object with only the fields to edit: title, notes, priority (0/1/5/9), flagged, dueDate, timeZone, allDay, recurrence, earlyReminder or locationAlarm. Omitted fields stay unchanged; null clears a simple reminder's date/time zone, and clearing its date also clears the zone and all-day marker unless explicitly overridden. Text edits replace that field's text formatting; untouched documents are preserved. Timed root reminders with one supported absolute date alarm can change date/time zone atomically with the existing alarm and trigger, protecting and preserving any recurrence. Supply an explicit-offset instant with whole-second precision and an IANA zone; a zone-only change preserves the instant, not the local clock. Known linked dates can be cleared with their recurrence and date alarm retired atomically. All-day conversion requires the desired calendar date at midnight UTC (dueDate ending in Z) and removes the time zone; reverse conversion requires explicit dueDate and timeZone. Existing simple daily, weekly, monthly and yearly recurrence can be edited; interval 2 is supported for weekly only. Existing single minute/hour-based early reminders can change offset while preserving private metadata. An existing reviewed location alarm can switch arriving/leaving while preserving its place and radius; timed date moves preserve and version-guard the location alarm and trigger. Child scheduling protects the exact same-list open root parent. Repeated local times, multiple date or location alarms, location creation/removal or date clearing/conversion with location, new relative payloads and unknown schedules are unsupported. Use prepare_reminder_update for an exact read-only recipe preview. Repeating identical arguments makes no additional change but may return CONFLICT because the version is stale. Read and review before constructing a new request with a fresh tag. WRITE_OUTCOME_UNKNOWN means the change may have saved: read current state first. Never automatically refresh tags, retry or force-update. State changes use separate tools; cannot move lists or create recurrence rules.",
    inputSchema: PreparedUpdateInput.extend({ expectedGeneration }).strict(),
    outputSchema: MutationOutput("update"),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, args => write("update", args));
  server.registerTool("prepare_reminder_update", {
    title: "Preview an exact reminder update",
    description: "Read and classify the exact versioned reminder graph without modifying Apple. Returns normalized before/after schedules and an expiring preparation token for supported single-record or linked-date edits. Linked-date moves update an existing absolute date alarm and trigger in place while atomically protecting unchanged recurrence. Known linked date clearing, explicit all-day conversion, simple recurrence edits and existing early-reminder offset edits use bounded atomic recipes. Child scheduling protects its exact parent. One absolute date alarm plus one reviewed location alarm supports date moves and existing arriving/leaving edits with every participant protected. New recurrence/relative/location payloads, multiple alarms of the same type and unknown graphs are unsupported. Pass the token with identical arguments to update_reminder; changed graphs or requests are rejected. Completed historical occurrences are never redirected or reopened. A preparation token does not authorize a change.",
    inputSchema: PrepareUpdateInput, outputSchema: PrepareUpdateOutput, annotations: readAnnotations,
  }, async args => {
    try {
      const result = await new AppleConnectionService(env, owner).prepareUpdate(args);
      return { structuredContent: result, content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (error) { return toolError(error); }
  });
  const jobTools = [
    { name: "create_reminder_job", schema: CreateJob, action: "create", description: "Create an empty encrypted draft for bulk_create or bulk_delete with a UUID job idempotency key and required session generation. Identity comes from authentication. Jobs expire within 24 hours or the existing fixed session deadline, whichever is earlier. Reusing a key with different kind or generation conflicts. No Apple mutation occurs." },
    { name: "append_reminder_job_items", schema: AppendJob, action: "append", description: "Append up to 50 items and 64 KiB to the current draft revision using an idempotent UUID chunk key. Each item includes kind, stable clientItemKey and input. Bulk creates retain their own UUIDs; equal titles with distinct keys remain distinct. Bulk deletes require exact listId, reminderId and recordChangeTag. Changed chunk/key reuse conflicts; no dynamic selection or automatic tag refresh. Up to 1,000 items and 2 MiB per sealed job. No Apple mutation occurs." },
    { name: "preview_reminder_job", schema: PreviewJob, action: "preview", description: "Seal and validate the entire immutable draft manifest. Returns a ten-minute owner/account/session-bound preview token, counts and the first 50 exact input summaries or targets; use get_reminder_job to review further pages before authorization. Unsupported items are explicitly failed and never dispatched. Bulk deletes are read-only preflighted: missing, stale, duplicate, recurring, alarmed, nested and parent targets fail here. No Apple mutation occurs; preview is not user authorization." },
    { name: "start_reminder_job", schema: StartJob, action: "start", description: "Commit the exact sealed manifest using its reviewed preview token after obtaining user authorization. This queues durable work but does not execute Apple mutations in this request. Check executionMode: request-driven requires continue_reminder_job calls; queue uses a configured standalone consumer and durable outbox. Simple bulk creation and simple bulk deletion are available to the authenticated owner with a ready Apple session and the job schema installed. Each deletion repeats the exact-version and subtask checks before one soft-delete, then reports any subtask attached natively during commit (SUBTASKS_REMAIN); it never cascades. Cancellation cannot undo dispatched work. No display ordering is claimed." },
    { name: "get_reminder_job", schema: GetJob, action: "get", description: "Read encrypted owner-scoped job status and up to 50 results in original ordinal order. Reports every pending, confirmed, conflicting, failed, cancelled or uncertain item. desiredStateObserved is distinct from operationConfirmed. GET/status never dispatches, renews an Apple session, schedules background work or changes the ledger." },
    { name: "cancel_reminder_job", schema: JobIdentity, action: "cancel", description: "Persist cancellation and stop future dispatches. Already dispatched items remain eligible for read-only reconciliation and may complete. Cancellation is not rollback; it never deletes successful creates or restores deleted targets. Reports unresolved in-flight counts accurately." },
    { name: "resume_reminder_job", schema: JobIdentity, action: "resume", description: "Resume eligible paused work only with the same Apple account, original session generation and unexpired authorized manifest. Honors persisted cooldown. Never silently rebinds a reconnected session, refreshes a deletion tag or replays an uncertain mutation. Use continue_reminder_job for bounded execution or reconciliation." },
    { name: "continue_reminder_job", schema: JobIdentity, action: "continue", description: "Run at most three ledger-selected items using per-operation Apple session leases and a durable account/job lease. Request-driven mode pauses without further calls. Durable dispatch intent is saved before Apple; recovered intent is reconciled read-only and never automatically replayed. Reports lost receipts as unknown even if desired state is observed. Cancellation is checked immediately before dispatch. No credentials or raw Apple payloads are accepted." },
  ] as const;
  for (const tool of jobTools) {
    server.registerTool(tool.name, {
      title: tool.name.replaceAll("_", " "), description: tool.description, inputSchema: tool.schema, outputSchema: JobOutput,
      annotations: { readOnlyHint: tool.action === "get", destructiveHint: tool.action === "start" || tool.action === "continue", idempotentHint: tool.action !== "get", openWorldHint: true },
    }, async (args: unknown) => {
      try {
        const jobs = new ReminderJobService(env, owner);
        const result = await jobs[tool.action](args);
        return { structuredContent: result, content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (error) { return toolError(error); }
    });
  }
  for (const action of ["complete", "reopen", "delete"] as const) {
    const operation = action === "complete" ? "Mark one open reminder completed" : action === "reopen" ? "Reopen one completed reminder" : "Delete one open or completed reminder using Apple's Deleted marker";
    server.registerTool(`${action}_reminder`, {
      title: `${action === "complete" ? "Complete" : action === "reopen" ? "Reopen" : "Delete"} an iCloud reminder`,
      description: `${operation}. Requires the authenticated owner, a ready Apple session, listId, reminderId and the latest recordChangeTag from get_reminder or get_reminders. Use get_reminder for exact completed-item lookup, or includeCompleted=true to page list history. Preserves omitted content and resolution tokens. Recurring, alarmed, nested reminders and observed parents are refused. A bounded complete list inspection detects existing children; it is not proof of protection against newly added unreferenced children. This sends one tagged record update and never cascades. Use Apple's app for parent/child lifecycle actions. Repeating identical arguments causes no additional reminder change but may return CONFLICT because the original version is stale. Read and review before constructing any new request with a fresh tag. WRITE_OUTCOME_UNKNOWN means Apple may have saved the action: reconcile the exact ID first. Never automatically retry with a fresh tag or force a write. Deletion is a soft, version-checked update; no hard-delete or restore tool is exposed.`,
      inputSchema: ReminderTargetInput.extend({ expectedGeneration }).strict(),
      outputSchema: MutationOutput(action),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    }, args => write(action, args));
  }
  server.registerTool("connection_status", { title: "Reminders connection status", description: "Report connection state, session generation and available tools without fetching Apple data. A READY session supports bounded reads, basic mutations and one-level subtask relationship tools. Simple bulk creation also requires the installed job schema. writeEnabled and capabilities report current connection and storage availability, not feature rollout flags. Mutation tools enforce owner/session and version checks and never accept Apple credentials.", inputSchema: z.object({}).strict(), outputSchema: ConnectionStatusOutput, annotations }, async () => {
    try {
      const result = await new AppleConnectionService(env, owner).status();
      return { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return toolError(error);
    }
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 65_536 });
  try { await server.connect(transport); return await transport.handleRequest(request); }
  finally { await server.close(); }
}
