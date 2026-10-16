import { z } from "zod";
import { OwnedDriveId, OperationId, UploadDriveMetadata } from "./schemas.ts";
import { DriveItemSchema } from "../icloud/drive.ts";

export const DRIVE_BATCH_FILES = 25;
export const DRIVE_BATCH_BYTES = 32 * 1024;
export const BatchFile = UploadDriveMetadata.pick({ name: true, operationId: true, size: true, sha256: true, contentType: true }).extend({
  size: z.number().int().min(0).max(DRIVE_BATCH_BYTES),
  contentBase64: z.string().max(Math.ceil(DRIVE_BATCH_BYTES / 3) * 4),
}).strict();
// Cross-field/content validation also runs in the service, before any mutation.
export const CreateDriveBatch = z.object({ jobId: OperationId, parentId: OwnedDriveId,
  expectedGeneration: z.number().int().nonnegative().safe(), files: z.array(BatchFile).min(1).max(DRIVE_BATCH_FILES),
}).strict();
export const DriveBatchIdentity = z.object({ jobId: OperationId, expectedGeneration: z.number().int().nonnegative().safe() }).strict();
export const GetDriveBatch = DriveBatchIdentity.extend({ offset: z.number().int().min(0).max(DRIVE_BATCH_FILES).default(0), limit: z.number().int().min(1).max(10).default(10) }).strict();
export const BatchItemState = z.object({ phase: z.enum(["pending", "running", "confirmed", "failed", "unknown"]), errorCode: z.string().max(64).optional() }).strict();
export const BatchState = z.object({ items: z.array(BatchItemState).min(1).max(DRIVE_BATCH_FILES) }).strict();
export const DriveBatchOutput = z.object({ jobId: z.string().uuid(), generation: z.number(),
  status: z.enum(["ready", "running", "finished", "cancelled"]), executionMode: z.literal("request-driven"),
  total: z.number(), counts: z.object({ pending: z.number(), running: z.number(), confirmed: z.number(), failed: z.number(), unknown: z.number(), cancelled: z.number() }).strict(),
  results: z.array(z.object({ ordinal: z.number(), operationId: z.string().uuid(), name: z.string(), phase: z.enum(["pending", "running", "confirmed", "failed", "unknown", "cancelled"]), errorCode: z.string().optional(), item: DriveItemSchema.optional() }).strict()),
  nextOffset: z.number().nullable(), expiresAt: z.number(),
}).strict();
