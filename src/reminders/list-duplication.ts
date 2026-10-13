import { servicePermissionFence } from "../services/permission-fence.ts";
import { z } from "zod";
import { AppError } from "../errors.ts";
import { Envelopes, type Envelope } from "../crypto/envelopes.ts";
import { configuredEnvelopes } from "../persistence/apple-sessions.ts";
import type { RuntimeEnv } from "../platform/sites.ts";
import { normalizeReminder, type CloudKitPage, type CloudKitRecord } from "../icloud/cloudkit.ts";
import { accountScope, fingerprint } from "../lib/canonical.ts";
import { ListId } from "./identifiers.ts";
import { CreateListInput } from "./list-writes.ts";
import { normalizeReminderTag, normalizeURLAttachment, readReminderOrganization } from "./organization.ts";
import { requireMutableList } from "./list-writes.ts";
import { requireOrdinaryTransfer, planReminderTransfer } from "./transfers.ts";

const UUID = z.string().uuid();
const Version = z.string().min(1).max(512).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
const Name = CreateListInput.shape.name;

/** Stable caller-supplied identity. The same ID and exact request always address one manifest. */
export const DuplicateReminderListInputFields = {
  duplicationId: UUID.transform(value => value.toLowerCase()).describe("Stable UUID for this list duplication, normalized to lowercase. Keep it and all fields unchanged when reconciling an uncertain attempt."),
  sourceListId: ListId.describe("Exact source List ID from a current list read."),
  sourceListRecordChangeTag: Version.describe("Exact source List version tag from the same current read."),
  name: Name.describe("Name for the newly created private standard list."),
  expectedGeneration: z.number().int().nonnegative().safe().describe("Current Apple session generation."),
} as const;
export const DuplicateReminderListInput = z.object(DuplicateReminderListInputFields).strict();
export type DuplicateReminderListInputData = z.input<typeof DuplicateReminderListInput>;

export const DuplicateReminderListOutput = z.object({
  duplicationId: UUID,
  status: z.enum(["completed", "partial", "uncertain"]),
  sourceListRecordChangeTag: Version,
  destinationListId: ListId,
  destinationListRecordChangeTag: Version.nullable(),
  items: z.array(z.object({ sourceReminderId: z.string(), destinationReminderId: z.string(), destinationReminderRecordChangeTag: Version.nullable(), status: z.enum(["pending", "confirmed", "uncertain", "observed", "missing"]) }).strict()).max(20),
}).strict();
export type DuplicateReminderListOutputData = z.infer<typeof DuplicateReminderListOutput>;

export interface ListDuplicationFacade {
  readonly owner: string;
  /** Trusted current Apple account identifier used only to derive an owner-bound account scope. */
  readonly accountId: string;
  readonly generation: number;
  assertCurrent(expectedGeneration: number, expectedAccountId: string): Promise<void>;
  readDuplicationList(expectedGeneration: number, listId: string, allowMissing?: boolean): Promise<{ generation: number; zoneOwner: string; record: CloudKitRecord | null }>;
  /** Reads only open reminders, using the same native includeCompleted=false query as the direct list reader. */
  readDuplicationPage(expectedGeneration: number, listId: string, continuation: string | null, limit: number): Promise<{ generation: number; page: CloudKitPage }>;
  inspectDuplicationSource(expectedGeneration: number, listId: string, reminderId: string): Promise<{
    generation: number; zoneOwner: string; complete: boolean; record: CloudKitRecord; children: CloudKitRecord[]; attachments: CloudKitRecord[]; hashtags: CloudKitRecord[];
  }>;
  createList(request: { name: string; idempotencyKey: string; expectedGeneration: number }): Promise<{ generation: number; listId: string; recordChangeTag: string }>;
  copyReminder(request: {
    sourceListId: string; sourceReminderId: string; sourceReminderRecordChangeTag: string;
    destinationListId: string; sourceListChangeTag: string; destinationListChangeTag: string;
    idempotencyKey: string; expectedGeneration: number; expectedRelationshipVersions: Record<string, string>;
  }): Promise<{ generation: number; destinationReminderId: string; destinationReminderRecordChangeTag: string; listVersions: { listId: string; recordChangeTag: string }[] }>;
  observeDuplicationReminder(expectedGeneration: number, listId: string, reminderId: string): Promise<{ generation: number; zoneOwner: string; record: CloudKitRecord | null }>;
}

interface SourceItem { reminderId: string; destinationReminderId: string; recordChangeTag: string; destinationReminderRecordChangeTag: string | null; title: string; notes: string; priority: number; flagged: boolean; url: { id: string; recordChangeTag: string; value: string } | null; tags: { id: string; recordChangeTag: string; name: string }[]; }
interface Manifest { sourceListId: string; sourceListInitialRecordChangeTag: string; sourceListRecordChangeTag: string; zoneOwner: string; destinationListId: string; name: string; items: SourceItem[]; destinationListRecordChangeTag: string | null; listStage: "pending" | "started" | "confirmed" | "uncertain"; stages: ("pending" | "started" | "confirmed" | "uncertain")[]; }
interface DuplicationRow { owner_scope: string; duplication_id: string; account_scope: string; generation: number; request_hash: string; revision: number; state: string; envelope: string; lease_id: string | null; lease_until: number; }
const EnvelopeSchema = z.object({ version: z.literal(1), keyId: z.string().min(1).max(64), iv: z.string(), ciphertext: z.string() }).strict();
const conflict = (message: string) => new AppError("CONFLICT", message, 409);
const MAX_PAGES = 10, MAX_DURATION_MS = 30_000, MAX_MANIFEST_BYTES = 512_000;

function requireBeforeDeadline(deadline: number): void {
  if (Date.now() > deadline) throw new AppError("UNSUPPORTED_FEATURE", "The source list exceeded the duplication time bound; no destination was created.");
}

function within<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new AppError("UNSUPPORTED_FEATURE", "The source list exceeded the duplication time bound; no destination was created."));
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AppError("UNSUPPORTED_FEATURE", "The source list exceeded the duplication time bound; no destination was created.")), remaining);
  })]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

function validEnvelope(value: string): Envelope {
  let raw: unknown;
  try { raw = JSON.parse(value); } catch { throw new AppError("PROTOCOL_CHANGED", "The saved list duplication manifest is invalid.", 503); }
  const parsed = EnvelopeSchema.safeParse(raw);
  if (!parsed.success) throw new AppError("PROTOCOL_CHANGED", "The saved list duplication manifest is invalid.", 503);
  return parsed.data;
}

function assertSourceSnapshot(item: SourceItem, selected: { record: CloudKitRecord; attachments: CloudKitRecord[]; hashtags: CloudKitRecord[] }, zoneOwner: string): void {
  const reminder = normalizeReminder(selected.record, zoneOwner);
  readReminderOrganization(selected.record, selected.attachments, selected.hashtags, zoneOwner);
  const urls = selected.attachments.map(record => ({ ...normalizeURLAttachment(record, selected.record.recordName, zoneOwner), recordChangeTag: record.recordChangeTag! }));
  const tags = selected.hashtags.map(record => ({ ...normalizeReminderTag(record, selected.record.recordName, zoneOwner), recordChangeTag: record.recordChangeTag! }));
  const url = urls.length ? { id: urls[0]!.id, recordChangeTag: urls[0]!.recordChangeTag, value: urls[0]!.url } : null;
  const normalizedTags = tags.map(tag => ({ id: tag.id, recordChangeTag: tag.recordChangeTag, name: tag.name }));
  if ((reminder.title ?? "") !== item.title || (reminder.notes ?? "") !== item.notes || (reminder.priority ?? 0) !== item.priority || (reminder.flagged ?? false) !== item.flagged ||
    JSON.stringify(url) !== JSON.stringify(item.url) || JSON.stringify(normalizedTags) !== JSON.stringify(item.tags)) {
    throw conflict("A source reminder or related URL/tag changed after preflight.");
  }
}

async function stableUUID(seed: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)));
  digest[6] = (digest[6]! & 0x0f) | 0x50; digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = [...digest.slice(0, 16)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class ReminderListDuplicationService {
  readonly env: RuntimeEnv; readonly owner: string; readonly facade: ListDuplicationFacade; readonly envelopes: Envelopes;
  constructor(env: RuntimeEnv, owner: string, facade: ListDuplicationFacade, envelopes = configuredEnvelopes(env)) {
    if (!env.DB) throw new AppError("CONFIGURATION_REQUIRED", "Persistent list duplication storage is required.", 503);
    if (owner !== env.REMINDERS_OWNER_ID || facade.owner !== owner) throw new AppError("FORBIDDEN", "List duplication requires the authenticated deployment owner.", 403);
    this.env = env; this.owner = owner; this.facade = facade; this.envelopes = envelopes;
  }
  private get db() { return this.env.DB!.withSession("first-primary"); }
  private async context(input: z.infer<typeof DuplicateReminderListInput>) {
    return { ownerId: this.owner, accountId: await accountScope(this.owner, this.facade.accountId), generation: input.expectedGeneration, recordId: input.duplicationId, schemaVersion: 1 as const };
  }
  private accountScope() { return accountScope(this.owner, this.facade.accountId); }
  private async requireStorage() {
    const installed = await this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reminder_list_duplications'").first<{ name: string }>();
    if (!installed) throw new AppError("CONFIGURATION_REQUIRED", "Apply migration 0007_list_duplication.sql before duplicating reminder lists.", 503);
  }
  private async encrypt(input: z.infer<typeof DuplicateReminderListInput>, manifest: Manifest) { return JSON.stringify(await this.envelopes.encrypt(manifest, await this.context(input))); }
  private async decrypt(input: z.infer<typeof DuplicateReminderListInput>, row: DuplicationRow): Promise<Manifest> {
    return this.envelopes.decrypt<Manifest>(validEnvelope(row.envelope), await this.context(input));
  }
  private async acquire(input: z.infer<typeof DuplicateReminderListInput>, requestHash: string): Promise<{ row: DuplicationRow; lease: string; manifest: Manifest | null }> {
    const db = this.db, lease = crypto.randomUUID(), now = Date.now();
    const account = await this.accountScope();
    let row = await db.prepare("SELECT * FROM reminder_list_duplications WHERE owner_scope = ? AND duplication_id = ?")
      .bind(this.owner, input.duplicationId).first<DuplicationRow>();
    if (!row) {
      try {
        await db.prepare("INSERT INTO reminder_list_duplications (owner_scope, duplication_id, account_scope, generation, request_hash, revision, state, envelope, lease_id, lease_until) VALUES (?, ?, ?, ?, ?, 0, 'preparing', '', NULL, 0)")
          .bind(this.owner, input.duplicationId, account, input.expectedGeneration, requestHash).run();
      } catch { /* concurrent first insert is checked below */ }
      row = await db.prepare("SELECT * FROM reminder_list_duplications WHERE owner_scope = ? AND duplication_id = ?")
        .bind(this.owner, input.duplicationId).first<DuplicationRow>();
    }
    if (!row || row.account_scope !== account || row.generation !== input.expectedGeneration || row.request_hash !== requestHash)
      throw conflict("This duplication ID belongs to different inputs, account or session generation.");
    if (row.lease_id && row.lease_until > now) throw conflict("This list duplication is already being processed.");
    const acquired = await db.prepare("UPDATE reminder_list_duplications SET lease_id = ?, lease_until = ? WHERE owner_scope = ? AND duplication_id = ? AND revision = ? AND (lease_id IS NULL OR lease_until <= ?)")
      .bind(lease, now + 30_000, this.owner, input.duplicationId, row.revision, now).run();
    if (acquired.meta.changes !== 1) throw conflict("This list duplication is already being processed.");
    const current = await db.prepare("SELECT * FROM reminder_list_duplications WHERE owner_scope = ? AND duplication_id = ?")
      .bind(this.owner, input.duplicationId).first<DuplicationRow>();
    return { row: current!, lease, manifest: current!.envelope ? await this.decrypt(input, current!) : null };
  }
  private async save(input: z.infer<typeof DuplicateReminderListInput>, lease: string, row: DuplicationRow, manifest: Manifest) {
    if (new TextEncoder().encode(JSON.stringify(manifest)).byteLength > MAX_MANIFEST_BYTES)
      throw new AppError("UNSUPPORTED_FEATURE", "The encrypted source manifest exceeds the safe storage bound.");
    const envelope = await this.encrypt(input, manifest);
    const result = await this.db.prepare("UPDATE reminder_list_duplications SET revision = revision + 1, state = ?, envelope = ?, lease_until = ? WHERE owner_scope = ? AND duplication_id = ? AND revision = ? AND lease_id = ?")
      .bind(manifest.listStage === "confirmed" && manifest.stages.every(stage => stage === "confirmed") ? "completed" : manifest.listStage === "uncertain" || manifest.stages.includes("uncertain") ? "uncertain" : "active", envelope, Date.now() + 30_000, this.owner, input.duplicationId, row.revision, lease).run();
    if (result.meta.changes !== 1) throw conflict("The list duplication lease was lost.");
    return (await this.db.prepare("SELECT * FROM reminder_list_duplications WHERE owner_scope = ? AND duplication_id = ?")
      .bind(this.owner, input.duplicationId).first<DuplicationRow>())!;
  }
  private async release(input: z.infer<typeof DuplicateReminderListInput>, lease: string) {
    await this.db.prepare("UPDATE reminder_list_duplications SET lease_id = NULL, lease_until = 0 WHERE owner_scope = ? AND duplication_id = ? AND lease_id = ?")
      .bind(this.owner, input.duplicationId, lease).run();
  }
  private assertGeneration(generation: number, expected: number) {
    if (generation !== expected || this.facade.generation !== expected) throw conflict("The Apple account or session generation changed during list duplication.");
  }
  private async preflight(input: z.infer<typeof DuplicateReminderListInput>): Promise<Manifest> {
    await this.facade.assertCurrent(input.expectedGeneration, this.facade.accountId);
    const deadline = Date.now() + MAX_DURATION_MS;
    this.assertGeneration(this.facade.generation, input.expectedGeneration);
    const source = await within(this.facade.readDuplicationList(input.expectedGeneration, input.sourceListId), deadline); this.assertGeneration(source.generation, input.expectedGeneration);
    if (!source.record) throw conflict("The source list is unavailable.");
    if (source.record.recordChangeTag !== input.sourceListRecordChangeTag) throw conflict("The source list version changed before duplication.");
    requireMutableList(source.record, source.zoneOwner, input.sourceListRecordChangeTag);
    const ids = new Set<string>(), roots: CloudKitRecord[] = [];
    let continuation: string | null = null; const cursors = new Set<string>();
    for (let pageNo = 0; pageNo < MAX_PAGES; pageNo++) {
      const result: { generation: number; page: CloudKitPage } = await within(this.facade.readDuplicationPage(input.expectedGeneration, input.sourceListId, continuation, 200), deadline);
      requireBeforeDeadline(deadline);
      this.assertGeneration(result.generation, input.expectedGeneration);
      const page = result.page;
      if (page.recordErrors.length) throw new AppError("UNSUPPORTED_FEATURE", "The source list page contained record errors; no destination was created.");
      for (const record of page.records) {
        if (!("recordType" in record) || record.recordType !== "Reminder" || record.deleted) continue;
        if (ids.has(record.recordName)) throw new AppError("PROTOCOL_CHANGED", "The source list returned a duplicate reminder.");
        ids.add(record.recordName); roots.push(record);
        if (roots.length > 20) throw new AppError("UNSUPPORTED_FEATURE", "List duplication supports at most 20 open reminders.");
      }
      if (page.paginationComplete) {
        if (!page.complete) throw new AppError("UNSUPPORTED_FEATURE", "The source list pagination was not complete; no destination was created.");
        if (page.continuation !== null) throw new AppError("PROTOCOL_CHANGED", "The final source page contained a continuation.");
        break;
      }
      if (!page.continuation || cursors.has(page.continuation)) throw new AppError("PROTOCOL_CHANGED", "Source list pagination was incomplete or repeated.");
      cursors.add(page.continuation); continuation = page.continuation;
      if (pageNo === MAX_PAGES - 1) throw new AppError("UNSUPPORTED_FEATURE", "The source list exceeded the ten-page duplication bound; no destination was created.");
    }
    const items: SourceItem[] = [];
    for (const root of roots) {
      const selected = await within(this.facade.inspectDuplicationSource(input.expectedGeneration, input.sourceListId, root.recordName), deadline);
      requireBeforeDeadline(deadline);
      this.assertGeneration(selected.generation, input.expectedGeneration);
      if (selected.zoneOwner !== source.zoneOwner) throw conflict("The CloudKit zone owner changed during source inspection.");
      if (!selected.complete || selected.record.recordChangeTag !== root.recordChangeTag || selected.children.length) throw new AppError("UNSUPPORTED_FEATURE", "A source reminder changed, has descendants, or could not be completely inspected; no destination was created.");
      const syntheticInput = { listId: input.sourceListId, reminderId: root.recordName, recordChangeTag: root.recordChangeTag!, sourceListChangeTag: input.sourceListRecordChangeTag, destinationListId: "List/DUPLICATION-PREFLIGHT", destinationListChangeTag: "preflight" };
      const reminder = requireOrdinaryTransfer(selected.record, source.zoneOwner, syntheticInput);
      if (selected.attachments.length !== (reminder.attachmentIds?.length ?? 0) || selected.hashtags.length !== (reminder.hashtagIds?.length ?? 0)) throw new AppError("UNSUPPORTED_FEATURE", "Source URL or tag records were incomplete; no destination was created.");
      readReminderOrganization(selected.record, selected.attachments, selected.hashtags, source.zoneOwner);
      const urls = selected.attachments.map(record => ({ ...normalizeURLAttachment(record, selected.record.recordName, source.zoneOwner), recordChangeTag: record.recordChangeTag! }));
      if (urls.length > 1) throw new AppError("UNSUPPORTED_FEATURE", "Only one URL per reminder is supported; no destination was created.");
      const tags = selected.hashtags.map(record => ({ ...normalizeReminderTag(record, selected.record.recordName, source.zoneOwner), recordChangeTag: record.recordChangeTag! }));
      // Run the existing native copy planner before any destination side effect.
      const dummy: CloudKitRecord = { ...source.record, recordName: "List/DUPLICATION-PREFLIGHT", recordChangeTag: "preflight", raw: { ...source.record.raw }, fields: { ...source.record.fields, ReminderIDs: { type: "STRING", value: "[]" } } };
      planReminderTransfer("copy", { ...syntheticInput, idempotencyKey: crypto.randomUUID() }, selected.record, source.record, dummy, selected.attachments, selected.hashtags, source.zoneOwner);
      const index = items.length;
      items.push({ reminderId: root.recordName, destinationReminderId: `Reminder/${(await stableUUID(`${input.duplicationId}:${index}`)).toUpperCase()}`, recordChangeTag: root.recordChangeTag!, destinationReminderRecordChangeTag: null, title: reminder.title ?? "", notes: reminder.notes ?? "", priority: reminder.priority ?? 0, flagged: reminder.flagged ?? false,
        url: urls.length ? { id: urls[0]!.id, recordChangeTag: urls[0]!.recordChangeTag, value: urls[0]!.url } : null,
        tags: tags.map(tag => ({ id: tag.id, recordChangeTag: tag.recordChangeTag, name: tag.name })) });
      requireBeforeDeadline(deadline);
    }
    await this.facade.assertCurrent(input.expectedGeneration, this.facade.accountId);
    const latest = await within(this.facade.readDuplicationList(input.expectedGeneration, input.sourceListId), deadline); this.assertGeneration(latest.generation, input.expectedGeneration);
    requireBeforeDeadline(deadline);
    if (!latest.record || latest.zoneOwner !== source.zoneOwner || latest.record.recordChangeTag !== input.sourceListRecordChangeTag) throw conflict("The source list version changed during preflight.");
    return { sourceListId: input.sourceListId, sourceListInitialRecordChangeTag: input.sourceListRecordChangeTag, sourceListRecordChangeTag: input.sourceListRecordChangeTag, zoneOwner: source.zoneOwner, destinationListId: `List/${input.duplicationId.toUpperCase()}`, name: input.name, items, destinationListRecordChangeTag: null, listStage: "pending", stages: items.map(() => "pending") };
  }
  private output(input: z.infer<typeof DuplicateReminderListInput>, manifest: Manifest): DuplicateReminderListOutputData {
    const uncertain = manifest.listStage === "started" || manifest.listStage === "uncertain" || manifest.stages.includes("started") || manifest.stages.includes("uncertain");
    const complete = manifest.listStage === "confirmed" && manifest.stages.every(stage => stage === "confirmed");
    return DuplicateReminderListOutput.parse({ duplicationId: input.duplicationId, status: complete ? "completed" : uncertain ? "uncertain" : "partial", sourceListRecordChangeTag: manifest.sourceListRecordChangeTag, destinationListId: manifest.destinationListId, destinationListRecordChangeTag: manifest.destinationListRecordChangeTag,
      items: manifest.items.map((item, index) => ({ sourceReminderId: item.reminderId, destinationReminderId: item.destinationReminderId, destinationReminderRecordChangeTag: item.destinationReminderRecordChangeTag,
        status: manifest.stages[index] === "confirmed" ? "confirmed" : manifest.stages[index] === "uncertain" || manifest.listStage !== "confirmed" ? "uncertain" : "pending" })) });
  }
  async duplicate(value: DuplicateReminderListInputData): Promise<DuplicateReminderListOutputData> {
    const permissions = await servicePermissionFence(this.env, this.owner, "reminders.write", true);
    try { return await this.duplicateBound(value, permissions.assertCurrent); }
    finally { await permissions.assertCurrent(); }
  }

  private async duplicateBound(value: DuplicateReminderListInputData, assertPermission: () => Promise<void>): Promise<DuplicateReminderListOutputData> {
    const input = DuplicateReminderListInput.parse(value), requestHash = await fingerprint(input);
    await this.requireStorage();
    const acquired = await this.acquire(input, requestHash); let row = acquired.row, manifest = acquired.manifest;
    try {
      if (!manifest) { manifest = await this.preflight(input); row = await this.save(input, acquired.lease, row, manifest); }
      if (manifest.listStage === "started" || manifest.listStage === "uncertain" || manifest.stages.includes("started") || manifest.stages.includes("uncertain")) {
        return await this.observeOnly(input, manifest);
      }
      if (manifest.listStage === "pending") {
        await this.guardBeforeCreate(input, manifest);
        manifest.listStage = "started"; row = await this.save(input, acquired.lease, row, manifest);
        await this.facade.assertCurrent(input.expectedGeneration, this.facade.accountId);
        await assertPermission();
        try {
          const result = await this.facade.createList({ name: manifest.name, idempotencyKey: input.duplicationId, expectedGeneration: input.expectedGeneration });
          this.assertGeneration(result.generation, input.expectedGeneration);
          if (result.listId !== manifest.destinationListId || !result.recordChangeTag) throw new AppError("PROTOCOL_CHANGED", "The created destination list identity was unexpected.");
          manifest.destinationListRecordChangeTag = result.recordChangeTag; manifest.listStage = "confirmed";
          row = await this.save(input, acquired.lease, row, manifest);
        } catch { manifest.listStage = "uncertain"; row = await this.save(input, acquired.lease, row, manifest); return this.output(input, manifest); }
      }
      for (let index = 0; index < manifest.items.length; index++) {
        if (manifest.stages[index] === "confirmed") continue;
        if (manifest.stages[index] !== "pending") return await this.observeOnly(input, manifest);
        const item = manifest.items[index]!;
        const sourceListId = manifest.sourceListId, destinationListId = manifest.destinationListId;
        await this.guardBeforeItem(input, manifest, item);
        manifest.stages[index] = "started"; row = await this.save(input, acquired.lease, row, manifest);
        await this.facade.assertCurrent(input.expectedGeneration, this.facade.accountId);
        await assertPermission();
        try {
          const result = await this.facade.copyReminder({ sourceListId: manifest.sourceListId, sourceReminderId: item.reminderId, sourceReminderRecordChangeTag: item.recordChangeTag,
            destinationListId: manifest.destinationListId, sourceListChangeTag: manifest.sourceListRecordChangeTag, destinationListChangeTag: manifest.destinationListRecordChangeTag!,
            idempotencyKey: item.destinationReminderId.slice("Reminder/".length), expectedGeneration: input.expectedGeneration,
            expectedRelationshipVersions: Object.fromEntries([...(item.url ? [[item.url.id, item.url.recordChangeTag]] : []), ...item.tags.map(tag => [tag.id, tag.recordChangeTag])]) });
          this.assertGeneration(result.generation, input.expectedGeneration);
          if (result.destinationReminderId !== item.destinationReminderId) throw new AppError("PROTOCOL_CHANGED", "The copied reminder identity was unexpected.");
          const sourceVersion = result.listVersions.find(version => version.listId === sourceListId);
          const destinationVersion = result.listVersions.find(version => version.listId === destinationListId);
          if (result.listVersions.length !== 2 || new Set(result.listVersions.map(version => version.listId)).size !== 2 ||
            !sourceVersion?.recordChangeTag || !destinationVersion?.recordChangeTag || !result.destinationReminderRecordChangeTag)
            throw new AppError("PROTOCOL_CHANGED", "The copy confirmation omitted a list or reminder version receipt.");
          manifest.sourceListRecordChangeTag = sourceVersion.recordChangeTag;
          manifest.destinationListRecordChangeTag = destinationVersion.recordChangeTag;
          item.destinationReminderRecordChangeTag = result.destinationReminderRecordChangeTag;
          manifest.stages[index] = "confirmed";
          row = await this.save(input, acquired.lease, row, manifest);
        } catch { manifest.stages[index] = "uncertain"; row = await this.save(input, acquired.lease, row, manifest); return this.output(input, manifest); }
      }
      return this.output(input, manifest);
    } finally { await this.release(input, acquired.lease); }
  }
  private async guardBeforeCreate(input: z.infer<typeof DuplicateReminderListInput>, manifest: Manifest) {
    await this.facade.assertCurrent(input.expectedGeneration, this.facade.accountId);
    const deadline = Date.now() + MAX_DURATION_MS;
    const sourceList = await within(this.facade.readDuplicationList(input.expectedGeneration, manifest.sourceListId), deadline);
    this.assertGeneration(sourceList.generation, input.expectedGeneration);
    if (!sourceList.record || sourceList.zoneOwner !== manifest.zoneOwner) throw conflict("The source list or CloudKit zone owner changed before destination creation.");
    requireMutableList(sourceList.record, manifest.zoneOwner, manifest.sourceListInitialRecordChangeTag);
    if (sourceList.record.recordChangeTag !== manifest.sourceListInitialRecordChangeTag) throw conflict("The source list changed before destination creation.");
    for (const item of manifest.items) {
      const selected = await within(this.facade.inspectDuplicationSource(input.expectedGeneration, manifest.sourceListId, item.reminderId), deadline);
      this.assertGeneration(selected.generation, input.expectedGeneration);
      if (selected.zoneOwner !== manifest.zoneOwner || !selected.complete || selected.record.recordChangeTag !== item.recordChangeTag || selected.children.length)
        throw conflict("A source reminder changed before destination creation.");
      assertSourceSnapshot(item, selected, manifest.zoneOwner);
    }
  }
  private async guardBeforeItem(input: z.infer<typeof DuplicateReminderListInput>, manifest: Manifest, item: SourceItem) {
    const sourceList = await this.facade.readDuplicationList(input.expectedGeneration, manifest.sourceListId);
    this.assertGeneration(sourceList.generation, input.expectedGeneration);
    const source = await this.facade.inspectDuplicationSource(input.expectedGeneration, manifest.sourceListId, item.reminderId);
    this.assertGeneration(source.generation, input.expectedGeneration);
    const destination = await this.facade.readDuplicationList(input.expectedGeneration, manifest.destinationListId);
    this.assertGeneration(destination.generation, input.expectedGeneration);
    if (!sourceList.record || !destination.record || sourceList.zoneOwner !== manifest.zoneOwner || source.zoneOwner !== manifest.zoneOwner || destination.zoneOwner !== manifest.zoneOwner || !source.complete)
      throw conflict("A source or destination could not be completely read; no further items were copied.");
    if (source.children.length) throw conflict("A source reminder gained descendants; no further items were copied.");
    requireMutableList(sourceList.record, manifest.zoneOwner, manifest.sourceListRecordChangeTag);
    requireMutableList(destination.record, manifest.zoneOwner, manifest.destinationListRecordChangeTag ?? undefined);
    if (sourceList.record.recordChangeTag !== manifest.sourceListRecordChangeTag || source.record.recordChangeTag !== item.recordChangeTag) throw conflict("A source list or reminder version changed; no further items were copied.");
    if (destination.record.recordChangeTag !== manifest.destinationListRecordChangeTag) throw conflict("The destination list changed outside this duplication; no later items were copied.");
    const reminder = normalizeReminder(source.record, manifest.zoneOwner);
    if (reminder.completed !== false || reminder.deleted !== false) throw conflict("A source reminder changed eligibility; no further items were copied.");
    assertSourceSnapshot(item, source, manifest.zoneOwner);
  }
  private async observeOnly(input: z.infer<typeof DuplicateReminderListInput>, manifest: Manifest) {
    await this.facade.assertCurrent(input.expectedGeneration, this.facade.accountId);
    const list = await this.facade.readDuplicationList(input.expectedGeneration, manifest.destinationListId, true);
    this.assertGeneration(list.generation, input.expectedGeneration);
    const sourceList = await this.facade.readDuplicationList(input.expectedGeneration, manifest.sourceListId);
    this.assertGeneration(sourceList.generation, input.expectedGeneration);
    // Read exact IDs after uncertainty. Observation is returned only as partial status and never advances a stage.
    const observed = [] as DuplicateReminderListOutputData["items"];
    for (const [index, item] of manifest.items.entries()) {
      const result = await this.facade.observeDuplicationReminder(input.expectedGeneration, manifest.destinationListId, item.destinationReminderId);
      this.assertGeneration(result.generation, input.expectedGeneration);
      if (result.zoneOwner !== manifest.zoneOwner) throw conflict("The destination CloudKit zone owner changed during reconciliation.");
      observed.push({ sourceReminderId: item.reminderId, destinationReminderId: item.destinationReminderId,
        destinationReminderRecordChangeTag: result.record?.recordChangeTag ?? null,
        status: result.record ? "observed" as const : manifest.stages[index] === "confirmed" ? "confirmed" as const : "missing" as const });
    }
    if (list.record && list.zoneOwner !== manifest.zoneOwner || sourceList.record && sourceList.zoneOwner !== manifest.zoneOwner)
      throw conflict("The CloudKit zone owner changed during reconciliation.");
    return DuplicateReminderListOutput.parse({ ...this.output(input, manifest), sourceListRecordChangeTag: sourceList.record?.recordChangeTag ?? manifest.sourceListRecordChangeTag,
      destinationListRecordChangeTag: list.record?.recordChangeTag ?? null, items: observed });
  }
}

export const duplicateReminderListSchema = DuplicateReminderListInput;
