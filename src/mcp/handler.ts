import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { LATEST_PROTOCOL_VERSION, JSONRPCRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { CreateListInput, RenameListInput, DeleteListInput } from "../reminders/list-writes.ts";
import { UpdateListAppearanceRequest } from "../reminders/list-appearance.ts";
import { AppleConnectionService, ControlledRead, ListReadIdInput, SearchReminderInput, SearchReminderInputFieldsSchema } from "../auth/service.ts";
import { toolSuccess, toolError } from "./results.ts";
import { AppError } from "../errors.ts";
import { omitField } from "../lib/omit-field.ts";
import type { RuntimeEnv } from "../platform/sites.ts";
import { CreateReminderInput, ReminderTargetInput } from "../reminders/writes.ts";
import { RecurrenceCalendarTimeZone } from "../reminders/recurrence-calendar.ts";
import { RecurringDeletionScope } from "../reminders/recurring-deletion.ts";
import { PrepareUpdateInput, PreparedUpdateInput } from "../reminders/preparation.ts";
import { URLChanges, TagChanges } from "../reminders/organization.ts";
import { InspectReminderInput } from "../reminders/inspection.ts";
import { ReminderCollectionInput } from "../reminders/collection.ts";
import { ReminderCollectionOutput, ReminderExportOutput } from "./schemas.ts";
import { ConnectorFilterRepository, SaveConnectorFilterInput, GetConnectorFilterInput, DeleteConnectorFilterInput,
  SavedConnectorFilterSchema, ListConnectorFiltersOutput, DeleteConnectorFilterOutput } from "../persistence/connector-filters.ts";
import { CreateWorkflowService, CreateWorkflowInputFields, CreateWorkflowOutput, createWorkflowAppleFacade } from "../reminders/create-workflow.ts";
import { ReminderListDuplicationService, DuplicateReminderListInputFields, DuplicateReminderListOutput } from "../reminders/list-duplication.ts";
import { listDuplicationAppleFacade } from "../reminders/list-duplication-apple.ts";
import { MoveReminderInput, CopyReminderInput } from "../reminders/transfers.ts";
import { CreateSubtaskInput, SetReminderParentInput } from "../reminders/subtasks.ts";
import { GetShoppingCategoriesRequest, SetShoppingCategoryRequest } from "../reminders/shopping-categories.ts";
import { GetReminderListSectionsRequest } from "../reminders/sections.ts";
import { ReminderListSectionsOutput } from "./schemas.ts";
import { ReminderJobService } from "../jobs/service.ts";
import { CreateJob, AppendJob, PreviewJob, StartJob, GetJob, JobIdentity, JobOutput } from "../jobs/schemas.ts";
import { ExpectedGenerationInput, ListsOutput, RemindersPageOutput, AllOpenOutput, ReminderSearchOutput, ReminderLookupOutput, ReminderOrganizationOutput, ReminderInspectionOutput, MutationOutput, ConnectionStatusOutput, PrepareUpdateOutput, ListMutationOutput, ExactListOutput, ListAppearanceOutput, ListAppearanceMutationOutput, ShoppingCategoriesOutput, ShoppingCategoryMutationOutput } from "./schemas.ts";

import { ServiceSettingsRepository } from "../persistence/service-settings.ts";
import { enabledToolNames } from "../services/tool-registry.ts";
import { registerDriveTools } from "./drive-tools.ts";
import { limitedBytes } from "../transport/apple-http.ts";
import { INLINE_REQUEST_BYTES, INLINE_UPLOAD_GUIDANCE } from "../drive/schemas.ts";

export async function handleMCP(request: Request, env: RuntimeEnv, owner: string) {
  const server = new McpServer({ name: "hosted-icloud-reminders", version: "0.1.0" });
  const settings = await new ServiceSettingsRepository(env, owner).load();
  const enabled = new Set(enabledToolNames(settings.settings));
  const registerTool: typeof server.registerTool = (name, config, callback) => {
    const tool = server.registerTool(name, config, callback);
    if (!enabled.has(name)) tool.disable();
    return tool;
  };
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  const expectedGeneration = ExpectedGenerationInput;
  const collectionInput = ReminderCollectionInput.extend({ expectedGeneration });
  registerTool("duplicate_reminder_list", {
    title: "Duplicate a bounded plain-content reminder list",
    description: "Connector snapshot of at most 20 open, ordinary, undated, childless roots from an owned private Standard list. Preflight completes before destination creation. Copies supported plain title/notes, priority, flag, one URL and tags using existing native copy recipes. Completed history, schedules, sections/order/groups and appearance are excluded. Retain the same duplicationId and exact source version/request. Persisted started or uncertain operations only perform recovery reads on repeat, with no redispatch or later copies. Requires migration 0007. This is not a native template.",
    inputSchema: z.object({ ...DuplicateReminderListInputFields, expectedGeneration }).strict(), outputSchema: DuplicateReminderListOutput,
    annotations: { ...annotations, readOnlyHint: false, openWorldHint: true },
  }, async args => {
    try {
      const apple = new AppleConnectionService(env, owner), facade = await listDuplicationAppleFacade(env, owner, apple);
      return toolSuccess(await new ReminderListDuplicationService(env, owner, facade).duplicate({ ...args, expectedGeneration: args.expectedGeneration ?? facade.generation }));
    } catch (error) { return toolError(error); }
  });
  registerTool("create_reminder_workflow", {
    title: "Create and configure a reminder with durable progress",
    description: "Connector workflow using existing native operations: create one ordinary root, optionally apply one supported prepared schedule, then add URL and tags. These writes are separate and can leave a partially configured reminder. Keep the same workflowId and exact inputs. Started or uncertain stages are never redispatched; matching retries return read-only recovery. Timed recurrence and simultaneous scheduling features are excluded. Requires migration 0006; retains encrypted intent and receipts as no-replay evidence.",
    inputSchema: CreateWorkflowInputFields.extend({ expectedGeneration }), outputSchema: CreateWorkflowOutput,
    annotations: { ...annotations, readOnlyHint: false, openWorldHint: true },
  }, async args => {
    try {
      const apple = new AppleConnectionService(env, owner), generation = args.expectedGeneration ?? (await apple.status()).generation;
      return toolSuccess(await new CreateWorkflowService(env, owner, createWorkflowAppleFacade(env, owner, apple)).run({ ...args, expectedGeneration: generation }));
    } catch (error) { return toolError(error); }
  });
  registerTool("save_reminder_filter", { title: "Save a connector reminder filter", description: "Save an encrypted owner-scoped connector filter (not a native Smart List). Use a stable filterId UUID. Creates and exact retries are safe; updates require expectedRevision. At most 32 filters. Definitions save timezone, relative view and sorting, without reminder bodies or a frozen reference instant.",
    inputSchema: SaveConnectorFilterInput, outputSchema: SavedConnectorFilterSchema,
    annotations: { ...annotations, readOnlyHint: false } }, async args => {
    try { const result = await new ConnectorFilterRepository(env, owner).save(args); return toolSuccess(result); }
    catch (error) { return toolError(error); }
  });
  registerTool("get_reminder_filters", { title: "Read saved connector filters", description: "List the owner's saved connector filter definitions. These are independent of the Apple session and contain no reminder bodies.",
    inputSchema: z.object({}).strict(), outputSchema: z.object({ filters: ListConnectorFiltersOutput }).strict(), annotations }, async () => {
    try { const result = { filters: await new ConnectorFilterRepository(env, owner).list() }; return toolSuccess(result); }
    catch (error) { return toolError(error); }
  });
  registerTool("delete_reminder_filter", { title: "Delete a saved connector filter", description: "Delete one owner-scoped connector filter using its exact expectedRevision. This does not delete reminders or any native Smart List.",
    inputSchema: DeleteConnectorFilterInput, outputSchema: DeleteConnectorFilterOutput, annotations: { ...annotations, readOnlyHint: false, destructiveHint: true } }, async args => {
    try { const result = await new ConnectorFilterRepository(env, owner).delete(args); return toolSuccess(result); }
    catch (error) { return toolError(error); }
  });
  registerTool("run_reminder_filter", { title: "Run a saved connector filter", description: "Read a complete bounded collection using a saved connector filter and a new explicit referenceInstant. Limits and live-page consistency match get_reminder_view.",
    inputSchema: GetConnectorFilterInput.extend({ expectedGeneration, referenceInstant: ReminderCollectionInput.shape.referenceInstant }), outputSchema: ReminderCollectionOutput, annotations: readAnnotations }, async args => {
    try {
      const saved = await new ConnectorFilterRepository(env, owner).get(args.filterId);
      const apple = new AppleConnectionService(env, owner), generation = args.expectedGeneration ?? (await apple.status()).generation;
      const result = await apple.collectRemindersForMCP({ ...saved.definition, referenceInstant: args.referenceInstant }, generation);
      return toolSuccess(result);
    } catch (error) { return toolError(error); }
  });
  for (const exporting of [false, true]) {
    registerTool(exporting ? "export_reminders" : "get_reminder_view", {
      title: exporting ? "Export a bounded reminder collection" : "Read a sorted reminder view",
      description: "Connector convenience over live private-list search, with explicit timeZone and referenceInstant. Views: all, overdue, today, upcoming (next 1–90 days excluding today), untagged. Sort by due, priority, title or created only after all pages finish. Refuses partial results, duplicates, and collections exceeding 25 pages, 1000 scanned reminders, 512 KiB or 30 seconds. Live pages are not an immutable snapshot. This does not create a native Smart List or template. JSON/CSV exports contain normalized metadata; CSV neutralizes formula cells.",
      inputSchema: exporting ? collectionInput.extend({ format: z.enum(["json", "csv"]).describe("Normalized JSON records or quoted formula-safe CSV; output is bounded to 512 KiB.") }) : collectionInput,
      outputSchema: exporting ? ReminderExportOutput : ReminderCollectionOutput, annotations: readAnnotations,
    }, async args => {
      try {
        const apple = new AppleConnectionService(env, owner);
        const generation = args.expectedGeneration ?? (await apple.status()).generation;
        const values = args as Record<string, unknown>;
        const input = ReminderCollectionInput.parse(omitField(omitField(values, "expectedGeneration"), "format"));
        const result = await apple.collectRemindersForMCP(input, generation, "format" in args ? args.format as "json" | "csv" : undefined);
        return toolSuccess(result);
      } catch (error) { return toolError(error); }
    });
  }
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
      return toolSuccess(result);
    } catch (error) {
      return toolError(error);
    }
  };
  registerTool("get_reminder_lists", { title: "Get current iCloud reminder lists", description: "Retrieve the owner's current selectable lists directly from private-zone CloudKit Lists. The server follows bounded query pagination and saves only complete encrypted snapshots. Historical scanning is not used. An unsupported or incomplete discovery returns an actionable error and preserves the previous snapshot. Shared-database list discovery is not supported; broader live completeness remains under validation. expectedGeneration pins the Apple session. No reminders are modified.", inputSchema: z.object({ expectedGeneration }).strict(), outputSchema: ListsOutput, annotations: readAnnotations }, args => liveRead({ ...args, action: "saved-lists" }));
  registerTool("get_reminders", { title: "Get current reminders from an iCloud list", description: "Verify an exact listId with a live owner-bound lookup, then fetch one current Apple reminder page without historical catalogue synchronization. Open reminders only by default; includeCompleted includes completed items. Contents are live and never cached. Follow the opaque continuation with the same listId and includeCompleted option; paginationComplete indicates the final page. A saved list ID alone is not proof of access. Use the dedicated mutation tools for reminder changes.", inputSchema: z.object({ expectedGeneration, listId: ListReadIdInput.describe("Exact list ID from get_reminder_lists; do not supply the list title."), includeCompleted: z.boolean().default(false).describe("False returns open reminders only. True includes completed history; use get_reminder for an exact completed item."), limit: z.number().int().min(1).max(200).default(200).describe("Maximum Apple page size, 1–200. Use 20 or 50 if compound history pages exceed the response budget."), continuation: z.string().min(1).max(8192).nullable().optional().describe("Opaque next-page value from get_reminders. Omit or use null for the first page; retain listId, includeCompleted and session when continuing.") }).strict(), outputSchema: RemindersPageOutput, annotations: readAnnotations }, args => liveRead({ ...args, action: "reminders" }));
  registerTool("get_all_open_reminders", { title: "Get open reminders across all iCloud lists", description: "Discover selectable private-zone lists directly from CloudKit, then read current open reminders across them without historical scanning. Unsupported or incomplete list discovery fails explicitly. Shared-database list discovery is not supported. Resumptions use the operation's saved list selection without rediscovery. A bounded incomplete reminder result includes progress and a single-use, ten-minute owner/session-bound continuation; combine returned records across successful pages. complete=true requires every selected list to finish. Inspect errors before retrying and respect retryAfterSeconds. Reminder contents are never persisted.", inputSchema: z.object({ expectedGeneration, continuation: z.string().uuid().nullable().optional().describe("Single-use continuation from get_all_open_reminders; omit or use null to start. Use the newly returned token for each subsequent page and combine records.") }).strict(), outputSchema: AllOpenOutput, annotations: readAnnotations }, async args => {
    try {
      const apple = new AppleConnectionService(env, owner);
      const generation = args.expectedGeneration ?? (await apple.status()).generation;
      const response = await apple.readAllOpenForMCP(generation, args.continuation);
      const page = response.result;
      const result = { ...page, generation: response.generation, records: page.records.map(record => omitField(record, "appleRecord")), writesEnabled: response.writesEnabled };
      return toolSuccess(result);
    } catch (error) {
      return toolError(error);
    }
  });
  registerTool("search_reminders", {
    title: "Search current iCloud reminders",
    description: "Search current reminders by a case-insensitive title or notes substring and optional status, flagged, priority, due date, exact list, literal tags, tag presence, URL presence or URL substring. Tag filters accept 1–16 exact tag names; tagMatch is all by default when tags are supplied, or any. URL text searches only the separate native URL, not titles, notes or image attachments. Status defaults to open. Without listId, the search scans every currently selectable owned private list discovered at the start; shared lists are not included. Each call reads at most one Apple reminder page and can return zero matches with a continuation. Repeat the same filters with the newly returned single-use token. Pages are live reads, not a snapshot, so reminders can change between pages. Reminder contents are never persisted.",
    // Keep the public Zod object visible to MCP clients; cross-field constraints
    // are enforced by SearchReminderInput when the request enters the service.
    inputSchema: SearchReminderInputFieldsSchema,
    outputSchema: ReminderSearchOutput,
    annotations: readAnnotations,
  }, async (args: z.input<typeof SearchReminderInput>) => {
    try {
      const apple = new AppleConnectionService(env, owner);
      const generation = args.expectedGeneration ?? (await apple.status()).generation;
      const response = await apple.searchRemindersForMCP({ ...args, expectedGeneration: generation });
      const result = { ...response.result, generation: response.generation,
        records: response.result.records.map(record => omitField(record, "appleRecord")), writesEnabled: response.writesEnabled };
      return toolSuccess(result);
    } catch (error) {
      return toolError(error);
    }
  });
  registerTool("get_reminder", {
    title: "Get one current iCloud reminder",
    description: "Read one exact reminder ID after authorizing the requested List, including completed or soft-deleted items, without scanning history. Use listId and reminderId from prior results. Returns normalized content and current recordChangeTag, or record=null and missing=true if Apple reports it absent. A detached owned soft-deleted root is returned with listId=null; the removed List relationship is not reconstructed. Useful to reconcile WRITE_OUTCOME_UNKNOWN before considering another change. No credentials, raw Apple records or write operations are accepted.",
    inputSchema: ReminderTargetInput.omit({ recordChangeTag: true }).extend({ expectedGeneration }).strict(),
    outputSchema: ReminderLookupOutput,
    annotations: readAnnotations,
  }, async args => {
    try {
      const apple = new AppleConnectionService(env, owner);
      const generation = args.expectedGeneration ?? (await apple.status()).generation;
      const result = await apple.readReminderForMCP(generation, args.listId, args.reminderId);
      return toolSuccess(result);
    } catch (error) {
      return toolError(error);
    }
  });
  registerTool("inspect_reminder", {
    title: "Inspect one reminder and native action eligibility",
    description: "Read one exact listId/reminderId and bounded native relationships without modifying Apple. Returns normalized schedule, recurrence, early/location alarms, URL, literal tags, selected Shopping category and one-level subtasks, plus per-action checks for complete, reopen, delete, move, copy and update. Unknown sections do not establish absence. Lifecycle checks use the native ordinary, timed family and bounded recurring planners. Series deletion needs explicit scope; a nonmidnight ended all-day daily rule needs an explicit recurrenceCalendarTimeZone. Transfers require destination IDs and current list versions after source eligibility. Use prepare_reminder_update with exact changes for update eligibility. A supported check is a point-in-time read, not authorization, a reservation or a preparation token; later execution repeats exact-version and recipe checks. No raw Apple records, signed asset URLs or private payloads are returned.",
    inputSchema: InspectReminderInput.extend({ expectedGeneration }).strict(),
    outputSchema: ReminderInspectionOutput, annotations: readAnnotations,
  }, async args => {
    try {
      const apple = new AppleConnectionService(env, owner);
      const generation = args.expectedGeneration ?? (await apple.status()).generation;
      const result = await apple.inspectReminder({ ...args, expectedGeneration: generation });
      return toolSuccess(result);
    } catch (error) { return toolError(error); }
  });
  const write = async (action: "create" | "update" | "complete" | "reopen" | "delete" | "create_subtask" | "set_parent" | "set_url" | "set_tags" | "move" | "copy", args: Record<string, unknown>) => {
    try {
      const apple = new AppleConnectionService(env, owner);
      const generation = args.expectedGeneration ?? (await apple.status()).generation;
      const result = await apple.mutate({ ...args, action, expectedGeneration: generation });
      return toolSuccess(result);
    } catch (error) {
      return toolError(error);
    }
  };
  registerTool("get_reminder_list", {
    title: "Get one current iCloud reminder list and version",
    description: "Look up an owned private non-group list by exact listId, including its soft-deleted state for uncertain-outcome reconciliation. Return its current name, observed count (which may be absent), and recordChangeTag for rename or empty-list deletion. No mutation occurs.",
    inputSchema: z.object({ expectedGeneration, listId: RenameListInput.shape.listId }).strict(),
    outputSchema: ExactListOutput, annotations: readAnnotations,
  }, async args => {
    try {
      const apple = new AppleConnectionService(env, owner);
      const generation = args.expectedGeneration ?? (await apple.status()).generation;
      const result = await apple.readListForMutation(generation, args.listId);
      return toolSuccess(result);
    } catch (error) { return toolError(error); }
  });
  registerTool("get_reminder_list_appearance", {
    title: "Get a reminder list's colour and emoji",
    description: "Read the current appearance of one exact owned, standard private Reminders list. Reports a recognized built-in colour preset, default colour, custom/unsupported colour state, emoji badge, or unsupported badge without exposing native field data. Use the returned recordChangeTag for update_reminder_list_appearance. Shared lists and groups are not supported.",
    inputSchema: z.object({ listId: RenameListInput.shape.listId, expectedGeneration }).strict(),
    outputSchema: ListAppearanceOutput, annotations: readAnnotations,
  }, async args => {
    try {
      const apple = new AppleConnectionService(env, owner);
      const generation = args.expectedGeneration ?? (await apple.status()).generation;
      const result = await apple.readListAppearanceForMCP(generation, args.listId);
      return toolSuccess(result);
    } catch (error) { return toolError(error); }
  });
  registerTool("get_reminder_list_sections", {
    title: "Get sections for a Standard reminder list",
    description: "Read materialised sections, reminder memberships and explicit native section ordering for one exact owned private Standard list, including empty sections. Reads one bounded metadata feed page; empty pages may still require continuation. Continue with the same list, limit and generation using the newly returned single-use cursor within ten minutes. List-version changes require a fresh scan. orderingStatus not_materialized means no explicit ordering asset was stored; no default order is inferred. Shared lists, groups, Shopping and Smart Lists are excluded. This tool does not create, move, rename, delete or reorder sections.",
    inputSchema: GetReminderListSectionsRequest, outputSchema: ReminderListSectionsOutput, annotations: readAnnotations,
  }, async args => {
    try {
      const apple = new AppleConnectionService(env, owner);
      const generation = args.expectedGeneration ?? (await apple.status()).generation;
      return toolSuccess(await apple.readReminderListSectionsForMCP(GetReminderListSectionsRequest.parse({ ...args, expectedGeneration: generation })));
    } catch (error) { return toolError(error); }
  });
  registerTool("get_shopping_categories", {
    title: "Get categories for an iCloud Shopping list",
    description: "Read Apple's materialised categories for one exact owned Shopping list, including categories with no current reminder members. Discovery uses the private category-only metadata catalogue and reads at most one bounded reverse-feed page; an empty result may still include a continuation. This is a fresh live read, not a snapshot. For each page, keep the exact listId and Apple session generation, then use the newly returned single-use continuation within ten minutes. Reminder contents are never persisted. Apple's built-in DisplayName and canonicalName can differ by localization or app.",
    inputSchema: GetShoppingCategoriesRequest,
    outputSchema: ShoppingCategoriesOutput,
    annotations: readAnnotations,
  }, async args => {
    try {
      const apple = new AppleConnectionService(env, owner);
      const generation = args.expectedGeneration ?? (await apple.status()).generation;
      const input = GetShoppingCategoriesRequest.parse({ ...args, expectedGeneration: generation });
      const result = await apple.readShoppingCategoriesForMCP(input);
      return toolSuccess(result);
    } catch (error) { return toolError(error); }
  });
  registerTool("set_reminder_category", {
    title: "Set a reminder's Shopping category",
    description: "Move one ordinary open, undated, childless root reminder in an owned Shopping list to an existing non-null category. Supply the exact reminder and list version tags plus the destination category tag from fresh reads. The reminder moves to the end of that category and other reminder data is preserved; Apple's native grocery learning is updated for the current lowercase ASCII title. Category creation, deletion, conversion, and cross-list moves are unsupported. A stale version returns CONFLICT and is never retried automatically. After WRITE_OUTCOME_UNKNOWN, perform fresh reads before any further change.",
    inputSchema: SetShoppingCategoryRequest,
    outputSchema: ShoppingCategoryMutationOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async args => {
    try {
      const apple = new AppleConnectionService(env, owner);
      const result = await apple.setShoppingCategory(SetShoppingCategoryRequest.parse(args));
      return toolSuccess(result);
    } catch (error) { return toolError(error); }
  });
  for (const entry of [
    { name: "create_reminder_list", action: "create" as const, schema: CreateListInput,
      description: "Create a new standard owned private iCloud Reminders list with a stable UUID idempotencyKey and name. Keep the same key after WRITE_OUTCOME_UNKNOWN and read the exact list before retrying. A matching existing list returns without another write." },
    { name: "rename_reminder_list", action: "rename" as const, schema: RenameListInput,
      description: "Rename an owned, non-group private Reminders list using its exact listId and current recordChangeTag from get_reminder_list. Conflicts require a fresh read and review. This cannot rename a shared list." },
    { name: "delete_reminder_list", action: "delete" as const, schema: DeleteListInput,
      description: "Soft-delete an owned private Reminders list ONLY when it is fully verified empty, including completed records, and its current title matches confirmName. This is destructive. A stale tag or incomplete pagination fails. WRITE_OUTCOME_UNKNOWN requires a fresh read, not automatic retry. Nonempty list deletion is not supported." },
  ]) {
    registerTool(entry.name, {
      title: entry.name.replaceAll("_", " "), description: entry.description,
      inputSchema: entry.schema.extend({ expectedGeneration }).strict(), outputSchema: ListMutationOutput,
      annotations: { readOnlyHint: false, destructiveHint: entry.action !== "create", idempotentHint: true, openWorldHint: true },
    }, async (args: (z.infer<typeof CreateListInput> | z.infer<typeof RenameListInput> | z.infer<typeof DeleteListInput>) & { expectedGeneration?: number }) => {
      try {
        const apple = new AppleConnectionService(env, owner);
        const generation = args.expectedGeneration ?? (await apple.status()).generation;
        const result = await apple.mutateList(entry.action, { ...args, expectedGeneration: generation });
        return toolSuccess(result);
      } catch (error) { return toolError(error); }
    });
  }
  registerTool("update_reminder_list_appearance", {
    title: "Update a reminder list's colour and emoji",
    description: "Set one built-in colour preset from red, orange, yellow, green, light-blue, blue, indigo, pink, purple, brown, grey or rose, one emoji grapheme, or both. Requires an exact owned, standard private listId, its current recordChangeTag from get_reminder_list_appearance, and the current expectedGeneration. Unknown existing fields are preserved. Color and badge clearing, custom RGB values, groups, sections and shared lists are unsupported. A stale tag returns CONFLICT; WRITE_OUTCOME_UNKNOWN requires a fresh appearance read before constructing another request. The original request is never automatically retried.",
    inputSchema: UpdateListAppearanceRequest,
    outputSchema: ListAppearanceMutationOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async args => {
    try {
      const apple = new AppleConnectionService(env, owner);
      const generation = args.expectedGeneration ?? (await apple.status()).generation;
      const result = await apple.mutateListAppearance({ ...args, expectedGeneration: generation });
      return toolSuccess(result);
    } catch (error) { return toolError(error); }
  });
  registerTool("get_reminder_organization", {
    title: "Get a reminder's separate URL and tags",
    description: "Read the selected reminder's native URL attachment and literal tag names, with exact related IDs and its current version. Other attachments remain opaque IDs. Requires an owned private list. No reminder content or signed asset links are persisted or returned.",
    inputSchema: ReminderTargetInput.omit({ recordChangeTag: true }).extend({ expectedGeneration }).strict(),
    outputSchema: ReminderOrganizationOutput, annotations: readAnnotations,
  }, async args => {
    try {
      const apple = new AppleConnectionService(env, owner);
      const generation = args.expectedGeneration ?? (await apple.status()).generation;
      const result = await apple.readOrganizationForMCP(generation, args.listId, args.reminderId);
      return toolSuccess(result);
    } catch (error) { return toolError(error); }
  });
  registerTool("set_reminder_url", {
    title: "Set or clear a reminder's separate URL",
    description: "Set one credential-free HTTP(S) URL, or clear it with null, using the exact reminder version. Native URL attachments are created or retired atomically with the reminder. Other attachments and tags are preserved; multiple URL attachments are refused. After WRITE_OUTCOME_UNKNOWN, read get_reminder_organization before any further change; stale versions are never refreshed automatically.",
    inputSchema: ReminderTargetInput.merge(URLChanges).extend({ expectedGeneration }).strict(), outputSchema: MutationOutput("set_url"),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, args => write("set_url", args));
  registerTool("set_reminder_tags", {
    title: "Replace a reminder's tags",
    description: "Replace the complete literal tag-name selection (up to 16 unique names), or remove all tags with an empty array, using the exact reminder version. Names contain no whitespace or controls. Existing selected tag records are retained and protected; removed tags are retired and new tags created in one atomic group. This changes only the selected reminder. After uncertainty, read its organization metadata before another request.",
    inputSchema: ReminderTargetInput.merge(TagChanges).extend({ expectedGeneration }).strict(), outputSchema: MutationOutput("set_tags"),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, args => write("set_tags", args));
  registerTool("move_reminder", {
    title: "Move an ordinary reminder between private lists",
    description: "Move an undated, open, childless root reminder between different owned private standard lists. Require its exact version and both list versions from get_reminder_list. Preserve its identity, content, one URL and ordinary tags; update both memberships and the native parent atomically. Dated, recurring, alarmed, assigned, sectioned, nested reminders and other attachments are refused. Descendant absence is checked with a bounded live read; a new child appearing after that read remains a concurrency limitation. Reconcile uncertain state by exact ID in both lists before another request.",
    inputSchema: MoveReminderInput.extend({ expectedGeneration }).strict(), outputSchema: MutationOutput("move"),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, args => write("move", args));
  registerTool("copy_reminder", {
    title: "Copy an ordinary reminder between private lists",
    description: "Copy an undated, open, childless ordinary root to a different owned private standard list. Require the source reminder and both list versions, plus one stable UUID idempotencyKey. Copy title and notes as plain text, priority, flag, one URL and literal tags; new reminder and related records use fresh identities. Protect the source and destination membership in the same atomic group. Recurrence, schedules, descendants, sections, assignments and other attachments are refused. Retain identical inputs and the same key after WRITE_OUTCOME_UNKNOWN: the saved request fingerprints permit matching exact-ID reconciliation with no further write, even after source/list guard tags advance. Changed inputs or changed copied content return CONFLICT. Up to 128 copy identities are retained encrypted for this Apple session; reminder bodies are never saved.",
    inputSchema: CopyReminderInput.extend({ expectedGeneration }).strict(), outputSchema: MutationOutput("copy"),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, args => write("copy", args));
  registerTool("create_reminder", {
    title: "Create an iCloud reminder",
    description: "Create one open reminder in listId from get_reminder_lists. Requires the authenticated owner and a ready Apple session. Supply a new UUID idempotencyKey for each distinct reminder and keep that same key and input when retrying an uncertain creation; the UUID determines the Apple record ID and prevents duplicate items. Supports title, notes, priority (0 none, 1 high, 5 medium, 9 low), flagged, dueDate with an explicit ISO 8601 offset, timeZone and allDay. An all-day reminder requires a date and time zone. No alarms, recurrence, attachments, subtasks or completion changes are created. WRITE_OUTCOME_UNKNOWN means Apple may have committed: inspect the supplied reminderId and reuse the same idempotencyKey, never create a second key for that attempt. Returned replayed=true means the matching existing item was read and no new write was sent.",
    inputSchema: CreateReminderInput.extend({ expectedGeneration }).strict(),
    outputSchema: MutationOutput("create"),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, args => write("create", args));
  registerTool("create_subtask", {
    title: "Create an iCloud reminder subtask",
    description: "Create one undated, open reminder under an exact open root reminder in the same list. Available to the authenticated owner with a ready Apple session; parentReminder contains its reminderId and current recordChangeTag. Retain one UUID idempotencyKey and identical inputs for reconciliation; matching replay makes no further write even after the parent tag advances. The child create and parent version guard share one atomic group. Recurring, alarmed, dated or nested parents and deeper nesting are refused. Does not create recurrence, alarms or cascade actions. Read parentReminderId in get_reminder/get_reminders to inspect relationships. WRITE_OUTCOME_UNKNOWN requires exact-ID reconciliation, never a replacement create key.",
    inputSchema: CreateSubtaskInput.extend({ expectedGeneration }).strict(), outputSchema: MutationOutput("create_subtask"),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, args => write("create_subtask", args));
  registerTool("set_reminder_parent", {
    title: "Make an iCloud reminder a subtask or return it to top level",
    description: "Move one open undated childless reminder under an exact open root in the same list, or remove its existing parent with parentReminder=null. Requires capabilities.subtasks=true, exact list/reminder IDs and the child recordChangeTag. A destination parent includes its current reminderId and recordChangeTag. The server reads the previous parent from the versioned child and guards both affected parents atomically. Preserves content, dates and untouched tokens. Checks descendants with a bounded complete list read; refuses self-parenting, deeper nesting, cross-list moves, completed/dated/alarmed/recurring nodes and moving parents with children. This is not a bulk-delete eligibility proof or cascade operation. Stale tags return CONFLICT; never refresh them automatically to retry. Reconcile WRITE_OUTCOME_UNKNOWN before any further mutation.",
    inputSchema: SetReminderParentInput.extend({ expectedGeneration }).strict(), outputSchema: MutationOutput("set_parent"),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, args => write("set_parent", args));
  registerTool("update_reminder", {
    title: "Edit an open iCloud reminder",
    description: "Edit one open reminder using listId, reminderId and the current recordChangeTag from get_reminder or get_reminders. Requires the authenticated owner and a ready Apple session. Provide a nonempty changes object with only the fields to edit: title, notes, priority (0/1/5/9), flagged, dueDate, timeZone, allDay, recurrence, earlyReminder or locationAlarm. Omitted fields stay unchanged; null clears a simple reminder's date/time zone, and clearing its date also clears the zone and all-day marker unless explicitly overridden. Text edits replace that field's text formatting; untouched documents are preserved. Timed root reminders with one supported absolute date alarm can change date/time zone atomically with the existing alarm and trigger, protecting and preserving any recurrence. Supply an explicit-offset instant with whole-second precision and an IANA zone; a zone-only change preserves the instant, not the local clock. Known linked dates can be cleared with their recurrence and date alarm retired atomically, preserving a location alarm and removing the early reminder. All-day conversion requires the desired calendar date at midnight UTC (dueDate ending in Z) and removes the time zone; reverse conversion requires explicit dueDate and timeZone. Conversions preserve existing location pairs and early payloads; all-day conversion removes hourly recurrence and preserves other known frequencies. Hourly recurrence requires a timed date. One hourly, daily, weekly, monthly or yearly recurrence can be created on a known dated schedule, edited or removed with null with interval 1–999, weekly ISO weekdays, monthly day numbers or one ordinal weekday, yearly month numbers, and an explicit-offset end instant. Omitted compatible patterns and endDate are preserved; frequency changes clear incompatible patterns. No arbitrary RRULE or anchor/calendar reinterpretation is accepted. One minute/hour/day/week/month early reminder can be created using an exact versioned open same-list source, or its existing offset can be edited while preserving private metadata. Source absence fails closed. One location alarm can be created with full place (title, address, finite latitude/longitude), proximity and radiusMeters, edited through supplied metadata, or removed with null; omitted metadata is preserved. Timed date moves preserve and version-guard the location alarm and trigger. Child scheduling protects the exact same-list open root parent. Repeated local times, multiple date or location alarms, unknown relative payloads and unknown schedules are unsupported. Use prepare_reminder_update for an exact read-only recipe preview. Repeating identical arguments makes no additional change but may return CONFLICT because the version is stale. Read and review before constructing a new request with a fresh tag. WRITE_OUTCOME_UNKNOWN means the change may have saved: read current state first. Never automatically refresh tags, retry or force-update. State changes use separate tools; cannot move lists.",
    inputSchema: PreparedUpdateInput.extend({ expectedGeneration }).strict(),
    outputSchema: MutationOutput("update"),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, args => write("update", args));
  registerTool("prepare_reminder_update", {
    title: "Preview an exact reminder update",
    description: "Read and classify the exact versioned reminder graph without modifying Apple. Returns normalized before/after schedules and an expiring preparation token for supported single-record or linked-date edits. Linked-date moves update an existing absolute date alarm and trigger in place while atomically protecting unchanged recurrence. Known linked date clearing and explicit all-day conversion preserve location alarms; conversion preserves early reminders and removes hourly recurrence. Known recurrence and early reminders can be created, edited or removed through bounded atomic recipes. Early creation validates and version-guards a same-list native metadata source. Child scheduling protects its exact parent. One location alarm can be created from a resolved place, edited or removed; a date move preserves its complete pair with every participant protected. Unknown relative payloads, multiple alarms of the same type and unknown graphs are unsupported. Pass the token with identical arguments to update_reminder; changed graphs or requests are rejected. Completed historical occurrences are never redirected or reopened. A preparation token does not authorize a change.",
    inputSchema: PrepareUpdateInput, outputSchema: PrepareUpdateOutput, annotations: readAnnotations,
  }, async args => {
    try {
      const result = await new AppleConnectionService(env, owner).prepareUpdate(args);
      return toolSuccess(result);
    } catch (error) { return toolError(error); }
  });
  const jobTools = [
    { name: "create_reminder_job", schema: CreateJob, action: "create", description: "Create an empty encrypted draft for bulk_create, bulk_delete, bulk_update or bulk_complete with a UUID job idempotency key and required session generation. Identity comes from authentication. Jobs expire within 24 hours or the existing fixed session deadline, whichever is earlier. Reusing a key with different kind or generation conflicts. No Apple mutation occurs." },
    { name: "append_reminder_job_items", schema: AppendJob, action: "append", description: "Append up to 50 items and 64 KiB to the current draft revision using an idempotent UUID chunk key. Each item includes kind, stable clientItemKey and input. Bulk creates retain their own UUIDs; equal titles with distinct keys remain distinct. Bulk deletes, updates and completions require exact listId, reminderId and recordChangeTag. Bulk updates accept title, notes, priority, flagged, dueDate, timeZone and allDay changes on ordinary childless roots without linked schedules. Date transitions that change linked scheduling fields, including all-day conversions, require an individually prepared update; organization edits are not job inputs. Changed chunk/key reuse conflicts; no dynamic selection or automatic tag refresh. Up to 1,000 items and 2 MiB per sealed job. No Apple mutation occurs." },
    { name: "preview_reminder_job", schema: PreviewJob, action: "preview", description: "Seal and validate the entire immutable draft manifest. Returns a ten-minute owner/account/session-bound preview token, counts and the first 50 exact input summaries or targets; use get_reminder_job to review further pages before authorization. Unsupported items are explicitly failed and never dispatched. Bulk deletes, updates and completions are read-only preflighted: missing, stale, duplicate, recurring, alarmed, nested and parent targets fail here. Updates and completions require open targets; unsupported changes fail before dispatch. No Apple mutation occurs; preview is not user authorization." },
    { name: "start_reminder_job", schema: StartJob, action: "start", description: "Commit the exact sealed manifest using its reviewed preview token after obtaining user authorization. This saves durable authorized work but does not execute Apple mutations in this request. Jobs use request-driven execution: call continue_reminder_job to process each bounded slice, following nextRetryAt and inspecting unknown or paused states. Status reads never run work. Simple bulk creation, deletion, updates and completion are available to the authenticated owner with a ready Apple session and the required job migrations installed. Updates and completion repeat exact-version and childless-root checks and never expand into family operations. Each deletion repeats the exact-version and subtask checks before one soft-delete, then reports any subtask attached natively during commit (SUBTASKS_REMAIN); it never cascades. Cancellation cannot undo dispatched work. No display ordering is claimed." },
    { name: "get_reminder_job", schema: GetJob, action: "get", description: "Read encrypted owner-scoped job status and up to 50 results in original ordinal order. Reports every pending, confirmed, conflicting, failed, cancelled or uncertain item. desiredStateObserved is distinct from operationConfirmed. GET/status never dispatches, renews an Apple session, schedules background work or changes the ledger." },
    { name: "cancel_reminder_job", schema: JobIdentity, action: "cancel", description: "Persist cancellation and stop future dispatches. Already dispatched items remain eligible for read-only reconciliation and may complete. Cancellation is not rollback; it never deletes successful creates or restores deleted targets. Reports unresolved in-flight counts accurately." },
    { name: "resume_reminder_job", schema: JobIdentity, action: "resume", description: "Resume eligible paused work only with the same Apple account, original session generation and unexpired authorized manifest. Honors persisted cooldown. Never silently rebinds a reconnected session, refreshes a deletion tag or replays an uncertain mutation. Use continue_reminder_job for bounded execution or reconciliation." },
    { name: "continue_reminder_job", schema: JobIdentity, action: "continue", description: "Run at most three ledger-selected items using per-operation Apple session leases and a durable account/job lease. Request-driven mode pauses without further calls. Durable dispatch intent is saved before Apple; recovered intent is reconciled read-only and never automatically replayed. Reports lost receipts as unknown even if desired state is observed. Cancellation is checked immediately before dispatch. No credentials or raw Apple payloads are accepted." },
  ] as const;
  for (const tool of jobTools) {
    registerTool(tool.name, {
      title: tool.name.replaceAll("_", " "), description: tool.description, inputSchema: tool.schema, outputSchema: JobOutput,
      annotations: { readOnlyHint: tool.action === "get", destructiveHint: tool.action === "start" || tool.action === "continue", idempotentHint: tool.action !== "get", openWorldHint: true },
    }, async (args: unknown) => {
      try {
        const jobs = new ReminderJobService(env, owner);
        const result = await jobs[tool.action](args);
        return toolSuccess(result);
      } catch (error) { return toolError(error); }
    });
  }
  for (const action of ["complete", "reopen", "delete"] as const) {
    const operation = action === "complete" ? "Complete one open occurrence. Ordinary timed monthly recurrence with interval one and no end or explicit day pattern advances one calendar month from the current due date, preserving local time. Requires a childless root, stored IANA zone and one absolute date pair; supports no early alert or one one-day early alert. A day absent from the next month is refused. Also supports the observed explicit monthly [28,29]/[-1] rule with a one-day early alert, which selects day 29 or February 28. Preserves acknowledgement and account metadata; fresh completed history has an independent alert identity" : action === "reopen" ? "Reopen one completed reminder" : "Delete one open or completed reminder using Apple's Deleted marker";
    const family = action === "delete"
      ? "Soft-delete a bounded ordinary one-level family without recurrence. A family may contain zero or one validated timed absolute date pair per member; parent deletion also soft-deletes each exact pair by its Deleted markers, preserving backlinks and date fields. Direct child deletion soft-deletes only that child’s own pair, if present, and touches the root timestamp; root/sibling dates, pairs and states are preserved. Deleting a child detaches that child from its List and root, removes its List membership and touches the root timestamp; siblings keep their state. Deleting a root detaches it and removes its membership, then marks all discovered children deleted while retaining their List/parent links, completion dates and tokens. Exact family and List versions share one atomic group, limited to 32 records and 64 KiB. Unknown, incomplete, deeper or oversized families are refused. Native unreferenced additions are not universally locked. affectedRecords includes the deleted reminders and any touched root. Retain all exact IDs for reconciliation; get_reminder can return a detached deleted root with listId=null. No hard-delete or restore tool is exposed."
      : "Supports bounded ordinary one-level parent/subtask families without recurrence, including mixtures of undated members, simple dates and one validated timed IANA-zone absolute date pair per member. Complete/reopen retains every exact date pair. Scheduled members cannot have early/location alarms, assignments, tags or attachments. Completing a root completes its open children with one shared timestamp; already completed children keep their state and timestamp. Reopening a root reopens only children whose completion timestamp equals the root's previous timestamp. Completing or reopening a child changes only that child. The complete known family, all date pairs and List are exact-version guarded in one atomic group, limited to 32 records and 64 KiB. Unknown, incomplete, deeper or oversized families are refused. Native additions advanced root/List versions in observed samples; universal protection against unreferenced native additions is not established. affectedRecords lists records whose state changed.";
    registerTool(`${action}_reminder`, {
      title: `${action === "complete" ? "Complete" : action === "reopen" ? "Reopen" : "Delete"} an iCloud reminder`,
      description: `${operation}. Requires the authenticated owner, a ready Apple session, listId, reminderId and the latest recordChangeTag from get_reminder or get_reminders. Use get_reminder for exact completed-item lookup, or includeCompleted=true to page list history. Preserves omitted content, relationships and resolution tokens. ${family} Also supports a private childless nonrecurring root with exactly one absolute date alarm at a timed IANA-zone due date, without early/location alarms, assignments, tags or attachments. Complete/reopen retains the same date pair; delete detaches the root and soft-deletes that exact Alarm and Trigger by their Deleted markers, retaining their backlinks and date fields. The complete graph and List share one atomic exact-version group; no new record IDs or hard deletion. ${action === "complete" ? "Also supports root-only interval-one timed weekly recurrence, non-ended timed daily recurrence with one absolute date pair in a stored IANA zone, all-day daily recurrence and the observed all-day last-day monthly rule. Timed daily advancement preserves a uniquely resolvable local clock across daylight-saving changes; ambiguous or missing next local times are refused. The active ID stays open at the next calendar due date; completedOccurrence is fresh completed history at the old date. An all-day daily interval-one rule may have an inclusive EndDate: omission of recurrenceCalendarTimeZone supports only midnight UTC; an explicit IANA zone interprets the calendar date of any EndDate instant, including midnight instants. Earlier occurrences advance with history, while the final occurrence completes the same active ID without history or due/rule changes. An ended timed weekly rule must end at an exact occurrence on its stored IANA-zone weekly cadence and local clock. Its final occurrence completes the same active ID, retaining the date, rule and optional absolute date pair without new history. A supported weekly or timed daily absolute date alarm on advancing occurrences is replaced by separate active/history pairs and its old exact pair retired atomically. Original ID/tag arguments retain durable occurrence identities; an uncertain retry reads and reconciles those exact IDs without another dispatch. Other recurrence patterns, end conditions and overdue skipping need separate recipes." : action === "reopen" ? "Also reopens the completed exact final root of a timed IANA-zone weekly interval-one rule ending on the same weekly cadence and local clock, with zero or one retained absolute date pair, or an all-day daily interval-one recurrence whose UTC due-date label equals its inclusive end calendar date. For all-day daily rules, supply the same explicit recurrenceCalendarTimeZone for nonmidnight ends; omission supports only midnight UTC. The calendar-zone argument is refused for timed weekly rules. Clears only completion, retaining the due date and rule with no new history or alarm records. Original arguments use retained read-only reconciliation after an uncertain acknowledgment. Other recurring reopening patterns are refused." : "Recurring deletion requires explicit recurringDeletionScope: occurrence or all_future, currently a childless open timed interval-one weekly root in its stored IANA zone with exactly one absolute date pair, or an all-day interval-one daily root or observed last-day monthly root at midnight UTC without stored time zone or alarms. Monthly deletion requires DaysOfTheMonth [28,29,30,31], SetPositions [-1], an actual last-day due date, and no EndDate. These recipes refuse counts and exception patterns. Ended timed weekly deletion uses its stored IANA zone: an occurrence on the local end calendar day retires the root and exact rule/pair even when the raw end clock precedes its due clock. Earlier occurrences advance only when their exact next due instant is within the raw EndDate. If no advance fits before that final day, request explicit all_future or separately review an end-date edit; occurrence returns VALIDATION_ERROR without dispatch. All-day daily may have an inclusive EndDate: omission of recurrenceCalendarTimeZone supports only midnight UTC; an explicit IANA zone interprets any end instant as its calendar date. The calendar argument is refused for no-end daily and every weekly or monthly deletion recipe. occurrence advances the same active ID without completed history; weekly hard-retires only its exact old Alarm/Trigger and creates one fresh next-date pair, while daily and last-day monthly create no new records or pairs. At the final inclusive local weekly or daily date, occurrence retires the root and rule exactly as all_future, retaining the caller scope for reconciliation; completion fields and earlier histories stay unchanged. all_future detaches the active root and soft-deletes its exact current rule and any supported pair, preserving their backlinks, prior histories and unrelated fields. Daily, last-day monthly and ended weekly retirement advance the List ordering token even if its established membership is absent, retaining unchanged membership. All participants and List use one bounded exact-version group. Scope is refused for ordinary deletion. Original ID/tag/scope/calendar-zone arguments retain immutable identities; an uncertain replay reconciles exact outcomes read-only without another dispatch."} Repeating identical arguments causes no additional reminder change but may return CONFLICT because the original version is stale. Read and review before constructing any new request with a fresh tag. WRITE_OUTCOME_UNKNOWN means Apple may have saved the action: reconcile every affected exact ID first. Never automatically retry with a fresh tag or force a write.`,
      inputSchema: ReminderTargetInput.extend({ expectedGeneration, ...(action === "delete" ? { recurringDeletionScope: RecurringDeletionScope.optional(), recurrenceCalendarTimeZone: RecurrenceCalendarTimeZone.optional() } : { recurrenceCalendarTimeZone: RecurrenceCalendarTimeZone.optional() }) }).strict(),
      outputSchema: MutationOutput(action),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    }, args => write(action, args));
  }
  registerTool("connection_status", { title: "Reminders connection status", description: "Report connection state, session generation and available tools without fetching Apple data. A READY session supports bounded reads, basic mutations and one-level subtask relationship tools. The four bulk job kinds also require the installed job schema. writeEnabled and capabilities report current connection and storage availability, not feature rollout flags. Mutation tools enforce owner/session and version checks and never accept Apple credentials.", inputSchema: z.object({}).strict(), outputSchema: ConnectionStatusOutput, annotations }, async () => {
    try {
      const result = await new AppleConnectionService(env, owner).status();
      return toolSuccess(result);
    } catch (error) {
      return toolError(error);
    }
  });
  registerDriveTools(registerTool, env, owner);
  // Only the bounded inline-upload tool can exceed the ordinary 64 KiB request
  // budget. Never grant a larger budget to other tools or JSON-RPC batches.
  let bytes;
  try { bytes = await limitedBytes(new Response(request.body, { headers: request.headers }), INLINE_REQUEST_BYTES); }
  catch (error) {
    if (error instanceof AppError && error.code === "PROTOCOL_CHANGED") throw new AppError("VALIDATION_ERROR", INLINE_UPLOAD_GUIDANCE, 413);
    throw error;
  }
  let message: unknown;
  try { message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { /* SDK handles invalid JSON. */ }
  if (bytes.byteLength > 65_536) {
    const upload = message as { method?: unknown; params?: { name?: unknown } } | null;
    if (!upload || Array.isArray(upload) || upload.method !== "tools/call" || upload.params?.name !== "upload_icloud_drive_file") throw new AppError("VALIDATION_ERROR", "This MCP request exceeds the 64 KiB limit.", 413);
  }
  // Sites uses its stateless 2026 discovery/list/call contract. Keep owner,
  // enabled-tool schemas, callbacks and all byte limits shared with the SDK.
  // The installed SDK transport supports earlier protocol headers; adapt only
  // the two tool methods whose JSON-RPC contracts are unchanged.
  const parsed = JSONRPCRequestSchema.safeParse(message);
  if (!parsed.success && request.headers.get("mcp-method") === "server/discover") {
    const object = message && typeof message === "object" && !Array.isArray(message) ? message as Record<string, unknown> : null;
    console.info({ event: "mcp-discovery-shape", object: object !== null, idType: typeof object?.id,
      knownEnvelopeKeys: object ? Object.keys(object).filter(key => ["jsonrpc", "id", "method", "params", "_meta"].includes(key)) : [],
      unknownEnvelopeKeyCount: object ? Object.keys(object).filter(key => !["jsonrpc", "id", "method", "params", "_meta"].includes(key)).length : 0,
      issueCodes: parsed.error.issues.slice(0, 8).map(issue => issue.code) });
  }
  if (parsed.success && parsed.data.method === "server/discover") {
    return Response.json({ jsonrpc: "2.0", id: parsed.data.id,
      result: { supportedVersions: ["2026-07-28"], capabilities: { tools: {} } } },
      { headers: { "Cache-Control": "private, no-store" } });
  }
  if (request.headers.get("mcp-protocol-version") === "2026-07-28") {
    if (!parsed.success || !["tools/list", "tools/call"].includes(parsed.data.method))
      return Response.json({ jsonrpc: "2.0", id: parsed.success ? parsed.data.id : null,
        error: { code: -32600, message: "The Sites MCP contract requires one discovery, tool-list or tool-call request." } }, { status: 400 });
    const headers = new Headers(request.headers);
    headers.set("mcp-protocol-version", LATEST_PROTOCOL_VERSION);
    request = new Request(request, { headers, body: Uint8Array.from(bytes).buffer });
  }
  request = new Request(request, { body: Uint8Array.from(bytes).buffer });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: INLINE_REQUEST_BYTES });
  try { await server.connect(transport); return await transport.handleRequest(request); }
  finally { await server.close(); }
}
