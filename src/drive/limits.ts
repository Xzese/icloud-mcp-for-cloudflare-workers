// Shared by the browser, schemas, transport and durable upload ledger.
export const INLINE_FILE_BYTES = 64 * 1024;
export const TEXT_PREVIEW_BYTES = 8 * 1024;
export const INLINE_REQUEST_BYTES = 96 * 1024;
export const DRIVE_FILE_BYTES = 64 * 1024 * 1024;
export const DRIVE_FILE_LIMIT_LABEL = `${DRIVE_FILE_BYTES / (1024 * 1024)} MiB`;
export const DRIVE_TRANSFER_TIMEOUT_MS = 5 * 60_000;
export const DRIVE_UPLOAD_LEASE_MS = DRIVE_TRANSFER_TIMEOUT_MS + 60_000;
export const DRIVE_UPLOAD_MINIMUM_LEASE_MS = DRIVE_TRANSFER_TIMEOUT_MS + 5_000;
