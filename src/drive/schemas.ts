import { z } from "zod";
import { INLINE_FILE_BYTES, TEXT_PREVIEW_BYTES, DRIVE_FILE_BYTES, DRIVE_FILE_LIMIT_LABEL } from "./limits.ts";
export { INLINE_FILE_BYTES, TEXT_PREVIEW_BYTES, INLINE_REQUEST_BYTES, DRIVE_FILE_BYTES } from "./limits.ts";

export const INLINE_UPLOAD_GUIDANCE = `Inline uploads allow at most 64 KiB of file bytes. Use dashboard Upload or /api/drive/prepare-upload followed by its authenticated binary uploadPath for files up to ${DRIVE_FILE_LIMIT_LABEL}.`;
export const DriveId = z.string().max(512).regex(/^(?:FOLDER|FILE)::com\.apple\.CloudDocs::[A-Za-z0-9._-]{1,256}$/)
  .describe("Exact owned item ID returned by Drive listing; never a local path or URL.");
export const DriveName = z.string().min(1).max(255).refine(value => value.trim() === value && value !== "." && value !== ".." && !/[\u0000-\u001f\u007f/\\]/.test(value), "Use a simple filename without path separators or control characters.");
export const Generation = z.number().int().nonnegative().safe().optional();
export const OperationId = z.string().uuid().transform(value => value.toLowerCase());
const common = { expectedGeneration: Generation };
export const ListDrive = z.object({ ...common, folderId: DriveId.default("FOLDER::com.apple.CloudDocs::root") }).strict();
export const GetDriveItem = z.object({ ...common, itemId: DriveId }).strict();
export const SearchDrive = z.object({ ...common, folderId: DriveId.default("FOLDER::com.apple.CloudDocs::root"), query: z.string().trim().min(1).max(200), continuation: z.string().uuid().optional() }).strict();
export const ReadDrive = GetDriveItem.extend({ encoding: z.enum(["utf8", "base64"]).default("utf8"),
  previewBytes: z.number().int().min(1).max(TEXT_PREVIEW_BYTES).optional().describe(`Read only this many leading bytes as UTF-8, up to 8192, for a file up to ${DRIVE_FILE_LIMIT_LABEL}. The result reports bytesRead and truncated. Omit for a full read up to 64 KiB.`),
});
export const DownloadDrive = GetDriveItem;
export const CreateDriveFolder = z.object({ ...common, parentId: DriveId, name: DriveName, operationId: OperationId.describe("Stable operation key; retain after uncertain outcomes.") }).strict();
export const RenameDriveItem = z.object({ ...common, itemId: DriveId, etag: z.string().min(1).max(512), name: DriveName, operationId: OperationId }).strict();
export const MoveDriveItem = z.object({ ...common, itemId: DriveId, etag: z.string().min(1).max(512), destinationId: DriveId, operationId: OperationId }).strict();
export const UploadDriveMetadata = z.object({ ...common, parentId: DriveId, name: DriveName, operationId: OperationId,
  size: z.number().int().nonnegative().max(DRIVE_FILE_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  contentType: z.string().max(128).regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/).default("application/octet-stream"),
}).strict();
export const UploadDrive = UploadDriveMetadata.extend({ size: z.number().int().nonnegative().max(INLINE_FILE_BYTES, INLINE_UPLOAD_GUIDANCE),
  contentBase64: z.string().max(Math.ceil(INLINE_FILE_BYTES / 3) * 4, INLINE_UPLOAD_GUIDANCE) });
export const GetDriveOperation = z.object({ ...common, operationId: OperationId }).strict();
export const DriveConsent = z.object({ expectedGeneration: z.number().int().nonnegative().safe(), restartApproval: z.boolean().optional() }).strict();
