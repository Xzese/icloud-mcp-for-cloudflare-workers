import { servicePermissionFence } from "../services/permission-fence.ts";
import { z } from "zod";
import { AppError } from "../errors.ts";
import { Envelopes, type Envelope } from "../crypto/envelopes.ts";
import { ReminderCollectionInput } from "../reminders/collection.ts";
import type { RuntimeEnv } from "../platform/sites.ts";
import { configuredEnvelopes } from "./apple-sessions.ts";

const ACCOUNT = "connector-filters";
const GENERATION = 1;
const MAX_FILTERS_PER_OWNER = 32;

export const ConnectorFilterDefinitionSchema = ReminderCollectionInput.omit({ referenceInstant: true });
export type ConnectorFilterDefinition = z.infer<typeof ConnectorFilterDefinitionSchema>;

export const SaveConnectorFilterInput = z.object({
  filterId: z.string().uuid().transform(value => value.toLowerCase()).describe("Stable owner-scoped UUID, normalized to lowercase; retain it when retrying the same saved filter."),
  name: z.string().min(1).max(128).refine(value => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value), "name must be visible and contain no control characters.").describe("Visible connector filter name, at most 128 characters."),
  definition: ConnectorFilterDefinitionSchema.describe("Relative connector view, timezone, sorting and search filters; no reference instant or reminder bodies."),
  expectedRevision: z.number().int().positive().safe().optional().describe("Exact saved revision for updates; omit for creation or an identical creation retry."),
}).strict();
export type SaveConnectorFilterInputData = z.input<typeof SaveConnectorFilterInput>;

export const GetConnectorFilterInput = z.object({ filterId: SaveConnectorFilterInput.shape.filterId }).strict();
export const DeleteConnectorFilterInput = z.object({ filterId: SaveConnectorFilterInput.shape.filterId, expectedRevision: z.number().int().positive().safe().describe("Exact current saved revision required for deletion.") }).strict();

export const SavedConnectorFilterSchema = z.object({
  filterId: z.string().uuid(), name: z.string().min(1).max(128), definition: ConnectorFilterDefinitionSchema,
  revision: z.number().int().positive().safe(),
}).strict();
export type SavedConnectorFilter = z.infer<typeof SavedConnectorFilterSchema>;
export const SaveConnectorFilterOutput = SavedConnectorFilterSchema;
export const GetConnectorFilterOutput = SavedConnectorFilterSchema;
export const ListConnectorFiltersOutput = z.array(SavedConnectorFilterSchema).max(MAX_FILTERS_PER_OWNER);
export const DeleteConnectorFilterOutput = z.object({ filterId: z.string().uuid(), deleted: z.literal(true) }).strict();

interface ConnectorFilterRow { owner_id: string; filter_id: string; revision: number; envelope: string; created_at: number; updated_at: number; }
const EnvelopeSchema = z.object({ version: z.literal(1), keyId: z.string().min(1).max(64), iv: z.string(), ciphertext: z.string() }).strict();
// Revision zero means no owner row, not an unrestricted default. The predicate
// runs in the same SQL statement as each mutation, so a concurrent save wins safely.
const SETTINGS_REVISION_GUARD = "((? = 0 AND NOT EXISTS (SELECT 1 FROM owner_service_settings WHERE owner_id = ?)) OR EXISTS (SELECT 1 FROM owner_service_settings WHERE owner_id = ? AND revision = ?))";
const conflict = (message: string) => new AppError("CONFLICT", message, 409);

function envelopeFromJSON(value: string): Envelope {
  let raw: unknown;
  try { raw = JSON.parse(value); } catch { throw new AppError("PROTOCOL_CHANGED", "The saved connector filter envelope is invalid.", 503); }
  const parsed = EnvelopeSchema.safeParse(raw);
  if (!parsed.success) throw new AppError("PROTOCOL_CHANGED", "The saved connector filter envelope is invalid.", 503);
  return parsed.data;
}

export class ConnectorFilterRepository {
  readonly env: RuntimeEnv;
  readonly db: D1DatabaseSession;
  readonly owner: string;
  readonly envelopes: Envelopes;

  constructor(env: RuntimeEnv, owner: string, envelopes = configuredEnvelopes(env)) {
    if (!env.DB) throw new AppError("CONFIGURATION_REQUIRED", "Persistent connector filter storage is required.", 503);
    if (typeof owner !== "string" || owner.length < 1 || owner.length > 256 || owner !== env.REMINDERS_OWNER_ID)
      throw new AppError("FORBIDDEN", "Connector filters require the authenticated deployment owner.", 403);
    this.env = env;
    this.db = env.DB.withSession("first-primary");
    this.owner = owner;
    this.envelopes = envelopes;
  }

  private context(filterId: string) {
    return { ownerId: this.owner, accountId: ACCOUNT, generation: GENERATION, recordId: filterId, schemaVersion: 1 as const };
  }

  private async requireStorage() {
    const installed = await this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'connector_filters'").first<{ name: string }>();
    if (!installed) throw new AppError("CONFIGURATION_REQUIRED", "Apply migration 0005_connector_filters.sql before using saved connector filters.", 503);
  }

  private async encrypt(filterId: string, value: Pick<SavedConnectorFilter, "name" | "definition">) {
    return JSON.stringify(await this.envelopes.encrypt(value, this.context(filterId)));
  }

  private async decrypt(row: ConnectorFilterRow): Promise<SavedConnectorFilter> {
    const payload = await this.envelopes.decrypt<{ name: string; definition: unknown }>(envelopeFromJSON(row.envelope), this.context(row.filter_id));
    return SavedConnectorFilterSchema.parse({ filterId: row.filter_id, name: payload.name, definition: payload.definition, revision: row.revision });
  }

  async save(input: SaveConnectorFilterInputData): Promise<SavedConnectorFilter> {
    const permissions = await servicePermissionFence(this.env, this.owner, "reminders.write", true);
    try { return await this.saveBound(input, permissions.snapshot.revision); }
    finally { await permissions.assertCurrent(); }
  }

  private async saveBound(input: SaveConnectorFilterInputData, permissionRevision: number): Promise<SavedConnectorFilter> {
    const parsed = SaveConnectorFilterInput.parse(input);
    await this.requireStorage();
    const definition = ConnectorFilterDefinitionSchema.parse(parsed.definition);
    const value = { name: parsed.name, definition };
    const current = await this.db.prepare("SELECT * FROM connector_filters WHERE owner_id = ? AND filter_id = ?")
      .bind(this.owner, parsed.filterId).first<ConnectorFilterRow>();

    if (!current) {
      if (parsed.expectedRevision !== undefined) throw conflict("The connector filter revision changed or the filter is unavailable.");
      const envelope = await this.encrypt(parsed.filterId, value);
      try {
        const inserted = await this.db.prepare("INSERT INTO connector_filters (owner_id, filter_id, revision, envelope, created_at, updated_at) SELECT ?, ?, 1, ?, ?, ? WHERE (SELECT COUNT(*) FROM connector_filters WHERE owner_id = ?) < 32 AND " + SETTINGS_REVISION_GUARD)
          .bind(this.owner, parsed.filterId, envelope, Date.now(), Date.now(), this.owner, permissionRevision, this.owner, this.owner, permissionRevision).run();
        if (inserted.meta.changes !== 1) throw conflict("An owner can save at most 32 connector filters.");
      } catch (error) {
        // A concurrent creator may have won; identical input is a safe replay.
        const replay = await this.db.prepare("SELECT * FROM connector_filters WHERE owner_id = ? AND filter_id = ?")
          .bind(this.owner, parsed.filterId).first<ConnectorFilterRow>();
        if (!replay) {
          const count = await this.db.prepare("SELECT COUNT(*) AS count FROM connector_filters WHERE owner_id = ?")
            .bind(this.owner).first<{ count: number }>();
          if (Number(count?.count ?? 0) >= MAX_FILTERS_PER_OWNER) throw conflict("An owner can save at most 32 connector filters.");
          throw error;
        }
        const saved = await this.decrypt(replay);
        if (saved.name === value.name && JSON.stringify(saved.definition) === JSON.stringify(value.definition)) return saved;
        throw conflict("A connector filter with this ID already exists.");
      }
      return { filterId: parsed.filterId, ...value, revision: 1 };
    }

    const saved = await this.decrypt(current);
    const isExactReplay = saved.name === value.name && JSON.stringify(saved.definition) === JSON.stringify(value.definition);
    if (parsed.expectedRevision === undefined) {
      if (isExactReplay) return saved;
      throw conflict("A connector filter with this ID already exists.");
    }
    if (current.revision !== parsed.expectedRevision) {
      // A retried update is accepted only when its exact payload is already committed.
      if (isExactReplay && current.revision === parsed.expectedRevision + 1) return saved;
      throw conflict("The connector filter revision changed.");
    }

    const envelope = await this.encrypt(parsed.filterId, value);
    const result = await this.db.prepare("UPDATE connector_filters SET revision = revision + 1, envelope = ?, updated_at = ? WHERE owner_id = ? AND filter_id = ? AND revision = ? AND " + SETTINGS_REVISION_GUARD)
      .bind(envelope, Date.now(), this.owner, parsed.filterId, parsed.expectedRevision, permissionRevision, this.owner, this.owner, permissionRevision).run();
    if (result.meta.changes !== 1) {
      const latest = await this.db.prepare("SELECT * FROM connector_filters WHERE owner_id = ? AND filter_id = ?")
        .bind(this.owner, parsed.filterId).first<ConnectorFilterRow>();
      if (latest) {
        const replay = await this.decrypt(latest);
        if (replay.revision === parsed.expectedRevision + 1 && replay.name === value.name && JSON.stringify(replay.definition) === JSON.stringify(value.definition)) return replay;
      }
      throw conflict("The connector filter revision changed.");
    }
    return { filterId: parsed.filterId, ...value, revision: parsed.expectedRevision + 1 };
  }

  async list(): Promise<SavedConnectorFilter[]> {
    const permissions = await servicePermissionFence(this.env, this.owner, "reminders.read");
    try { return await this.listBound(); }
    finally { await permissions.assertCurrent(); }
  }

  private async listBound(): Promise<SavedConnectorFilter[]> {
    await this.requireStorage();
    const rows = await this.db.prepare("SELECT * FROM connector_filters WHERE owner_id = ? ORDER BY created_at, filter_id")
      .bind(this.owner).all<ConnectorFilterRow>();
    return ListConnectorFiltersOutput.parse(await Promise.all(rows.results.map(row => this.decrypt(row))));
  }

  async get(filterId: string): Promise<SavedConnectorFilter> {
    const permissions = await servicePermissionFence(this.env, this.owner, "reminders.read");
    try { return await this.getBound(filterId); }
    finally { await permissions.assertCurrent(); }
  }

  private async getBound(filterId: string): Promise<SavedConnectorFilter> {
    const parsed = GetConnectorFilterInput.parse({ filterId });
    await this.requireStorage();
    const row = await this.db.prepare("SELECT * FROM connector_filters WHERE owner_id = ? AND filter_id = ?")
      .bind(this.owner, parsed.filterId).first<ConnectorFilterRow>();
    if (!row) throw new AppError("FORBIDDEN", "The requested connector filter is not available to this owner.", 403);
    return this.decrypt(row);
  }

  async delete(input: z.input<typeof DeleteConnectorFilterInput>): Promise<z.infer<typeof DeleteConnectorFilterOutput>> {
    const permissions = await servicePermissionFence(this.env, this.owner, "reminders.write", true);
    try { return await this.deleteBound(input, permissions.snapshot.revision); }
    finally { await permissions.assertCurrent(); }
  }

  private async deleteBound(input: z.input<typeof DeleteConnectorFilterInput>, permissionRevision: number): Promise<z.infer<typeof DeleteConnectorFilterOutput>> {
    const parsed = DeleteConnectorFilterInput.parse(input);
    await this.requireStorage();
    const result = await this.db.prepare("DELETE FROM connector_filters WHERE owner_id = ? AND filter_id = ? AND revision = ? AND " + SETTINGS_REVISION_GUARD)
      .bind(this.owner, parsed.filterId, parsed.expectedRevision, permissionRevision, this.owner, this.owner, permissionRevision).run();
    if (result.meta.changes !== 1) throw conflict("The connector filter revision changed or the filter is unavailable.");
    return DeleteConnectorFilterOutput.parse({ filterId: parsed.filterId, deleted: true });
  }
}
