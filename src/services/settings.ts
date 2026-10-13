import { z } from "zod";
import { AppError } from "../errors.ts";

export const ServiceSettingsSchema = z.object({
  reminders: z.object({
    enabled: z.boolean(),
    read: z.boolean(),
    write: z.boolean(),
  }).strict(),
  drive: z.object({
    enabled: z.boolean(),
    browse: z.boolean(),
    contents: z.boolean(),
    upload: z.boolean(),
    organize: z.boolean(),
  }).strict().superRefine((drive, context) => {
    if (drive.enabled && !drive.browse && (drive.contents || drive.upload || drive.organize)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Drive browsing is required for contents, upload, or organize access.", path: ["browse"] });
    }
  }),
}).strict();

export type ServiceSettings = z.infer<typeof ServiceSettingsSchema>;

export const DEFAULT_SERVICE_SETTINGS: ServiceSettings = {
  reminders: { enabled: true, read: true, write: true },
  drive: { enabled: false, browse: false, contents: false, upload: false, organize: false },
};

export type ServicePermission =
  | "reminders.read"
  | "reminders.write"
  | "drive.browse"
  | "drive.contents"
  | "drive.upload"
  | "drive.organize";

export function isServicePermissionEnabled(settings: ServiceSettings, permission: ServicePermission): boolean {
  const [service, operation] = permission.split(".") as ["reminders" | "drive", string];
  if (!settings[service].enabled) return false;
  if (service === "reminders") return operation === "read" ? settings.reminders.read : settings.reminders.write;
  if (operation === "browse") return settings.drive.browse;
  return settings.drive.browse && settings.drive[operation as "contents" | "upload" | "organize"];
}

export function requireServicePermission(settings: ServiceSettings, permission: ServicePermission): void {
  if (!isServicePermissionEnabled(settings, permission)) {
    throw new AppError("FORBIDDEN", `The ${permission} service permission is disabled.`, 403);
  }
}
