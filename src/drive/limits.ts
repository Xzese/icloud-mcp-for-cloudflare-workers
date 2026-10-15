// Shared by the browser, schemas, transport and durable upload ledger.
export const INLINE_FILE_BYTES = 64 * 1024;
export const TEXT_PREVIEW_BYTES = 8 * 1024;
export const INLINE_REQUEST_BYTES = 96 * 1024;
// A browser request stays small even when the complete file spans gigabytes.
export const DRIVE_DIRECT_UPLOAD_BYTES = 64 * 1024 * 1024;
export const DRIVE_UPLOAD_PART_BYTES = 8 * 1024 * 1024;
export const DRIVE_STREAM_CHUNK_BYTES = 8 * 1024 * 1024;
export const DRIVE_STREAM_LEGACY_PROTOCOL = "icloud-drive-upload-v1";
export const DRIVE_STREAM_PROTOCOL = "icloud-drive-upload-v2";
export const DRIVE_TRANSFER_BLOCK_BYTES = 16 * 1024 * 1024;
export const DRIVE_FILE_BYTES = 2 * 1024 * 1024 * 1024;
export const DRIVE_FILE_LIMIT_LABEL = "2 GiB";
export const DRIVE_TRANSFER_TIMEOUT_MS = 30 * 60_000;
export const DRIVE_UPLOAD_LEASE_MS = DRIVE_TRANSFER_TIMEOUT_MS + 60_000;
export const DRIVE_UPLOAD_MINIMUM_LEASE_MS = DRIVE_TRANSFER_TIMEOUT_MS + 5_000;
