import { servicePermissionFence } from "../services/permission-fence.ts";
import { requireServiceReady, requireRemindersConnection } from "../auth/apple/services.ts";
import { ServiceSettingsRepository } from "../persistence/service-settings.ts";
import { requireServicePermission } from "../services/settings.ts";
import { z } from "zod";
import type { AppleConnectionService } from "../auth/service.ts";
import { requireAppleEnabled } from "../auth/gates.ts";
import { AppError } from "../errors.ts";
import { accountScope, fingerprint, jsonBytes } from "../lib/canonical.ts";
import { AppleSessionRepository, configuredEnvelopes } from "../persistence/apple-sessions.ts";
import type { RuntimeEnv } from "../platform/sites.ts";
import { CreateReminderInput, ReminderTargetInput, UpdateReminderInput } from "./writes.ts";
import { PrepareUpdateInput, PreparedUpdateInput } from "./preparation.ts";
import { URLChanges, TagChanges } from "./organization.ts";
import { RecurrenceChanges } from "./recurrence.ts";
import { EarlyReminder } from "./early-reminder.ts";
import { LocationAlarmSummary } from "./location-alarm.ts";

// Deliberately one scheduling feature: no new combined native recipes.
export const CreateWorkflowSchedule = z.union([
  z.object({ recurrence: RecurrenceChanges }).strict(),
  z.object({ earlyReminder: EarlyReminder }).strict(),
  z.object({ locationAlarm: LocationAlarmSummary }).strict(),
]);
export const CreateWorkflowInputFields = z.object({
  workflowId: z.string().uuid().transform(value => value.toLowerCase()).describe("Stable workflow UUID and creation key; retain it and identical inputs for recovery."),
  expectedGeneration: z.number().int().nonnegative().safe().describe("Current Apple session generation; a changed account or generation conflicts."),
  create: CreateReminderInput.omit({ idempotencyKey: true }).describe("Ordinary root creation fields; workflowId supplies the stable creation key."),
  schedule: CreateWorkflowSchedule.optional().describe("One existing supported scheduling feature; preparation must confirm its native graph and any witness."),
  url: URLChanges.shape.url.optional().describe("Optional supported HTTP(S) URL to add after creation/scheduling."),
  tags: TagChanges.shape.tags.optional().describe("Optional unique native literal tags to add last."),
}).strict();
export const CreateWorkflowInput = CreateWorkflowInputFields.superRefine((input, context) => {
  const issue = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });
  if (input.create.allDay && (!input.create.dueDate || !input.create.timeZone)) issue("All-day creation requires dueDate and timeZone.");
  if (input.schedule && "recurrence" in input.schedule &&
    (!input.create.allDay || !input.create.dueDate || input.schedule.recurrence.frequency === "hourly"))
    issue("Compound recurrence requires an all-day date and a non-hourly recurrence. Ordinary creation does not establish a timed date-alarm graph.");
  if (input.schedule && "earlyReminder" in input.schedule && !input.create.dueDate) issue("An early reminder requires an existing creation date and a supported same-list metadata witness at preparation.");
  if (input.url === null || input.tags?.length === 0) issue("A new root has no URL or tags to remove; omit empty organization stages.");
});
export type CreateWorkflowInputData = z.input<typeof CreateWorkflowInput>;

const StageName = z.enum(["create", "schedule", "set_url", "set_tags"]);
const StageStatus = z.enum(["pending", "started", "confirmed", "uncertain", "blocked"]);
const State = z.enum(["pending", "paused", "completed", "blocked", "recovery_required"]);
const Version = ReminderTargetInput.shape.recordChangeTag;
const RootReceipt = z.object({ id: ReminderTargetInput.shape.reminderId, listId: CreateReminderInput.shape.listId, recordChangeTag: Version }).strict();
const Failure = z.enum(["CONFLICT", "UNSUPPORTED_FEATURE", "UPSTREAM_UNAVAILABLE", "WRITE_OUTCOME_UNKNOWN"]);
const Stage = z.object({ stage: StageName, status: StageStatus, inputVersion: Version.nullable(),
  outcome: z.record(z.unknown()).nullable(), failure: Failure.nullable() }).strict();
const Payload = z.object({ request: CreateWorkflowInput, stages: z.array(Stage).min(1).max(4),
  rootOutcome: z.record(z.unknown()).nullable(), version: Version.nullable() }).strict();
type PayloadData = z.infer<typeof Payload>;
type StageData = z.infer<typeof Stage>;

export const CreateWorkflowOutput = z.object({
  workflowId: z.string().uuid(), idempotencyKey: z.string().uuid(), reminderId: ReminderTargetInput.shape.reminderId,
  generation: z.number().int().nonnegative().safe(), state: State, replayed: z.boolean(),
  record: RootReceipt.nullable(),
  stages: z.array(z.object({ stage: StageName, status: StageStatus, inputVersion: Version.nullable(),
    record: RootReceipt.nullable(), failure: Failure.nullable() }).strict()).min(1).max(4),
  recovery: z.object({ readOnly: z.literal(true), stage: StageName, inspection: RootReceipt.nullable(),
    inspectionStatus: z.enum(["observed", "missing", "unavailable"]) }).strict().nullable(),
}).strict();
export type CreateWorkflowOutputData = z.infer<typeof CreateWorkflowOutput>;

type Binding = { account: string; generation: number };
type Mutation =
  | (z.infer<typeof CreateReminderInput> & { action: "create"; expectedGeneration: number })
  | (z.infer<typeof PreparedUpdateInput> & { action: "update"; expectedGeneration: number })
  | (z.infer<typeof ReminderTargetInput> & z.infer<typeof URLChanges> & { action: "set_url"; expectedGeneration: number })
  | (z.infer<typeof ReminderTargetInput> & z.infer<typeof TagChanges> & { action: "set_tags"; expectedGeneration: number });

/** Facades must preserve AppleConnectionService's generation fence on EVERY API call. */
export interface CreateWorkflowAppleFacade {
  binding(): Promise<Binding>;
  mutate(input: Mutation): Promise<{ generation: number; record: unknown }>;
  prepareUpdate(input: z.infer<typeof PrepareUpdateInput>): Promise<{ generation: number; supported: boolean; preparationToken: string | null }>;
  readReminderForMCP(generation: number, listId: string, reminderId: string): Promise<{ generation: number; record: unknown; missing: boolean }>;
}

/** Uses existing service APIs only; account replacement also advances its session generation. */
export function createWorkflowAppleFacade(env: RuntimeEnv, owner: string,
  apple: Pick<AppleConnectionService, "mutate" | "prepareUpdate" | "readReminderForMCP">): CreateWorkflowAppleFacade {
  return {
    async binding() {
      requireAppleEnabled(env);
      requireServicePermission((await new ServiceSettingsRepository(env, owner).load()).settings, "reminders.write");
      const saved = await new AppleSessionRepository(env, owner).load();
      requireRemindersConnection(saved.session);
      requireServiceReady(saved.session, saved.state, "reminders", saved.action);
      return { account: await accountScope(owner, saved.session.connection.dsid), generation: saved.fence.generation };
    },
    mutate: input => apple.mutate(input),
    prepareUpdate: input => apple.prepareUpdate(input),
    readReminderForMCP: (generation, listId, reminderId) => apple.readReminderForMCP(generation, listId, reminderId),
  };
}

interface Row { owner_scope: string; workflow_id: string; account_scope: string; generation: number;
  request_hash: string; revision: number; state: z.infer<typeof State>; envelope: string; lease_id: string | null; lease_until: number; }
const Envelope = z.object({ version: z.literal(1), keyId: z.string().min(1).max(64), iv: z.string(), ciphertext: z.string() }).strict();
export const CREATE_WORKFLOW_LEASE_MS = 60_000;
const conflict = (message: string) => new AppError("CONFLICT", message, 409);

/** A maximum of four ordered writes, with a durable fence before each dispatch. */
export class CreateWorkflowService {
  readonly db: D1DatabaseSession;
  readonly env: RuntimeEnv;
  readonly owner: string;
  readonly apple: CreateWorkflowAppleFacade;
  readonly envelopes: ReturnType<typeof configuredEnvelopes>;
  constructor(env: RuntimeEnv, owner: string, apple: CreateWorkflowAppleFacade) {
    if (!env.DB) throw new AppError("CONFIGURATION_REQUIRED", "Persistent create workflow storage is required.", 503);
    if (!owner || owner !== env.REMINDERS_OWNER_ID) throw new AppError("FORBIDDEN", "Create workflows require the deployment owner.", 403);
    this.env = env; this.owner = owner; this.apple = apple;
    this.db = env.DB.withSession("first-primary"); this.envelopes = configuredEnvelopes(env);
  }
  private context(row: Row) {
    return { ownerId: this.owner, accountId: row.account_scope, generation: row.generation,
      recordId: `create-workflow-v1/${row.workflow_id}`, schemaVersion: 1 as const };
  }
  private async encode(row: Row, payload: PayloadData) {
    return JSON.stringify(await this.envelopes.encrypt(Payload.parse(payload), this.context(row)));
  }
  private async decode(row: Row) {
    const payload = Payload.parse(await this.envelopes.decrypt(Envelope.parse(JSON.parse(row.envelope)), this.context(row)));
    if (payload.request.workflowId !== row.workflow_id || payload.request.expectedGeneration !== row.generation ||
      await fingerprint(payload.request) !== row.request_hash) throw new AppError("PROTOCOL_CHANGED", "The workflow request failed verification.", 503);
    return payload;
  }
  private async row(scope: string, id: string) {
    return this.db.prepare("SELECT * FROM reminder_create_workflows WHERE owner_scope = ? AND workflow_id = ?")
      .bind(scope, id).first<Row>();
  }
  private async assertBinding(row: Pick<Row, "account_scope" | "generation">, assertPermission: () => Promise<void>) {
    const current = await this.apple.binding();
    await assertPermission();
    if (current.account !== row.account_scope || current.generation !== row.generation)
      throw conflict("This workflow belongs to a different Apple account or session generation.");
  }
  private async checkpoint(row: Row, lease: string, payload: PayloadData, state: Row["state"]) {
    const envelope = await this.encode(row, payload);
    const changed = await this.db.prepare(`UPDATE reminder_create_workflows SET envelope = ?, state = ?, revision = revision + 1
      WHERE owner_scope = ? AND workflow_id = ? AND account_scope = ? AND generation = ? AND request_hash = ?
      AND revision = ? AND lease_id = ? AND lease_until > ?`)
      .bind(envelope, state, row.owner_scope, row.workflow_id, row.account_scope, row.generation, row.request_hash,
        row.revision, lease, Date.now()).run();
    if (changed.meta.changes !== 1) throw conflict("The workflow lease was lost before progress could be saved. Inspect the retained stage; never redispatch it.");
    row.revision++; row.envelope = envelope; row.state = state;
  }
  private async assertLease(row: Row, lease: string) {
    const active = await this.db.prepare(`SELECT revision FROM reminder_create_workflows
      WHERE owner_scope = ? AND workflow_id = ? AND revision = ? AND lease_id = ? AND lease_until > ?`)
      .bind(row.owner_scope, row.workflow_id, row.revision, lease, Date.now()).first();
    if (!active) throw conflict("The workflow lease expired before dispatch.");
  }
  private receipt(outcome: Record<string, unknown> | null, row: Row, request: PayloadData["request"]) {
    if (!outcome) return null;
    const parsed = z.object({ id: z.string(), listId: z.string(), recordChangeTag: Version,
      completed: z.literal(false), deleted: z.literal(false), parentReminderId: z.null() }).passthrough().safeParse(outcome.record);
    if (!parsed.success) throw new AppError("PROTOCOL_CHANGED", "The root outcome does not establish an exact open, nondeleted root version.", 503);
    const record = parsed.data;
    if (outcome.generation !== row.generation || record.id !== `Reminder/${row.workflow_id.toUpperCase()}` || record.listId !== request.create.listId)
      throw conflict("Apple returned a different root identity, list or generation.");
    return RootReceipt.parse({ id: record.id, listId: record.listId, recordChangeTag: record.recordChangeTag });
  }
  private output(row: Row, payload: PayloadData, replayed: boolean, recovery: CreateWorkflowOutputData["recovery"] = null) {
    const started = payload.stages.some(stage => stage.status === "started" || stage.status === "uncertain");
    return CreateWorkflowOutput.parse({ workflowId: row.workflow_id, idempotencyKey: row.workflow_id,
      reminderId: `Reminder/${row.workflow_id.toUpperCase()}`, generation: row.generation,
      state: started ? "recovery_required" : row.state, replayed, record: this.receipt(payload.rootOutcome, row, payload.request),
      stages: payload.stages.map(stage => ({ stage: stage.stage, status: stage.status, inputVersion: stage.inputVersion,
        record: this.receipt(stage.outcome, row, payload.request), failure: stage.failure })), recovery });
  }
  private async recover(row: Row, payload: PayloadData, replayed: boolean, assertPermission: () => Promise<void>) {
    const stage = payload.stages.find(stage => stage.status === "started" || stage.status === "uncertain")!;
    let inspection: z.infer<typeof RootReceipt> | null = null;
    let inspectionStatus: "observed" | "missing" | "unavailable" = "unavailable";
    try {
      await this.assertBinding(row, assertPermission);
      const result = await this.apple.readReminderForMCP(row.generation, payload.request.create.listId, `Reminder/${row.workflow_id.toUpperCase()}`);
      if (result.generation !== row.generation) throw conflict("The inspection used a different generation.");
      if (result.missing && result.record === null) inspectionStatus = "missing";
      else { inspection = this.receipt(result, row, payload.request); inspectionStatus = "observed"; }
    } catch (error) {
      // Binding and permission failures remain errors; other read failures retain partial receipts.
      if (error instanceof AppError && ["CONFLICT", "FORBIDDEN", "DEVICE_APPROVAL_PENDING"].includes(error.code)) throw error;
    }
    return this.output(row, payload, replayed, { readOnly: true, stage: stage.stage, inspection, inspectionStatus });
  }
  async run(value: unknown): Promise<CreateWorkflowOutputData> {
    const permissions = await servicePermissionFence(this.env, this.owner, "reminders.write", true);
    try { return await this.runBound(value, permissions.assertCurrent); }
    finally { await permissions.assertCurrent(); }
  }

  private async runBound(value: unknown, assertPermission: () => Promise<void>): Promise<CreateWorkflowOutputData> {
    const parsed = CreateWorkflowInput.safeParse(value);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "Provide a bounded create workflow with one supported scheduling feature and exact organization values.", 400);
    const installed = await this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reminder_create_workflows'").first<{ name: string }>();
    if (!installed) throw new AppError("CONFIGURATION_REQUIRED", "Apply migration 0006_create_workflows.sql before using create workflows.", 503);
    const request = parsed.data;
    if (jsonBytes(request) > 65_536) throw new AppError("VALIDATION_ERROR", "The create workflow request exceeds 64 KiB.", 400);
    const binding = await this.apple.binding();
    await assertPermission();
    if (!/^[a-f0-9]{64}$/.test(binding.account) || binding.generation !== request.expectedGeneration)
      throw conflict("The workflow requires the current account hash and exact session generation.");
    const scope = await fingerprint(["create-workflow-owner-v1", this.owner]);
    const hash = await fingerprint(request);
    let row = await this.row(scope, request.workflowId), replayed = row !== null;
    if (!row) {
      const stages: StageData[] = (["create", ...(request.schedule ? ["schedule"] : []),
        ...(request.url !== undefined ? ["set_url"] : []), ...(request.tags !== undefined ? ["set_tags"] : [])] as StageData["stage"][])
        .map(stage => ({ stage, status: "pending", inputVersion: null, outcome: null, failure: null }));
      const candidate: Row = { owner_scope: scope, workflow_id: request.workflowId, account_scope: binding.account,
        generation: binding.generation, request_hash: hash, revision: 0, state: "pending", envelope: "", lease_id: null, lease_until: 0 };
      const envelope = await this.encode(candidate, { request, stages, rootOutcome: null, version: null });
      const inserted = await this.db.prepare(`INSERT INTO reminder_create_workflows
        (owner_scope, workflow_id, account_scope, generation, request_hash, revision, state, envelope)
        VALUES (?, ?, ?, ?, ?, 0, 'pending', ?) ON CONFLICT (owner_scope, workflow_id) DO NOTHING`)
        .bind(scope, request.workflowId, binding.account, binding.generation, hash, envelope).run();
      replayed = inserted.meta.changes !== 1;
      row = await this.row(scope, request.workflowId);
    }
    if (!row) throw conflict("The workflow could not be loaded.");
    if (row.account_scope !== binding.account || row.generation !== binding.generation || row.request_hash !== hash)
      throw conflict("This workflow identity is already bound to different inputs, an account or a session.");
    let payload = await this.decode(row);
    if (payload.stages.some(stage => ["started", "uncertain"].includes(stage.status))) return this.recover(row, payload, true, assertPermission);
    if (row.state === "completed" || row.state === "blocked") return this.output(row, payload, true);
    const lease = crypto.randomUUID(), until = Date.now() + CREATE_WORKFLOW_LEASE_MS;
    const claimed = await this.db.prepare(`UPDATE reminder_create_workflows SET lease_id = ?, lease_until = ?, revision = revision + 1
      WHERE owner_scope = ? AND workflow_id = ? AND revision = ? AND lease_until <= ?`)
      .bind(lease, until, scope, row.workflow_id, row.revision, Date.now()).run();
    if (claimed.meta.changes !== 1) throw conflict("Another call owns this create workflow lease.");
    row.revision++; row.lease_id = lease; row.lease_until = until;
    try {
      for (const stage of payload.stages) {
        if (stage.status === "confirmed") continue;
        let mutation: Mutation;
        try {
          await this.assertBinding(row, assertPermission);
          await this.assertLease(row, lease);
          if (stage.stage === "create") {
            mutation = { ...CreateReminderInput.parse({ ...request.create, idempotencyKey: request.workflowId }), action: "create", expectedGeneration: row.generation };
          } else {
            const current = await this.apple.readReminderForMCP(row.generation, request.create.listId, `Reminder/${row.workflow_id.toUpperCase()}`);
            const receipt = this.receipt(current, row, request);
            if (!receipt || current.missing || receipt.recordChangeTag !== payload.version)
              throw conflict("The root changed after a confirmed stage. Its exact stored version cannot be replaced.");
            const target = { listId: request.create.listId, reminderId: receipt.id, recordChangeTag: receipt.recordChangeTag, expectedGeneration: row.generation };
            if (stage.stage === "schedule") {
              const update = PrepareUpdateInput.parse({ ...target, changes: request.schedule });
              const plan = await this.apple.prepareUpdate(update);
              if (plan.generation !== row.generation) throw conflict("Preparation used a different generation.");
              if (!plan.supported || !plan.preparationToken) throw new AppError("UNSUPPORTED_FEATURE", "The existing planner did not witness this schedule on the exact root graph.");
              mutation = { ...PreparedUpdateInput.parse({ ...UpdateReminderInput.parse({ listId: update.listId, reminderId: update.reminderId,
                recordChangeTag: update.recordChangeTag, changes: update.changes }), preparationToken: plan.preparationToken }), action: "update", expectedGeneration: row.generation };
            } else if (stage.stage === "set_url") mutation = { ...target, action: "set_url", ...URLChanges.parse({ url: request.url }) };
            else mutation = { ...target, action: "set_tags", ...TagChanges.parse({ tags: request.tags }) };
          }
          await this.assertBinding(row, assertPermission);
          stage.inputVersion = payload.version;
          stage.status = "started"; stage.failure = null;
          await this.checkpoint(row, lease, payload, "pending");
          await this.assertBinding(row, assertPermission);
          await this.assertLease(row, lease);
        } catch (error) {
          await this.assertBinding(row, assertPermission);
          // If a durable start may have been saved, fail closed even if its acknowledgement was lost.
          const retained = await this.row(scope, row.workflow_id);
          if (!retained) throw error;
          payload = await this.decode(retained);
          if (payload.stages.some(item => ["started", "uncertain"].includes(item.status))) return this.recover(retained, payload, replayed, assertPermission);
          const savedStage = payload.stages.find(item => item.stage === stage.stage)!;
          const terminal = error instanceof AppError && ["CONFLICT", "UNSUPPORTED_FEATURE", "VALIDATION_ERROR", "FORBIDDEN", "PROTOCOL_CHANGED"].includes(error.code);
          savedStage.status = terminal ? "blocked" : "pending";
          savedStage.failure = error instanceof AppError && error.code === "UNSUPPORTED_FEATURE" ? "UNSUPPORTED_FEATURE" : terminal ? "CONFLICT" : "UPSTREAM_UNAVAILABLE";
          await this.checkpoint(row, lease, payload, terminal ? "blocked" : "paused");
          return this.output(row, payload, replayed);
        }
        try {
          await assertPermission();
          const outcome = await this.apple.mutate(mutation);
          if (jsonBytes(outcome) > 65_536) throw new Error("Oversized root outcome");
          const receipt = this.receipt(outcome, row, request);
          if (!receipt || stage.stage !== "create" && receipt.recordChangeTag === stage.inputVersion) throw new Error("Unconfirmed root version");
          stage.status = "confirmed"; stage.outcome = outcome; payload.rootOutcome = outcome; payload.version = receipt.recordChangeTag;
          await this.checkpoint(row, lease, payload, payload.stages.every(item => item.status === "confirmed") ? "completed" : "pending");
        } catch {
          // EVERY failure after a start is uncertain, including local persistence/confirmation failures.
          // Never classify a service error as safe to redispatch.
          const retained = await this.row(scope, row.workflow_id);
          if (!retained) throw conflict("The started workflow is unavailable for recovery.");
          payload = await this.decode(retained);
          const savedStage = payload.stages.find(item => item.stage === stage.stage)!;
          if (savedStage.status === "confirmed") return this.output(retained, payload, replayed);
          savedStage.status = "uncertain"; savedStage.failure = "WRITE_OUTCOME_UNKNOWN";
          try { await this.checkpoint(row, lease, payload, "recovery_required"); }
          catch { /* Keep the durable started fence when this lease expired or changed. */ }
          const latest = await this.row(scope, row.workflow_id);
          if (!latest) throw conflict("The started workflow is unavailable for recovery.");
          return this.recover(latest, await this.decode(latest), replayed, assertPermission);
        }
      }
      return this.output(row, payload, replayed);
    } finally {
      await this.db.prepare("UPDATE reminder_create_workflows SET lease_id = NULL, lease_until = 0 WHERE owner_scope = ? AND workflow_id = ? AND lease_id = ?")
        .bind(scope, row.workflow_id, lease).run();
    }
  }
}
