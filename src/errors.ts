import type { RecurringCompletionRequest } from "./persistence/apple-sessions.ts";

export type ErrorCode =
  | "UNAUTHENTICATED" | "FORBIDDEN" | "OWNER_NOT_CONFIGURED"
  | "NOT_CONNECTED" | "UNSUPPORTED_AUTH" | "UNSUPPORTED_FEATURE"
  | "VALIDATION_ERROR" | "PROTOCOL_CHANGED" | "UPSTREAM_UNAVAILABLE"
  | "RATE_LIMITED" | "CONFIGURATION_REQUIRED" | "CONFLICT"
  | "REAUTH_REQUIRED" | "VERIFICATION_REQUIRED" | "DEVICE_APPROVAL_PENDING"
  | "TERMS_ACTION_REQUIRED" | "AUTH_EXPIRED" | "RESTART_REQUIRED" | "WRITE_OUTCOME_UNKNOWN"
  | "JOB_EXPIRED" | "JOB_CANCELLED";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  constructor(code: ErrorCode, message: string, status = 422, retryable = false) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export interface ListMembershipDiagnostics {
  fieldType: "STRING" | "OTHER";
  stringLength: number | null;
  jsonShape: "not_inspected" | "invalid" | "array" | "object" | "scalar";
  arrayLength: number | null;
}

/** Shape and size only: never retain the field value, IDs or parser exceptions. */
export class ListMembershipError extends AppError {
  readonly membershipDiagnostics: ListMembershipDiagnostics;
  constructor(code: "PROTOCOL_CHANGED" | "UNSUPPORTED_FEATURE", message: string, diagnostics: ListMembershipDiagnostics) {
    super(code, message);
    this.membershipDiagnostics = diagnostics;
  }
}

export interface InspectionReadDiagnostics {
  elapsedMs: number;
  requests: { path: string; elapsedMs: number; records: number; recordTypes: Record<string, number>; continuation: boolean }[];
}

/** Bounded timing and counts from an already-authorized read, never trace bodies. */
export class InspectionReadError extends AppError {
  readonly inspectionDiagnostics: InspectionReadDiagnostics;
  constructor(error: AppError, diagnostics: InspectionReadDiagnostics) {
    super(error.code, error.message, error.status, error.retryable);
    this.inspectionDiagnostics = diagnostics;
  }
}

export class WriteOutcomeUnknownError extends AppError {
  readonly reminderId: string;
  readonly listId?: string;
  readonly idempotencyKey?: string;
  readonly diagnostics?: WriteDiagnostics;
  readonly originalRequest?: RecurringCompletionRequest;
  constructor(reminderId: string, idempotencyKey?: string, details?: { diagnostics?: WriteDiagnostics; originalRequest?: RecurringCompletionRequest }) {
    super("WRITE_OUTCOME_UNKNOWN", reminderId.startsWith("List/")
      ? "Apple may have saved the list change, but this request could not confirm the result. Use get_reminder_list with this exact listId before trying another change. For creation, retain the same idempotencyKey; never generate another ID for this attempt."
      : "Apple may have saved the reminder, but this request could not confirm the result. Read the reminder before trying another change. For creation, reuse the same idempotencyKey; never generate another ID for this attempt." +
        (details?.originalRequest ? " For this recurring completion, repeat originalRequest unchanged. The server will reconcile the retained operation and may safely retry the same exact atomic write; never substitute a fresh version." : ""), 503, false);
    this.reminderId = reminderId;
    if (reminderId.startsWith("List/")) this.listId = reminderId;
    this.idempotencyKey = idempotencyKey;
    this.diagnostics = details?.diagnostics;
    this.originalRequest = details?.originalRequest;
  }
}

/** Only bounded phase, status and timing metadata; never Apple bodies, fields or credentials. */
export interface WriteDiagnostics {
  phase: "transport" | "upstream_response" | "confirmation" | "reconciliation";
  cause: ErrorCode;
  upstreamStatus: number | null;
  elapsedMs: number;
  dispatchAttempted?: boolean;
}

export function publicError(error: unknown, requestId: string) {
  const e = error instanceof AppError ? error : new AppError(
    "UPSTREAM_UNAVAILABLE", "This operation could not be completed. Try the connection again.", 503, true,
  );
  return { code: e.code, message: e.message, retryable: e.retryable, requestId,
    ...(e instanceof ListMembershipError ? { membershipDiagnostics: e.membershipDiagnostics } : {}),
    ...(e instanceof InspectionReadError ? { inspectionDiagnostics: e.inspectionDiagnostics } : {}),
    ...(e instanceof WriteOutcomeUnknownError ? { ...(e.listId ? { listId: e.listId } : { reminderId: e.reminderId }), ...(e.idempotencyKey ? { idempotencyKey: e.idempotencyKey } : {}),
      ...(e.diagnostics ? { writeDiagnostics: e.diagnostics } : {}), ...(e.originalRequest ? { originalRequest: e.originalRequest } : {}) } : {}) };
}

export function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AppError("VALIDATION_ERROR", message);
}
