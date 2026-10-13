import { AppError } from "../errors.ts";
import type { RuntimeEnv } from "../platform/sites.ts";
import { DEFAULT_SERVICE_SETTINGS, ServiceSettingsSchema, type ServiceSettings } from "../services/settings.ts";

export interface ServiceSettingsSnapshot {
  revision: number;
  settings: ServiceSettings;
  available: boolean;
}

interface SettingsRow { revision: number; settings_json: string; }

function isMissingSettingsTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:no such table|does not exist|table .* not found).*owner_service_settings|owner_service_settings.*(?:no such table|does not exist|not found)/i.test(message);
}

function parseStoredSettings(serialized: string): ServiceSettings {
  let value: unknown;
  try { value = JSON.parse(serialized); }
  catch { throw new AppError("CONFIGURATION_REQUIRED", "Stored service settings are invalid. Apply the service settings migration and repair the stored row before continuing.", 503); }
  const parsed = ServiceSettingsSchema.safeParse(value);
  if (!parsed.success) throw new AppError("CONFIGURATION_REQUIRED", "Stored service settings are invalid. Repair the stored row before continuing.", 503);
  return parsed.data;
}

function conflict(): never {
  throw new AppError("CONFLICT", "Service settings changed in another dashboard session. Reload the settings before saving again.", 409);
}

export class ServiceSettingsRepository {
  private readonly db: D1Database;
  private readonly owner: string;

  constructor(env: RuntimeEnv, owner: string) {
    if (!env.DB) throw new AppError("CONFIGURATION_REQUIRED", "The service settings database is not configured.", 503);
    this.db = env.DB;
    this.owner = owner;
  }

  async load(): Promise<ServiceSettingsSnapshot> {
    const db = this.db.withSession("first-primary");
    let row: SettingsRow | null;
    try {
      row = await db.prepare("SELECT revision, settings_json FROM owner_service_settings WHERE owner_id = ?")
        .bind(this.owner).first<SettingsRow>();
    } catch (error) {
      if (isMissingSettingsTable(error)) return { revision: 0, settings: structuredClone(DEFAULT_SERVICE_SETTINGS), available: false };
      throw error;
    }
    if (!row) return { revision: 0, settings: structuredClone(DEFAULT_SERVICE_SETTINGS), available: true };
    if (!Number.isSafeInteger(row.revision) || row.revision < 1 || typeof row.settings_json !== "string") {
      throw new AppError("CONFIGURATION_REQUIRED", "Stored service settings are invalid. Repair the stored row before continuing.", 503);
    }
    return { revision: row.revision, settings: parseStoredSettings(row.settings_json), available: true };
  }

  async save(input: { expectedRevision: number; settings: ServiceSettings }): Promise<ServiceSettingsSnapshot> {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new AppError("VALIDATION_ERROR", "expectedRevision must be a non-negative safe integer.");
    }
    const parsed = ServiceSettingsSchema.safeParse(input.settings);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "The service settings are invalid.");

    const db = this.db.withSession("first-primary");
    const settingsJson = JSON.stringify(parsed.data);
    try {
      let result: D1Result;
      if (input.expectedRevision === 0) {
        result = await db.prepare("INSERT INTO owner_service_settings (owner_id, revision, settings_json, updated_at) VALUES (?, 1, ?, ?) ON CONFLICT(owner_id) DO NOTHING")
          .bind(this.owner, settingsJson, Date.now()).run();
      } else {
        result = await db.prepare("UPDATE owner_service_settings SET revision = revision + 1, settings_json = ?, updated_at = ? WHERE owner_id = ? AND revision = ?")
          .bind(settingsJson, Date.now(), this.owner, input.expectedRevision).run();
      }
      if (result.meta.changes !== 1) conflict();
    } catch (error) {
      if (isMissingSettingsTable(error)) {
        throw new AppError("CONFIGURATION_REQUIRED", "Service settings are unavailable until the service settings migration is applied.", 503);
      }
      throw error;
    }
    return { revision: input.expectedRevision + 1, settings: parsed.data, available: true };
  }
}
