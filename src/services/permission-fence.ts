import { AppError } from "../errors.ts";
import { ServiceSettingsRepository } from "../persistence/service-settings.ts";
import type { RuntimeEnv } from "../platform/sites.ts";
import { requireServicePermission, type ServicePermission } from "./settings.ts";

/** A request keeps its original settings revision, even across disable/re-enable. */
export async function servicePermissionFence(env: RuntimeEnv, owner: string, permission: ServicePermission, requireAvailable = false) {
  const repository = new ServiceSettingsRepository(env, owner);
  const snapshot = await repository.load();
  requireServicePermission(snapshot.settings, permission);
  if (requireAvailable && !snapshot.available) {
    throw new AppError("CONFIGURATION_REQUIRED", "Apply migration 0002_service_settings.sql before using this mutation workflow.", 503);
  }
  return {
    snapshot,
    async assertCurrent() {
      const current = await repository.load();
      requireServicePermission(current.settings, permission);
      if (current.revision !== snapshot.revision || current.available !== snapshot.available) {
        throw new AppError("CONFLICT", "Service permissions changed during this request. Start a new request; committed receipts are preserved.", 409);
      }
    },
  };
}
