import { z } from "zod";
import { RecurrenceCalendarTimeZone } from "../reminders/recurrence-calendar.ts";
import { AuthSnapshotSchema, type AuthSnapshot } from "../auth/apple/http.ts";
import { AppleServicesSchema, PcsCheckpointSchema, requireRemindersConnection, sessionServices, type AppleServices, type CommonAppleConnection } from "../auth/apple/services.ts";
import type { PcsCheckpoint } from "../auth/apple/pcs.ts";
import { Envelopes, type Envelope, type EnvelopeContext } from "../crypto/envelopes.ts";
import { AppError } from "../errors.ts";
import type { RuntimeEnv } from "../platform/sites.ts";
import { validatedAppleURL } from "../transport/apple-http.ts";
import { LoginAssuranceSchema, RETENTION_POLICY, SESSION_RETENTION_MS, requireCurrentLogin, type LoginAssurance } from "../auth/apple/policy.ts";
import { RenewalCheckpointSchema, type RenewalCheckpoint } from "../auth/apple/session-renewal.ts";
import { SectionScanSchema, type SectionScan } from "../reminders/sections.ts";

const ACCOUNT = "apple-reminders";
const RECORD = "apple-session";
const SETUP_LEASE_MS = 180_000;
const RESUME_LEASE_MS = 30_000;
const MigrationApprovalSchema = z.object({
  migrationId: z.string().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/),
  owner: z.string().min(1).max(256), account: z.literal(ACCOUNT),
  generation: z.number().int().nonnegative().safe(),
}).strict();
const APPROVAL_ACTIONS = ["approve-device-consent", "wait-for-reminders-keys"] as const;
const cloudKitURL = z.string().max(2048).url().refine((value) => {
  try {
    const url = validatedAppleURL(value, true);
    return url.pathname === "/database/1/com.apple.reminders/production/private" && !url.search;
  } catch { return false; }
}, "Invalid CloudKit service URL.");
const CloudKitConnectionSchema = z.object({
  dsid: z.string().min(1).max(32).regex(/^\d+$/),
  clientId: z.string().min(1).max(100).regex(/^[A-Za-z0-9-]+$/),
  clientBuildNumber: z.string().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/),
  clientMasteringNumber: z.string().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/),
  cloudKitURL: cloudKitURL.optional(),
  remindersZoneOwner: z.string().min(1).max(256).refine(value => !/[\u0000-\u0020\u007f]/.test(value)).optional(),
}).strict();
export const SavedListSchema = z.object({
  id: z.string().min(6).max(512).regex(/^List\/[^/\u0000-\u0020\u007f]+$/),
  title: z.string().max(256).nullable(),
  deleted: z.boolean(),
  isGroup: z.boolean(),
  checkedAt: z.number().int().nonnegative().safe(),
}).strict();
const SavedListsSchema = z.array(SavedListSchema).max(1000).refine(lists => new Set(lists.map(list => list.id)).size === lists.length, "Saved list identifiers must be unique.");
export type SavedList = z.infer<typeof SavedListSchema>;
export function mergeSavedLists(previous: SavedList[], records: { id: string; title?: string | null; deleted?: boolean | null; isGroup?: boolean | null }[], now = Date.now()): SavedList[] {
  const merged = new Map(previous.map(list => [list.id, list]));
  for (const record of records) {
    merged.set(record.id, SavedListSchema.parse({ id: record.id, title: record.title?.slice(0, 256) ?? null, deleted: !!record.deleted, isGroup: !!record.isGroup, checkedAt: now }));
  }
  if (merged.size > 1000) throw new AppError("UNSUPPORTED_FEATURE", "The saved list snapshot reached its 1,000-identifier limit.", 409);
  return [...merged.values()];
}
const AllOpenScanSchema = z.object({
  permissionRevision: z.number().int().nonnegative().safe().optional(),
  token: z.string().uuid(),
  expiresAt: z.number().int().positive().safe(),
  listIds: z.array(SavedListSchema.shape.id).max(1000).refine(ids => new Set(ids).size === ids.length),
  index: z.number().int().min(0).max(1000),
  cursor: z.string().min(1).max(8192).refine(value => !/[\u0000-\u001f\u007f]/.test(value)).nullable(),
  seen: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(1000),
  listPages: z.number().int().min(0).max(1000),
  totalPages: z.number().int().min(0).max(10000),
  caughtUpAt: z.number().int().nonnegative().safe(),
  source: z.literal("direct-cloudkit-query"),
  lists: SavedListsSchema,
}).strict().refine(scan => scan.index <= scan.listIds.length, "The all-open scan list index is invalid.")
  .refine(scan => scan.lists.length === scan.listIds.length && scan.lists.every((list, index) => list.id === scan.listIds[index] && !list.deleted && !list.isGroup), "The all-open list selection is inconsistent.");
export type AllOpenScan = z.infer<typeof AllOpenScanSchema>;
const SearchScanSchema = z.object({
  permissionRevision: z.number().int().nonnegative().safe().optional(),
  token: z.string().uuid(),
  expiresAt: z.number().int().positive().safe(),
  accountHash: z.string().regex(/^[a-f0-9]{64}$/),
  filtersHash: z.string().regex(/^[a-f0-9]{64}$/),
  inventoryHash: z.string().regex(/^[a-f0-9]{64}$/),
  listIds: z.array(SavedListSchema.shape.id).max(1000).refine(ids => new Set(ids).size === ids.length),
  index: z.number().int().min(0).max(1000),
  cursor: z.string().min(1).max(8192).refine(value => !/[\u0000-\u001f\u007f]/.test(value)).nullable(),
  seen: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(1000),
  listPages: z.number().int().min(0).max(1000),
  totalPages: z.number().int().min(0).max(10000),
}).strict().refine(scan => scan.index <= scan.listIds.length, "The search scan list index is invalid.");
export type SearchScan = z.infer<typeof SearchScanSchema>;
const CategoryScanSchema = z.object({
  permissionRevision: z.number().int().nonnegative().safe().optional(),
  token: z.string().uuid(), expiresAt: z.number().int().positive().safe(),
  accountHash: z.string().regex(/^[a-f0-9]{64}$/), listId: SavedListSchema.shape.id,
  limit: z.number().int().min(1).max(200), cursor: z.string().min(1).max(8192),
  seen: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(1000), pages: z.number().int().min(1).max(1000),
}).strict();
export type CategoryScan = z.infer<typeof CategoryScanSchema>;
// Compatibility is limited to recognized retired fields; unknown active fields
// still fail strict validation. No credentials, login policy or fences change.
function discardRetiredCatalogueState(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const current = { ...value } as Record<string, unknown>;
  for (const field of ["diagnosticCatalogue", "catalogueSync", "catalogueAuto", "legacySavedLists"]) delete current[field];
  const scan = current.allOpenScan;
  if (scan && typeof scan === "object" && !Array.isArray(scan)) {
    const source = (scan as Record<string, unknown>).source;
    // Old historical selections cannot claim to be a complete direct discovery.
    // Retire only their continuation, preserving the valid Apple connection.
    if (source === undefined || source === "legacy-catalogue") delete current.allOpenScan;
  }
  return current;
}
export const RecurringCompletionRequestSchema = z.object({
  listId: z.string().min(6).max(255).startsWith("List/"),
  reminderId: z.string().min(10).max(255).startsWith("Reminder/"),
  recordChangeTag: z.string().min(1).max(512),
  expectedGeneration: z.number().int().nonnegative().safe(),
  recurrenceCalendarTimeZone: RecurrenceCalendarTimeZone.optional(),
}).strict();
export type RecurringCompletionRequest = z.infer<typeof RecurringCompletionRequestSchema>;
export const RecurringIntentSchema = z.object({
  requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/), sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  timestamp: z.number().int().nonnegative().safe(), phase: z.enum(["prepared", "dispatched", "confirmed"]),
  ids: z.object({ history: z.string().uuid().optional(), activeAlarm: z.string().uuid().optional(), activeTrigger: z.string().uuid().optional(),
    historyAlarm: z.string().uuid().optional(), historyTrigger: z.string().uuid().optional(), replicas: z.array(z.string().uuid()).length(24) }).strict(),
  expected: z.array(z.object({ id: z.string().max(255), type: z.enum(["Reminder", "List", "RecurrenceRule", "Alarm", "AlarmTrigger"]),
    hash: z.string().regex(/^[a-f0-9]{64}$/), presentationHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict()).min(3).max(8),
  retired: z.array(z.string().max(255)).max(2),
  mode: z.enum(["final", "reopen"]).optional(),
  recurrenceCalendarTimeZone: RecurrenceCalendarTimeZone.optional(),
  intrinsicParentGuards: z.literal(true).optional(),
  operation: z.literal("delete").optional(),
  recurringDeletionScope: z.enum(["occurrence", "all_future"]).optional(),
  recurringDeletionRecipe: z.enum(["all_day_daily", "all_day_daily_ended", "timed_weekly_ended", "all_day_last_day_monthly"]).optional(),
  recurringDeletionTerminal: z.literal(true).optional(),
  completionRequest: RecurringCompletionRequestSchema.optional(),
}).strict().superRefine((intent, context) => {
  if (intent.completionRequest && (intent.operation || intent.mode === "reopen" ||
    intent.completionRequest.recurrenceCalendarTimeZone !== intent.recurrenceCalendarTimeZone ||
    intent.expected.find(record => record.type === "Reminder")?.id !== intent.completionRequest.reminderId ||
    !intent.expected.some(record => record.type === "List" && record.id === intent.completionRequest!.listId)))
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A completion request must identify its retained root, List and calendar zone." });
  if (intent.operation === "delete") {
    const endedDaily = intent.recurringDeletionRecipe === "all_day_daily_ended";
    const ended = endedDaily || intent.recurringDeletionRecipe === "timed_weekly_ended";
    const unpaired = intent.recurringDeletionRecipe === "all_day_daily" || endedDaily || intent.recurringDeletionRecipe === "all_day_last_day_monthly";
    const types = unpaired ? ["Reminder", "List", "RecurrenceRule"] : ["Reminder", "List", "RecurrenceRule", "Alarm", "AlarmTrigger"];
    const occurrence = intent.recurringDeletionScope === "occurrence" && !unpaired && intent.recurringDeletionTerminal !== true;
    if (!intent.recurringDeletionScope || intent.mode !== undefined || !endedDaily && intent.recurrenceCalendarTimeZone !== undefined || !ended && intent.recurringDeletionTerminal !== undefined ||
      ended && intent.recurringDeletionScope === "all_future" && intent.recurringDeletionTerminal !== true || intent.intrinsicParentGuards !== true ||
      intent.expected.length !== types.length || new Set(intent.expected.map(record => record.type)).size !== types.length || new Set(intent.expected.map(record => record.id)).size !== types.length ||
      intent.expected.some(record => !types.includes(record.type) || !record.id.startsWith(`${record.type}/`)) ||
      Object.keys(intent.ids).some(key => !["replicas", ...(occurrence ? ["activeAlarm", "activeTrigger"] : [])].includes(key)) ||
      (occurrence ? !intent.ids.activeAlarm || !intent.ids.activeTrigger || intent.ids.activeAlarm === intent.ids.activeTrigger ||
        !intent.expected.some(record => record.id === `Alarm/${intent.ids.activeAlarm}`) || !intent.expected.some(record => record.id === `AlarmTrigger/${intent.ids.activeTrigger}`) ||
        intent.retired.length !== 2 || new Set(intent.retired).size !== 2 || !intent.retired.some(id => id.startsWith("Alarm/")) || !intent.retired.some(id => id.startsWith("AlarmTrigger/")) ||
        intent.retired.some(id => intent.expected.some(record => record.id === id)) : intent.retired.length !== 0))
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Recurring deletion requires its explicit scope, exact recipe-specific outcome and disjoint retained identities." });
    return;
  }
  if (intent.recurringDeletionScope !== undefined || intent.recurringDeletionRecipe !== undefined || intent.recurringDeletionTerminal !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: "Deletion scope requires a deletion-specific intent." });
  if (intent.mode === undefined) {
    if (intent.intrinsicParentGuards || intent.expected.length < 4 || ["history", "activeAlarm", "activeTrigger", "historyAlarm", "historyTrigger"].some(key => !intent.ids[key as keyof typeof intent.ids]))
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Advancing recurrence requires its original retained record identities and complete graph." });
  } else {
    const types = intent.expected.length === 5 && intent.intrinsicParentGuards ? ["Reminder", "List", "RecurrenceRule", "Alarm", "AlarmTrigger"] : ["Reminder", "List", "RecurrenceRule"];
    if (intent.expected.length !== types.length || intent.retired.length || Object.keys(intent.ids).some(key => key !== "replicas") ||
      intent.intrinsicParentGuards && intent.recurrenceCalendarTimeZone !== undefined || new Set(intent.expected.map(record => record.type)).size !== types.length ||
      new Set(intent.expected.map(record => record.id)).size !== types.length || intent.expected.some(record => !types.includes(record.type) || !record.id.startsWith(`${record.type}/`)))
      context.addIssue({ code: z.ZodIssueCode.custom, message: "An in-place ended occurrence retains only its active, rule, List, optional guarded date pair and token identities." });
  }
});
export type RecurringIntent = z.infer<typeof RecurringIntentSchema>;
export const AppleSessionSchema = z.preprocess(discardRetiredCatalogueState, z.object({
  auth: AuthSnapshotSchema,
  connection: CloudKitConnectionSchema,
  services: AppleServicesSchema.optional(),
  readContinuations: z.array(z.object({ cursor: z.string().min(1).max(8192), listId: SavedListSchema.shape.id, includeCompleted: z.boolean(), limit: z.number().int().min(1).max(200), permissionRevision: z.number().int().nonnegative().safe(), expiresAt: z.number().int().positive().safe() }).strict()).max(32).optional(),
  pcs: PcsCheckpointSchema,
  login: LoginAssuranceSchema,
  renewal: RenewalCheckpointSchema.optional(),
  allOpenScan: AllOpenScanSchema.optional(),
  searchScan: SearchScanSchema.optional(),
  categoryScan: CategoryScanSchema.optional(),
  sectionScan: SectionScanSchema.optional(),
  recurringIntents: z.array(RecurringIntentSchema).max(256).refine(items => new Set(items.map(item => item.requestFingerprint)).size === items.length).optional(),
  copyIntents: z.array(z.object({ id: z.string().uuid(), requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    contentFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(128).optional(),
  savedLists: SavedListsSchema.optional(),
  // Optional metadata preserves version-1 encrypted list snapshots.
  directListSnapshot: z.object({ updatedAt: z.number().int().nonnegative().safe() }).strict().optional(),
}).strict().superRefine((session, context) => {
  if (session.auth.clientId !== session.connection.clientId || !session.services && !session.connection.cloudKitURL ||
      session.services?.reminders.state !== undefined && session.services.reminders.state !== "UNAVAILABLE" && !session.connection.cloudKitURL) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "The common account and Reminders discovery are inconsistent." });
  }
  const drive = session.services?.drive.connection;
  if (drive && ["dsid", "clientId", "clientBuildNumber", "clientMasteringNumber"].some(key => drive[key as keyof typeof drive] !== session.connection[key as keyof typeof session.connection])) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Drive must belong to the same Apple account and client." });
  }
}));
export type AppleSession = {
  auth: AuthSnapshot;
  connection: CommonAppleConnection;
  services?: AppleServices;
  readContinuations?: { cursor: string; listId: string; includeCompleted: boolean; limit: number; permissionRevision: number; expiresAt: number }[];
  pcs: PcsCheckpoint;
  login: LoginAssurance;
  renewal?: RenewalCheckpoint;
  allOpenScan?: AllOpenScan;
  searchScan?: SearchScan;
  categoryScan?: CategoryScan;
  sectionScan?: SectionScan;
  recurringIntents?: RecurringIntent[];
  copyIntents?: { id: string; requestFingerprint: string; contentFingerprint: string }[];
  savedLists?: SavedList[];
  directListSnapshot?: { updatedAt: number };
};
export type ApprovalAction = typeof APPROVAL_ACTIONS[number];
export type AppleSessionState = "READY" | "DEVICE_APPROVAL_PENDING";
export interface SessionFence { generation: number; version: number; }
export interface SetupFence extends SessionFence { transactionId: string; expiresAt: number; }
export interface ResumeFence extends SessionFence { resumeId: string; expiresAt: number; }
export interface AppleSessionStatus extends SessionFence {
  state: "DISCONNECTED" | "CONNECTING" | AppleSessionState;
  action: ApprovalAction | null;
  nextAttemptAt: number;
  transportReady: boolean;
  liveReadValidated: false;
  expiresAt: number | null;
  retentionDays: number | null;
  retentionSource: "interactive-consent" | "owner-authorised-migration" | "legacy-consent" | null;
  lastValidatedAt: number | null;
  lastAppleSuccessAt: number | null;
  lastRenewedAt: number | null;
  nextRetryAt: number | null;
  services: AppleServices | null;
  accountAuthenticated: boolean;
  requiredAction: RenewalCheckpoint["requiredAction"] | "local-retention-expired" | "apple-sign-in";
}

interface StateRow extends SessionFence {
  state: string;
  action: string | null;
  next_attempt_at: number;
  envelope: string | null;
  transaction_id: string | null;
  transaction_expires_at: number | null;
  resume_id: string | null;
  resume_expires_at: number | null;
}
type FenceRow = SessionFence;

export function configuredEnvelopes(env: RuntimeEnv) {
  if (!env.ENCRYPTION_KEY_ID || !env.ENCRYPTION_KEYS_JSON) throw new AppError("CONFIGURATION_REQUIRED", "The server-only encryption secret must be configured before Apple sessions can be stored.", 503);
  let keys: unknown;
  try { keys = JSON.parse(env.ENCRYPTION_KEYS_JSON); }
  catch { throw new AppError("CONFIGURATION_REQUIRED", "The encryption key ring is invalid.", 503); }
  return new Envelopes(env.ENCRYPTION_KEY_ID, keys as Record<string, string>);
}

function invalidSession() {
  return new AppError("REAUTH_REQUIRED", "The saved Apple session is invalid. Reconnect through setup.", 409);
}

function connectionAction(state: AppleSessionState, action?: ApprovalAction): ApprovalAction | null {
  if (state === "READY" && action === undefined) return null;
  if (state === "DEVICE_APPROVAL_PENDING" && action && APPROVAL_ACTIONS.includes(action)) return action;
  throw new AppError("VALIDATION_ERROR", "The Apple session state and approval action do not match.", 400);
}

function envelopeFromJSON(value: string): Envelope {
  let raw: unknown;
  try { raw = JSON.parse(value); } catch { throw new AppError("PROTOCOL_CHANGED", "The saved Apple session envelope is invalid.", 503); }
  const parsed = z.object({ version: z.literal(1), keyId: z.string().min(1).max(64), iv: z.string(), ciphertext: z.string() }).strict().safeParse(raw);
  if (!parsed.success) throw new AppError("PROTOCOL_CHANGED", "The saved Apple session envelope is invalid.", 503);
  return parsed.data;
}

export class AppleSessionRepository {
  readonly db: D1DatabaseSession;
  readonly owner: string;
  readonly envelopes: Envelopes;
  private readonly env: RuntimeEnv;
  private readonly migration: z.infer<typeof MigrationApprovalSchema> | null;

  constructor(env: RuntimeEnv, owner: string, envelopes = configuredEnvelopes(env)) {
    if (!env.DB) throw new AppError("CONFIGURATION_REQUIRED", "Persistent storage has not been provisioned.", 503);
    if (typeof owner !== "string" || owner.length < 1 || owner.length > 256) throw new AppError("VALIDATION_ERROR", "An authenticated owner is required.", 400);
    this.db = env.DB.withSession("first-primary");
    this.owner = owner;
    this.env = env;
    this.envelopes = envelopes;
    this.migration = null;
    if (env.APPLE_SESSION_RETENTION_MIGRATION_JSON) {
      let value: unknown;
      try { value = JSON.parse(env.APPLE_SESSION_RETENTION_MIGRATION_JSON); }
      catch { throw new AppError("CONFIGURATION_REQUIRED", "The retention migration approval is invalid.", 503); }
      const approval = MigrationApprovalSchema.safeParse(value);
      if (!approval.success || !env.REMINDERS_OWNER_ID || approval.data.owner !== env.REMINDERS_OWNER_ID) throw new AppError("CONFIGURATION_REQUIRED", "The retention migration approval must bind the configured owner, account and generation.", 503);
      this.migration = approval.data;
    }
  }

  private async clearPreviousDriveState(generation: number) {
    // Existing deployments without Drive tables keep their current setup flow.
    // Strictly older generations prevents deleting a concurrent new session.
    if (this.env.REMINDERS_OWNER_ID !== this.owner) return;
    const { DriveOperationRepository } = await import("./drive-operations.ts");
    const repository = new DriveOperationRepository(this.env, this.owner);
    if (await repository.available()) await repository.clearBeforeGeneration(generation);
  }

  private async ensureRow() {
    await this.db.prepare("INSERT OR IGNORE INTO apple_session_state (owner_id, account_id) VALUES (?, ?)").bind(this.owner, ACCOUNT).run();
  }

  async status(retry = 0): Promise<AppleSessionStatus> {
    const row = await this.db.prepare("SELECT generation, version, state, action, next_attempt_at, transaction_expires_at FROM apple_session_state WHERE owner_id = ? AND account_id = ?")
      .bind(this.owner, ACCOUNT).first<{ generation: number; version: number; state: string; action: string | null; next_attempt_at: number; transaction_expires_at: number | null }>();
    const currentState = row?.state === "CONNECTING" && (!row.transaction_expires_at || row.transaction_expires_at <= Date.now()) ? "DISCONNECTED" : row?.state;
    const validState: AppleSessionStatus["state"] = currentState && ["CONNECTING", "READY", "DEVICE_APPROVAL_PENDING"].includes(currentState) ? currentState as AppleSessionStatus["state"] : "DISCONNECTED";
    if (validState === "READY" || validState === "DEVICE_APPROVAL_PENDING") {
      try {
        const saved = await this.load();
        // Use the restored row's metadata, rather than comparing it with an
        // earlier status SELECT while a concurrent operation advances the version.
        return { ...saved.fence, state: saved.state, action: saved.action,
          nextAttemptAt: saved.session.pcs.nextAttemptAt, transportReady: sessionServices(saved.session, saved.state, saved.action).reminders.state === "READY",
          services: sessionServices(saved.session, saved.state, saved.action), accountAuthenticated: true,
          liveReadValidated: false, expiresAt: saved.session.login.expiresAt,
          retentionDays: (saved.session.login.expiresAt - saved.session.login.verifiedAt) / 86_400_000,
          retentionSource: saved.session.login.version === 3 ? saved.session.login.retentionSource : "legacy-consent",
          lastValidatedAt: saved.session.renewal?.lastValidatedAt ?? null,
          lastAppleSuccessAt: saved.session.renewal?.lastAppleSuccessAt ?? null,
          lastRenewedAt: saved.session.renewal?.lastRenewedAt ?? null,
          nextRetryAt: saved.session.renewal?.nextRetryAt ?? null,
          requiredAction: saved.session.renewal?.requiredAction ?? (saved.state === "DEVICE_APPROVAL_PENDING" ? "approve-reminders" : null) };
      } catch (error) {
        if (error instanceof AppError && ["REAUTH_REQUIRED", "AUTH_EXPIRED", "NOT_CONNECTED", "CONFLICT"].includes(error.code)) { if (retry >= 2) throw new AppError("CONFLICT", "The Apple session changed. Refresh connection.", 409); return this.status(retry + 1); }
        throw error;
      }
    }
    return {
      generation: row?.generation ?? 0,
      version: row?.version ?? 0,
      state: validState,
      action: null,
      nextAttemptAt: row?.next_attempt_at ?? 0,
      transportReady: false, services: null, accountAuthenticated: false,
      liveReadValidated: false,
      expiresAt: null,
      retentionDays: null, retentionSource: null, lastValidatedAt: null, lastAppleSuccessAt: null,
      lastRenewedAt: null, nextRetryAt: null,
      requiredAction: row?.action === "local-retention-expired" || row?.action === "apple-sign-in" ? row.action : null,
    };
  }

  async begin(expectedGeneration: number): Promise<SetupFence> {
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw new AppError("VALIDATION_ERROR", "The expected Apple session generation is invalid.", 400);
    await this.ensureRow();
    const version = await this.db.prepare("SELECT version FROM apple_session_state WHERE owner_id = ? AND account_id = ? AND generation = ?")
      .bind(this.owner, ACCOUNT, expectedGeneration).first<{ version: number }>();
    if (!version) throw new AppError("CONFLICT", "The Apple session changed. Refresh status and retry setup.", 409);
    const transactionId = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = now + SETUP_LEASE_MS;
    const row = await this.db.prepare("UPDATE apple_session_state SET generation = generation + 1, version = version + 1, state = 'CONNECTING', action = NULL, next_attempt_at = 0, envelope = NULL, transaction_id = ?, transaction_expires_at = ?, resume_id = NULL, resume_expires_at = NULL, updated_at = ? WHERE owner_id = ? AND account_id = ? AND generation = ? AND version = ? RETURNING generation, version")
      .bind(transactionId, expiresAt, now, this.owner, ACCOUNT, expectedGeneration, version.version).first<FenceRow>();
    if (!row) throw new AppError("CONFLICT", "The Apple session changed. Refresh status and retry setup.", 409);
    await this.clearPreviousDriveState(row.generation);
    return { generation: row.generation, version: row.version, transactionId, expiresAt };
  }

  private async checkedSession(session: unknown): Promise<AppleSession> {
    const parsed = AppleSessionSchema.safeParse(session);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "The Apple session snapshot is invalid or contains unsupported fields.", 400);
    requireCurrentLogin(parsed.data.login);
    return parsed.data;
  }

  async commit(fence: SetupFence, session: AppleSession, state: AppleSessionState, action?: ApprovalAction) {
    const parsed = await this.checkedSession(session);
    const safeAction = connectionAction(state, action);
    const context: EnvelopeContext = { ownerId: this.owner, accountId: ACCOUNT, generation: fence.generation, recordId: RECORD, schemaVersion: 1 };
    const envelope = JSON.stringify(await this.envelopes.encrypt(parsed, context));
    const now = Date.now();
    requireCurrentLogin(parsed.login, now);
    const result = await this.db.prepare("UPDATE apple_session_state SET version = version + 1, state = ?, action = ?, next_attempt_at = ?, envelope = ?, transaction_id = NULL, transaction_expires_at = NULL, resume_id = NULL, resume_expires_at = NULL, updated_at = ? WHERE owner_id = ? AND account_id = ? AND generation = ? AND version = ? AND transaction_id = ? AND transaction_expires_at > ? RETURNING version")
      .bind(state, safeAction, parsed.pcs.nextAttemptAt, envelope, now, this.owner, ACCOUNT, fence.generation, fence.version, fence.transactionId, now).first<{ version: number }>();
    if (!result) throw new AppError("CONFLICT", "The Apple setup attempt expired or was replaced. Restart setup.", 409);
    try { requireCurrentLogin(parsed.login); }
    catch (error) { await this.invalidate({ generation: fence.generation, version: result.version }); throw error; }
    return { generation: fence.generation, version: result.version, state, action: safeAction };
  }

  async abandon(fence: SetupFence) {
    const now = Date.now();
    const result = await this.db.prepare("UPDATE apple_session_state SET generation = generation + 1, version = version + 1, state = 'DISCONNECTED', action = NULL, next_attempt_at = 0, envelope = NULL, transaction_id = NULL, transaction_expires_at = NULL, resume_id = NULL, resume_expires_at = NULL, updated_at = ? WHERE owner_id = ? AND account_id = ? AND generation = ? AND ((version = ? AND transaction_id = ?) OR (version = ? AND transaction_id IS NULL AND state IN ('READY', 'DEVICE_APPROVAL_PENDING'))) RETURNING generation")
      .bind(now, this.owner, ACCOUNT, fence.generation, fence.version, fence.transactionId, fence.version + 1).first<{ generation: number }>();
    return result !== null;
  }

  async invalidate(fence: SessionFence, reason: "local-retention-expired" | "apple-sign-in" | null = null) {
    const now = Date.now();
    const result = await this.db.prepare("UPDATE apple_session_state SET generation = generation + 1, version = version + 1, state = 'DISCONNECTED', action = ?, next_attempt_at = 0, envelope = NULL, transaction_id = NULL, transaction_expires_at = NULL, resume_id = NULL, resume_expires_at = NULL, updated_at = ? WHERE owner_id = ? AND account_id = ? AND generation = ? AND version = ? RETURNING generation")
      .bind(reason, now, this.owner, ACCOUNT, fence.generation, fence.version).first<{ generation: number }>();
    return result !== null;
  }

  private async invalidateSnapshot(fence: SessionFence, cause: "missing-envelope" | "envelope-verification" | "session-schema" | "row-state") {
    const invalidated = await this.invalidate(fence);
    if (invalidated) console.warn({ event: "apple-session-invalidated", cause, generation: fence.generation });
    return invalidated;
  }

  async load() { return this.loadSnapshot(); }

  async migrateOwnerSessionRetention() { return this.loadSnapshot(); }

  private async migrateRetention(row: StateRow, session: AppleSession) {
    const approval = this.migration;
    if (!approval || approval.owner !== this.owner || approval.generation !== row.generation || session.login.version !== 2) return false;
    const now = Date.now();
    const expiresAt = session.login.verifiedAt + SESSION_RETENTION_MS;
    if (session.login.verifiedAt > now || now >= expiresAt) return false;
    if (row.transaction_id !== null || row.transaction_expires_at !== null && row.transaction_expires_at > now ||
      row.resume_expires_at !== null && row.resume_expires_at > now) throw new AppError("CONFLICT", "The approved retention migration is deferred while a session operation is active. The saved connection is preserved.", 409, true);
    const login = LoginAssuranceSchema.parse({
      ...session.login, version: 3, expiresAt, retentionPolicy: RETENTION_POLICY,
      retentionSource: "owner-authorised-migration", migratedAt: now,
      previousExpiresAt: session.login.expiresAt, migrationId: approval.migrationId,
    });
    const envelope = JSON.stringify(await this.envelopes.encrypt({ ...session, login }, {
      ownerId: this.owner, accountId: ACCOUNT, generation: row.generation, recordId: RECORD, schemaVersion: 1,
    }));
    const committedAt = Date.now();
    requireCurrentLogin(login, committedAt);
    const updated = await this.db.prepare("UPDATE apple_session_state SET envelope = ?, version = version + 1, updated_at = ? WHERE owner_id = ? AND account_id = ? AND generation = ? AND version = ? AND state = ? AND envelope = ? AND transaction_id IS NULL AND (transaction_expires_at IS NULL OR transaction_expires_at <= ?) AND (resume_expires_at IS NULL OR resume_expires_at <= ?) RETURNING version")
      .bind(envelope, committedAt, this.owner, ACCOUNT, row.generation, row.version, row.state, row.envelope, committedAt, committedAt).first<{ version: number }>();
    if (!updated) throw new AppError("CONFLICT", "The Apple session changed during retention migration. No credentials were replaced.", 409, true);
    return true;
  }

  private async loadSnapshot(retry = 0, generation?: number): Promise<{ session: AppleSession; fence: SessionFence; state: AppleSessionState; action: ApprovalAction | null }> {
    const row = await this.db.prepare("SELECT generation, version, state, action, next_attempt_at, envelope, transaction_id, transaction_expires_at, resume_id, resume_expires_at FROM apple_session_state WHERE owner_id = ? AND account_id = ?")
      .bind(this.owner, ACCOUNT).first<StateRow>();
    if (!row || (row.state !== "READY" && row.state !== "DEVICE_APPROVAL_PENDING")) {
      throw new AppError("NOT_CONNECTED", "Connect an Apple account before continuing.", 409);
    }
    if (generation !== undefined && row.generation !== generation) throw new AppError("CONFLICT", "The Apple account connection changed. Refresh status before continuing.", 409, true);
    const fence = { generation: row.generation, version: row.version };
    if (row.transaction_id !== null) throw new AppError("CONFLICT", "An Apple setup operation is active. The saved session was not changed.", 409, true);
    if (!row.envelope) {
      await this.invalidateSnapshot(fence, "missing-envelope");
      throw invalidSession();
    }
    let decoded: unknown;
    try {
      const envelope = envelopeFromJSON(row.envelope);
      if (!Object.hasOwn(this.envelopes.keys, envelope.keyId)) throw new AppError("CONFIGURATION_REQUIRED", "An encryption key needed for this Apple session is unavailable.", 503);
      const context: EnvelopeContext = { ownerId: this.owner, accountId: ACCOUNT, generation: row.generation, recordId: RECORD, schemaVersion: 1 };
      decoded = await this.envelopes.decrypt<unknown>(envelope, context);
    } catch (error) {
      if (error instanceof AppError && error.code === "CONFIGURATION_REQUIRED") throw error;
      await this.invalidateSnapshot(fence, "envelope-verification");
      throw invalidSession();
    }
    const parsed = AppleSessionSchema.safeParse(decoded);
    // An authenticated envelope may have been written by a newer checkout.
    // Refuse unsupported data without destroying the retained credentials.
    if (!parsed.success) {
      const login = LoginAssuranceSchema.safeParse(decoded && typeof decoded === "object" && "login" in decoded ? decoded.login : undefined);
      if (!login.success) { await this.invalidateSnapshot(fence, "session-schema"); throw invalidSession(); }
      try { requireCurrentLogin(login.data); }
      catch (error) { await this.invalidate(fence, "local-retention-expired"); throw error; }
      throw new AppError("PROTOCOL_CHANGED", "This checkout cannot read the saved Apple session format. Use a compatible version; the retained session was not changed.", 503);
    }
    const actionValid = row.state === "READY" ? row.action === null : !!row.action && APPROVAL_ACTIONS.includes(row.action as ApprovalAction);
    if (!actionValid || row.next_attempt_at !== parsed.data.pcs.nextAttemptAt) {
      await this.invalidateSnapshot(fence, "row-state");
      throw invalidSession();
    }
    if (await this.migrateRetention(row, parsed.data)) {
      // Always restore the committed version; never hand out the old CAS fence.
      return this.loadSnapshot(retry, fence.generation);
    }
    try { requireCurrentLogin(parsed.data.login); }
    catch (error) { await this.invalidate(fence, "local-retention-expired"); throw error; }
    const current = await this.db.prepare("SELECT 1 AS active FROM apple_session_state WHERE owner_id = ? AND account_id = ? AND generation = ? AND version = ? AND state IN ('READY', 'DEVICE_APPROVAL_PENDING')")
      .bind(this.owner, ACCOUNT, fence.generation, fence.version).first<{ active: number }>();
    if (!current) {
      // Retry restoration only, never an Apple request or mutation. Pin the
      // original generation so reconnect/disconnect cannot silently switch it.
      if (retry < 2) return this.loadSnapshot(retry + 1, fence.generation);
      throw new AppError("CONFLICT", "The Apple session is busy updating. Retry the request.", 409, true);
    }
    try { requireCurrentLogin(parsed.data.login); }
    catch (error) { await this.invalidate(fence, "local-retention-expired"); throw error; }
    return { session: parsed.data, fence, state: row.state, action: row.state === "READY" ? null : row.action as ApprovalAction };
  }

  async claimResume(expectedGeneration: number, expectedVersion?: number): Promise<ResumeFence> {
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0 || (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0))) {
      throw new AppError("VALIDATION_ERROR", "The expected Apple session fence is invalid.", 400);
    }
    await this.ensureRow();
    const saved = await this.load();
    if (saved.fence.generation !== expectedGeneration || expectedVersion !== undefined && saved.fence.version !== expectedVersion) throw new AppError("CONFLICT", "The Apple session changed before this operation.", 409);
    const now = Date.now();
    requireCurrentLogin(saved.session.login, now);
    const resumeId = crypto.randomUUID();
    const expiresAt = Math.min(now + RESUME_LEASE_MS, saved.session.login.expiresAt);
    const versionPredicate = expectedVersion === undefined ? "" : " AND version = ?";
    const values: (string | number)[] = [resumeId, expiresAt, now, this.owner, ACCOUNT, expectedGeneration];
    if (expectedVersion !== undefined) values.push(expectedVersion);
    values.push(now);
    const row = await this.db.prepare(`UPDATE apple_session_state SET version = version + 1, resume_id = ?, resume_expires_at = ?, updated_at = ? WHERE owner_id = ? AND account_id = ? AND generation = ?${versionPredicate} AND state = 'DEVICE_APPROVAL_PENDING' AND transaction_id IS NULL AND (resume_expires_at IS NULL OR resume_expires_at <= ?) RETURNING generation, version`)
      .bind(...values).first<FenceRow>();
    if (!row) throw new AppError("CONFLICT", "The Apple session is not awaiting a resumable device approval, or another resume is active.", 409, true);
    try { requireCurrentLogin(saved.session.login); }
    catch (error) { await this.invalidate(row); throw error; }
    return { generation: row.generation, version: row.version, resumeId, expiresAt };
  }

  async claimRead(expectedGeneration: number, expectedVersion?: number, leaseMs: 30_000 | 60_000 = RESUME_LEASE_MS): Promise<ResumeFence> {
    if (![30_000, 60_000].includes(leaseMs)) throw new AppError("VALIDATION_ERROR", "The read lease allowance is invalid.", 400);
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0 || (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0))) {
      throw new AppError("VALIDATION_ERROR", "The expected Apple session fence is invalid.", 400);
    }
    await this.ensureRow();
    const saved = await this.load();
    if (saved.fence.generation !== expectedGeneration || expectedVersion !== undefined && saved.fence.version !== expectedVersion) throw new AppError("CONFLICT", "The Apple session changed before this operation.", 409);
    const now = Date.now();
    requireCurrentLogin(saved.session.login, now);
    const resumeId = crypto.randomUUID();
    const expiresAt = Math.min(now + leaseMs, saved.session.login.expiresAt);
    const versionPredicate = expectedVersion === undefined ? "" : " AND version = ?";
    const values: (string | number)[] = [resumeId, expiresAt, now, this.owner, ACCOUNT, expectedGeneration];
    if (expectedVersion !== undefined) values.push(expectedVersion);
    values.push(now);
    const row = await this.db.prepare(`UPDATE apple_session_state SET version = version + 1, resume_id = ?, resume_expires_at = ?, updated_at = ? WHERE owner_id = ? AND account_id = ? AND generation = ?${versionPredicate} AND state = 'READY' AND transaction_id IS NULL AND (resume_expires_at IS NULL OR resume_expires_at <= ?) RETURNING generation, version`)
      .bind(...values).first<FenceRow>();
    if (!row) throw new AppError("CONFLICT", "The Apple session is not ready for a read, or another session operation is active.", 409, true);
    try { requireCurrentLogin(saved.session.login); }
    catch (error) { await this.invalidate(row); throw error; }
    return { generation: row.generation, version: row.version, resumeId, expiresAt };
  }

  async assertWriteLease(fence: ResumeFence) {
    // Recheck immediately before dispatch. Reads used to prepare the write must
    // not consume the remaining lease or let a disconnect/reconnect go unnoticed.
    const now = Date.now();
    const row = await this.db.prepare("SELECT 1 AS active FROM apple_session_state WHERE owner_id = ? AND account_id = ? AND generation = ? AND version = ? AND state = 'READY' AND transaction_id IS NULL AND resume_id = ? AND resume_expires_at > ?")
      .bind(this.owner, ACCOUNT, fence.generation, fence.version, fence.resumeId, now + 10_000).first<{ active: number }>();
    if (!row) throw new AppError("CONFLICT", "The Apple session changed or the preparation budget expired. Refresh before retrying; no write was sent.", 409, true);
  }

  /** Last transport gate: session and settings are read from one database snapshot. */
  async assertRemindersTransport(fence: ResumeFence, settings: { revision: number; available: boolean }, mutation: boolean) {
    const values: (string | number)[] = [this.owner, ACCOUNT, fence.generation, fence.version, fence.resumeId, Date.now() + (mutation ? 10_000 : 0)];
    // Do not reference a missing table: SQLite resolves names even in an unused
    // CASE branch. Installing settings during a legacy request must fence it out.
    const settingsPredicate = settings.available
      ? "((? = 0 AND NOT EXISTS (SELECT 1 FROM owner_service_settings WHERE owner_id = ?)) OR EXISTS (SELECT 1 FROM owner_service_settings WHERE owner_id = ? AND revision = ?))"
      : "NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'owner_service_settings')";
    if (settings.available) values.push(settings.revision, this.owner, this.owner, settings.revision);
    const row = await this.db.prepare(`SELECT
      EXISTS (SELECT 1 FROM apple_session_state WHERE owner_id = ? AND account_id = ? AND generation = ? AND version = ?
        AND state = 'READY' AND transaction_id IS NULL AND resume_id = ? AND resume_expires_at > ?) AS lease_active,
      ${settingsPredicate} AS settings_current`)
      .bind(...values).first<{ lease_active: number; settings_current: number }>();
    if (!row?.lease_active || !row.settings_current) {
      throw new AppError("CONFLICT", "The Apple lease or service permissions changed before transport dispatch. No request was sent; retained intents must be reconciled before retrying.", 409);
    }
  }

  // Drive and future services share the account fence without depending on
  // Reminders consent. Service readiness and permission remain caller guards.
  async assertAccountLease(fence: ResumeFence) {
    const now = Date.now();
    const row = await this.db.prepare("SELECT 1 AS active FROM apple_session_state WHERE owner_id = ? AND account_id = ? AND generation = ? AND version = ? AND state IN ('READY', 'DEVICE_APPROVAL_PENDING') AND transaction_id IS NULL AND resume_id = ? AND resume_expires_at > ?")
      .bind(this.owner, ACCOUNT, fence.generation, fence.version, fence.resumeId, now + 10_000).first<{ active: number }>();
    if (!row) throw new AppError("CONFLICT", "The Apple account changed or the preparation budget expired. No operation may be dispatched.", 409, true);
  }

  async driveTransferCurrent(fence: SessionFence, permissionRevision: number): Promise<boolean> {
    const row = await this.db.prepare(`SELECT a.generation, a.version, a.state, a.transaction_id, s.revision AS permission_revision
      FROM apple_session_state a LEFT JOIN owner_service_settings s ON s.owner_id = a.owner_id
      WHERE a.owner_id = ? AND a.account_id = ?`)
      .bind(this.owner, ACCOUNT).first<{ generation: number; version: number; state: string; transaction_id: string | null; permission_revision: number | null }>();
    if (!row || row.generation !== fence.generation) throw new AppError("CONFLICT", "The Apple account changed during this Drive transfer.", 409);
    return row.permission_revision === permissionRevision && row.version === fence.version && row.transaction_id === null && ["READY", "DEVICE_APPROVAL_PENDING"].includes(row.state);
  }

  // A short relay verifier must check both the account fence and the retained
  // Apple write lease. One primary read avoids reloading/decrypting an unchanged
  // session for every frame; a changed version still requires the full guard.
  async driveRelayCurrent(fence: SessionFence, permissionRevision: number, operation: { id: string; inputHash: string; account: string; leaseId: string }) {
    const now = Date.now();
    const row = await this.db.prepare(`SELECT a.generation, a.version, a.state, a.transaction_id, s.revision AS permission_revision
      FROM apple_session_state a LEFT JOIN owner_service_settings s ON s.owner_id = a.owner_id
      INNER JOIN drive_operations d ON d.owner_id = a.owner_id
      WHERE a.owner_id = ? AND a.account_id = ? AND d.operation_id = ? AND d.input_hash = ? AND d.account_scope = ?
      AND d.generation = ? AND d.permission_revision = ? AND d.kind = 'relay-upload' AND d.phase = 'uploading'
      AND d.lease_id = ? AND d.lease_until > ? AND d.expires_at > ?`)
      .bind(this.owner, ACCOUNT, operation.id, operation.inputHash, operation.account, fence.generation, permissionRevision, operation.leaseId, now + 10_000, now + 10_000)
      .first<{ generation: number; version: number; state: string; transaction_id: string | null; permission_revision: number | null }>();
    if (!row || row.generation !== fence.generation) throw new AppError("CONFLICT", "The relay's account or original upload lease changed.", 409);
    return row.permission_revision === permissionRevision && row.version === fence.version && row.transaction_id === null && ["READY", "DEVICE_APPROVAL_PENDING"].includes(row.state);
  }

  async claimRenewal(expectedGeneration: number, expectedVersion: number) {
    const saved = await this.load();
    return saved.state === "READY" ? this.claimRead(expectedGeneration, expectedVersion) : this.claimResume(expectedGeneration, expectedVersion);
  }

  // Persist the copy identity before Apple dispatch without releasing or
  // extending the current owner/generation lease. Only hashes, never reminder
  // bodies, are retained. A lost acknowledgement can then reconcile that key.
  async checkpointCopyIntent(fence: ResumeFence, intent: NonNullable<AppleSession["copyIntents"]>[number]) {
    const saved = await this.load();
    const intents = saved.session.copyIntents ?? [];
    const existing = intents.find(item => item.id === intent.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(intent)) throw new AppError("CONFLICT", "This copy key belongs to a different request.", 409);
    if (!existing && intents.length >= 128) throw new AppError("UNSUPPORTED_FEATURE", "This session's retained copy identity budget is full.");
    const session = await this.checkedSession({ ...saved.session, copyIntents: existing ? intents : [...intents, intent] });
    const context: EnvelopeContext = { ownerId: this.owner, accountId: ACCOUNT, generation: fence.generation, recordId: RECORD, schemaVersion: 1 };
    const envelope = JSON.stringify(await this.envelopes.encrypt(session, context));
    const now = Date.now();
    requireCurrentLogin(session.login, now);
    const result = await this.db.prepare("UPDATE apple_session_state SET envelope = ?, updated_at = ? WHERE owner_id = ? AND account_id = ? AND generation = ? AND version = ? AND state = 'READY' AND resume_id = ? AND resume_expires_at > ? AND transaction_id IS NULL RETURNING version")
      .bind(envelope, now, this.owner, ACCOUNT, fence.generation, fence.version, fence.resumeId, now + 10_000).first<{ version: number }>();
    if (!result) throw new AppError("CONFLICT", "The Apple session changed before its copy identity could be saved. No write was sent.", 409);
    return session.copyIntents!;
  }

  async checkpointRecurringIntent(fence: ResumeFence, intent: RecurringIntent) {
    const saved = await this.load();
    let intents = saved.session.recurringIntents ?? [];
    const prior = intents.find(item => item.requestFingerprint === intent.requestFingerprint);
    const immutable = (item: RecurringIntent) => JSON.stringify({ ...item, phase: undefined });
    const phases = ["prepared", "dispatched", "confirmed"];
    if (prior && (immutable(prior) !== immutable(intent) || phases.indexOf(intent.phase) < phases.indexOf(prior.phase))) {
      throw new AppError("CONFLICT", "The retained occurrence identity or phase does not match this completion.", 409);
    }
    if (!prior && intents.length >= 256) {
      const oldest = intents.filter(item => item.phase === "confirmed").sort((a, b) => a.timestamp - b.timestamp)[0];
      if (!oldest) throw new AppError("UNSUPPORTED_FEATURE", "The unresolved recurring completion identity budget is full.");
      intents = intents.filter(item => item.requestFingerprint !== oldest.requestFingerprint);
    }
    intents = [...intents.filter(item => item.requestFingerprint !== intent.requestFingerprint), intent];
    const session = await this.checkedSession({ ...saved.session, recurringIntents: intents });
    const context: EnvelopeContext = { ownerId: this.owner, accountId: ACCOUNT, generation: fence.generation, recordId: RECORD, schemaVersion: 1 };
    const envelope = JSON.stringify(await this.envelopes.encrypt(session, context)), now = Date.now();
    requireCurrentLogin(session.login, now);
    const row = await this.db.prepare("UPDATE apple_session_state SET envelope = ?, updated_at = ? WHERE owner_id = ? AND account_id = ? AND generation = ? AND version = ? AND state = 'READY' AND resume_id = ? AND resume_expires_at > ? AND transaction_id IS NULL RETURNING version")
      .bind(envelope, now, this.owner, ACCOUNT, fence.generation, fence.version, fence.resumeId, now + 10_000).first<{ version: number }>();
    if (!row) throw new AppError("CONFLICT", "The Apple session changed before the occurrence identity checkpoint.", 409);
    return session.recurringIntents!;
  }

  async commitResume(fence: ResumeFence, session: AppleSession, state: AppleSessionState, action?: ApprovalAction) {
    const parsed = await this.checkedSession(session);
    const saved = await this.load();
    if (saved.fence.generation !== fence.generation || saved.fence.version !== fence.version) throw new AppError("CONFLICT", "The Apple session changed during this operation.", 409);
    if (JSON.stringify(saved.session.login) !== JSON.stringify(parsed.login)) throw new AppError("VALIDATION_ERROR", "An Apple session's verification and expiry cannot be extended by an operation.", 400);
    if (saved.session.connection.dsid !== parsed.connection.dsid || saved.session.auth.clientId !== parsed.auth.clientId || saved.session.connection.clientId !== parsed.connection.clientId) throw new AppError("VALIDATION_ERROR", "An operation cannot replace the saved Apple account or client identity.", 400);
    const safeAction = connectionAction(state, action);
    const context: EnvelopeContext = { ownerId: this.owner, accountId: ACCOUNT, generation: fence.generation, recordId: RECORD, schemaVersion: 1 };
    const envelope = JSON.stringify(await this.envelopes.encrypt(parsed, context));
    const now = Date.now();
    requireCurrentLogin(parsed.login, now);
    const result = await this.db.prepare("UPDATE apple_session_state SET version = version + 1, state = ?, action = ?, next_attempt_at = ?, envelope = ?, resume_id = NULL, resume_expires_at = NULL, updated_at = ? WHERE owner_id = ? AND account_id = ? AND generation = ? AND version = ? AND resume_id = ? AND resume_expires_at > ? AND transaction_id IS NULL RETURNING version")
      .bind(state, safeAction, parsed.pcs.nextAttemptAt, envelope, now, this.owner, ACCOUNT, fence.generation, fence.version, fence.resumeId, now).first<{ version: number }>();
    if (!result) throw new AppError("CONFLICT", "The Apple resume lease expired or was replaced. Retry the approval check.", 409);
    try { requireCurrentLogin(parsed.login); }
    catch (error) { await this.invalidate({ generation: fence.generation, version: result.version }); throw error; }
    return { generation: fence.generation, version: result.version, state, action: safeAction };
  }

  async releaseResume(fence: ResumeFence) {
    const now = Date.now();
    const result = await this.db.prepare("UPDATE apple_session_state SET version = version + 1, resume_id = NULL, resume_expires_at = NULL, updated_at = ? WHERE owner_id = ? AND account_id = ? AND generation = ? AND version = ? AND resume_id = ? RETURNING version")
      .bind(now, this.owner, ACCOUNT, fence.generation, fence.version, fence.resumeId).first<{ version: number }>();
    return result !== null;
  }

  async disconnect() {
    await this.ensureRow();
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await this.db.prepare("SELECT generation, version FROM apple_session_state WHERE owner_id = ? AND account_id = ?")
        .bind(this.owner, ACCOUNT).first<SessionFence>();
      if (!current) continue;
      const now = Date.now();
      const updated = await this.db.prepare("UPDATE apple_session_state SET generation = generation + 1, version = version + 1, state = 'DISCONNECTED', action = NULL, next_attempt_at = 0, envelope = NULL, transaction_id = NULL, transaction_expires_at = NULL, resume_id = NULL, resume_expires_at = NULL, updated_at = ? WHERE owner_id = ? AND account_id = ? AND generation = ? AND version = ? RETURNING generation")
        .bind(now, this.owner, ACCOUNT, current.generation, current.version).first<{ generation: number }>();
      if (updated) {
        await this.clearPreviousDriveState(updated.generation);
        return { generation: updated.generation, state: "DISCONNECTED" as const };
      }
    }
    throw new AppError("CONFLICT", "The Apple session changed repeatedly while disconnecting. Retry disconnect.", 409, true);
  }
}

export { requireRemindersConnection };
