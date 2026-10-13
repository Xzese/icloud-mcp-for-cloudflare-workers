import { z } from "zod";
import { AppError } from "../../errors.ts";
import type { CloudKitConnection } from "../../icloud/cloudkit.ts";
import type { AppleSession, AppleSessionState, ApprovalAction } from "../../persistence/apple-sessions.ts";
import { validatedAppleURL } from "../../transport/apple-http.ts";
import type { ServiceSettings } from "../../services/settings.ts";

// Metadata discovery is deliberately separate from CloudKit and content URL policy.
export function validatedDriveServiceURL(value: string, service: "drivews" | "docws"): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new AppError("PROTOCOL_CHANGED", "Apple returned an invalid Drive service address."); }
  if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443" ||
      !new RegExp(`^p\\d{1,3}-${service}\\.icloud\\.com$`).test(url.hostname) ||
      url.pathname !== "/" || url.search || url.hash) {
    throw new AppError("PROTOCOL_CHANGED", "Apple returned a Drive service outside the supported metadata endpoints.");
  }
  return url;
}
const identity = {
  dsid: z.string().min(1).max(32).regex(/^\d+$/),
  clientId: z.string().min(1).max(100).regex(/^[A-Za-z0-9-]+$/),
  clientBuildNumber: z.string().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/),
  clientMasteringNumber: z.string().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/),
};
const endpoint = (service: "drivews" | "docws") => z.string().max(2048).url().refine(value => {
  try { validatedDriveServiceURL(value, service); return true; } catch { return false; }
});
export const DriveConnectionSchema = z.object({ ...identity, driveURL: endpoint("drivews"), documentsURL: endpoint("docws") }).strict();
// Structurally identical to the Drive client's connection; no runtime dependency.
export type SharedDriveConnection = z.infer<typeof DriveConnectionSchema>;
export type CommonAppleConnection = Omit<CloudKitConnection, "cloudKitURL"> & { cloudKitURL?: string };
export type DiscoveredAppleConnection = CommonAppleConnection & { drive?: SharedDriveConnection };
export const PcsCheckpointSchema = z.object({
  consentRequested: z.boolean(), pcsAttempts: z.number().int().min(0).max(10), consentChecks: z.number().int().min(0).max(10),
  expiresAt: z.number().int().positive().safe(), nextAttemptAt: z.number().int().nonnegative().safe(),
}).strict();
const consent = {
  state: z.enum(["UNAVAILABLE", "CONSENT_REQUIRED", "DEVICE_APPROVAL_PENDING", "READY", "ERROR"]),
  pcs: PcsCheckpointSchema.optional(),
  action: z.enum(["approve-device-consent", "wait-for-reminders-keys", "wait-for-drive-keys"]).optional(),
  lastErrorCode: z.enum(["DEVICE_APPROVAL_PENDING", "AUTH_EXPIRED", "RATE_LIMITED", "UPSTREAM_UNAVAILABLE", "PROTOCOL_CHANGED", "FORBIDDEN"]).optional(),
};
export const AppleServicesSchema = z.object({
  version: z.literal(1),
  reminders: z.object(consent).strict(),
  drive: z.object({ ...consent, connection: DriveConnectionSchema.optional() }).strict(),
}).strict().superRefine((services, context) => {
  for (const name of ["reminders", "drive"] as const) {
    const value = services[name];
    if (value.state === "DEVICE_APPROVAL_PENDING" && (!value.pcs || !value.action) ||
        value.state !== "DEVICE_APPROVAL_PENDING" && value.action !== undefined ||
        name === "drive" && value.action === "wait-for-reminders-keys" ||
        name === "reminders" && value.action === "wait-for-drive-keys" ||
        name === "drive" && value.state !== "UNAVAILABLE" && !services.drive.connection) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: "Inconsistent service consent state." });
    }
  }
});
export type AppleServices = z.infer<typeof AppleServicesSchema>;

// Legacy READY means Reminders approval only. Never infer Drive approval from it.
export function sessionServices(session: AppleSession, state: AppleSessionState, action: ApprovalAction | null = null): AppleServices {
  return session.services ?? {
    version: 1,
    reminders: { state: state === "READY" ? "READY" : "DEVICE_APPROVAL_PENDING", pcs: session.pcs,
      ...(state === "DEVICE_APPROVAL_PENDING" ? { action: action ?? "approve-device-consent" } : {}) },
    drive: { state: "UNAVAILABLE" },
  };
}
export function requireRemindersConnection(session: AppleSession): CloudKitConnection {
  if (!session.connection.cloudKitURL) throw new AppError("UNSUPPORTED_FEATURE", "Apple did not discover a Reminders service for this account.", 409);
  const url = validatedAppleURL(session.connection.cloudKitURL, true);
  if (url.pathname !== "/database/1/com.apple.reminders/production/private" || url.search) throw new AppError("PROTOCOL_CHANGED", "The Reminders endpoint is invalid.");
  return { ...session.connection, cloudKitURL: url.href };
}
export function requireDriveConnection(session: AppleSession): SharedDriveConnection {
  const connection = session.services?.drive.connection;
  if (!connection) throw new AppError("UNSUPPORTED_FEATURE", "Apple did not discover Drive services for this account. Check the saved account connection.", 409);
  return DriveConnectionSchema.parse(connection);
}
export function requireServiceReady(session: AppleSession, state: AppleSessionState, service: "reminders" | "drive", action: ApprovalAction | null = null) {
  const consent = sessionServices(session, state, action)[service];
  if (consent.state === "UNAVAILABLE") throw new AppError("UNSUPPORTED_FEATURE", `Apple did not discover the ${service} service.`, 409);
  if (consent.state !== "READY") throw new AppError("DEVICE_APPROVAL_PENDING", `Approve ${service} access using the dashboard's explicit Apple approval action.`, 409);
}
export function effectiveServiceStatus(session: AppleSession | null, state: AppleSessionState | null, settings: ServiceSettings, accountAvailable: boolean, action: ApprovalAction | null = null) {
  const services = session && state ? sessionServices(session, state, action) : null;
  const status = (name: "reminders" | "drive") => {
    const consent = services?.[name];
    const enabled = settings[name].enabled;
    const ready = enabled && accountAvailable && consent?.state === "READY";
    return { enabled, state: !enabled ? "DISABLED" : !session ? "DISCONNECTED" : consent?.state ?? "UNAVAILABLE", ready,
      action: consent?.action ?? (consent?.state === "CONSENT_REQUIRED" ? `approve-${name}` : null),
      nextAttemptAt: consent?.pcs?.nextAttemptAt ?? 0, lastErrorCode: consent?.lastErrorCode ?? null };
  };
  const reminders = status("reminders"), drive = status("drive");
  return { reminders: { ...reminders, read: reminders.ready && settings.reminders.read, write: reminders.ready && settings.reminders.write },
    drive: { ...drive, browse: drive.ready && settings.drive.browse, contents: drive.ready && settings.drive.browse && settings.drive.contents,
      upload: drive.ready && settings.drive.browse && settings.drive.upload, organize: drive.ready && settings.drive.browse && settings.drive.organize } };
}

export function refreshedServices(session: AppleSession, state: AppleSessionState, discovery: DiscoveredAppleConnection, action: ApprovalAction | null): AppleServices {
  const previous = sessionServices(session, state, action);
  const reminders = !discovery.cloudKitURL ? { ...previous.reminders, state: "UNAVAILABLE" as const, action: undefined } :
    previous.reminders.state === "UNAVAILABLE" ? { state: "CONSENT_REQUIRED" as const } : previous.reminders;
  const drive = !discovery.drive ? { ...previous.drive, state: "UNAVAILABLE" as const, connection: undefined, action: undefined } :
    { ...previous.drive, connection: discovery.drive, ...(previous.drive.state === "UNAVAILABLE" ? { state: "CONSENT_REQUIRED" as const } : {}) };
  return { version: 1, reminders, drive };
}
