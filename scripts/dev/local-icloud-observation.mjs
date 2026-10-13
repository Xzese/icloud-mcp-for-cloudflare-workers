// Counts and protocol metadata only. No account identifiers, field values or tokens.
import { DRIVE_MAX_METADATA_BYTES, DRIVE_MAX_TRANSFER_BYTES, DRIVE_TRANSFER_TIMEOUT_MS, validateDriveMetadataURL, driveContentURL } from "../../src/transport/drive-http.ts";

export function localAppleHeaders(input) {
  const headers = new Headers(input);
  // Miniflare adds a fictitious zone marker (worker.example.com). That is local
  // emulation metadata, not an Apple protocol header or a real hosted Worker.
  headers.delete("cf-worker");
  return headers;
}

export function localAppleContentHeaders(input) {
  const incoming = new Headers(input);
  // Forward only protocol framing. Signed content URLs are bearer credentials,
  // and must never receive Apple session or other caller-supplied credentials.
  const headers = new Headers();
  for (const name of ["accept", "content-type"]) {
    const value = incoming.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

export function classifyDriveRelayURL(url) {
  try { validateDriveMetadataURL(url); return "metadata"; }
  catch { /* Try the two signed content URL shapes below. */ }
  try { driveContentURL(url.href, "download"); return "download"; }
  catch { /* Try the upload URL shape below. */ }
  const dsid = /^\/(\d{1,32})\/singleFileUpload$/.exec(url.pathname)?.[1];
  if (dsid) {
    try { driveContentURL(url.href, "upload", dsid); return "upload"; }
    catch { /* Unsupported host, query, or URL credentials. */ }
  }
  return null;
}

export { DRIVE_MAX_METADATA_BYTES, DRIVE_MAX_TRANSFER_BYTES, DRIVE_TRANSFER_TIMEOUT_MS };
export function summarizeAppleFailure(url, { stage, status, bytesRead, elapsedMs, timeout, aborted, error }) {
  return {
    at: new Date().toISOString(), host: url.hostname, path: url.pathname, event: "local-apple-request-failed",
    stage: ["headers", "body", "observation"].includes(stage) ? stage : "unknown",
    status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
    bytesRead: Number.isSafeInteger(bytesRead) && bytesRead >= 0 ? bytesRead : null,
    elapsedMs: Number.isSafeInteger(elapsedMs) && elapsedMs >= 0 ? elapsedMs : null,
    failure: error?.code === "LOCAL_RESPONSE_BYTE_BUDGET" ? "response-byte-budget" : timeout ? "timeout" : aborted ? "incoming-abort" : "transport-failure",
  };
}
export function summarizeAppleResponse(url, status, body) {
  const result = { at: new Date().toISOString(), host: url.hostname, path: url.pathname, status };
  if (/^p\d{1,3}-docws\.icloud\.com$/.test(url.hostname) && url.pathname === "/ws/com.apple.CloudDocs/upload/web") {
    result.allocationShape = Array.isArray(body) ? "array" : body === null ? "null" : typeof body;
    const entries = Array.isArray(body) ? body.slice(0, 2) : [body];
    result.allocations = entries.map(entry => {
      const fields = {};
      for (const key of ["document_id", "url", "status", "size", "content_type"]) {
        const value = entry?.[key];
        fields[key] = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
      }
      let target;
      if (typeof entry?.url === "string") try {
        const address = new URL(entry.url);
        target = { host: ["cws.icloud-content.com", "cvws.icloud-content.com"].includes(address.hostname) || /^p\d{1,3}-contentws\.icloud\.com$/.test(address.hostname) ? address.hostname : "other",
          route: /^\/\d{1,32}\/singleFileUpload$/.test(address.pathname) ? "account-single-file-upload" : "other",
          signedTokenPresent: address.searchParams.has("tk") };
      } catch { target = { invalid: true }; }
      return { fields, ...(target ? { target } : {}) };
    });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return result;
  if (/^p\d{1,3}-(?:drivews|docws)\.icloud\.com$/.test(url.hostname) && status >= 400) {
    const reason = [body.errorMessage, body.errorReason, body.reason, body.message].filter(value => typeof value === "string").join(" ").toLowerCase();
    result.protocolErrorTerms = ["invalid", "missing", "object", "array", "item", "folder", "file", "body", "json", "request", "root", "argument", "parameter", "not found"].filter(term => reason.includes(term));
  }
  if (/^p\d{1,3}-docws\.icloud\.com$/.test(url.hostname) && url.pathname === "/ws/com.apple.CloudDocs/update/documents") {
    result.commitStatus = Number.isSafeInteger(body.status?.status_code) ? body.status.status_code : null;
    result.resultCount = Array.isArray(body.results) ? body.results.length : null;
    result.documents = (Array.isArray(body.results) ? body.results.slice(0, 2) : []).map(entry => {
      const doc = entry?.document;
      const fields = {};
      for (const key of ["document_id", "item_id", "zone", "parent_id", "name", "extension", "etag", "type", "size"]) {
        const value = doc?.[key];
        fields[key] = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
      }
      return { status: Number.isSafeInteger(entry?.status?.status_code) ? entry.status.status_code : null, fields,
        parentIdentityKind: typeof doc?.parent_id !== "string" ? "absent" : doc.parent_id.startsWith("FOLDER::com.apple.CloudDocs::") ? "owned-folder" : "opaque",
        nameIncludesExtension: typeof doc?.name === "string" && doc.name.includes(".") };
    });
  }
  if (url.hostname === "setup.icloud.com" && url.pathname === "/setup/ws/1/accountLogin") {
    result.services = {};
    for (const [name, service] of Object.entries(body.webservices ?? {})) {
      if (!/^[a-z][a-z0-9_-]{0,50}$/i.test(name) || typeof service?.url !== "string") continue;
      try {
        const address = new URL(service.url);
        if (address.protocol !== "https:" || address.username || address.password || address.port || !/(^|\.)(icloud\.com|apple\.com)$/.test(address.hostname)) continue;
        result.services[name] = { origin: address.origin, disabled: service.disabled === true };
      } catch { /* Unsupported advertised service: do not log it. */ }
    }
  }
  if (/^p\d{1,3}-ckdatabasews\.icloud\.com$/.test(url.hostname)) {
    const zones = Array.isArray(body.zones) ? body.zones : [];
    result.zones = zones.length;
    result.remindersZonePresent = zones.some(z => z?.zoneID?.zoneName === "Reminders");
    const records = Array.isArray(body.records) ? body.records : zones.flatMap(z => Array.isArray(z?.records) ? z.records : []);
    result.records = records.length;
    result.recordTypes = {};
    result.relationshipFieldTypes = {};
    for (const record of records) {
      const type = typeof record?.recordType === "string" && ["List", "Reminder", "Alarm", "AlarmTrigger", "Attachment", "Hashtag", "RecurrenceRule"].includes(record.recordType) ? record.recordType : "other";
      result.recordTypes[type] = (result.recordTypes[type] ?? 0) + 1;
      if (type === "Reminder") for (const key of ["AlarmIDs", "AttachmentIDs", "HashtagIDs", "RecurrenceRuleIDs"]) {
        const field = record.fields?.[key];
        if (!field || typeof field !== "object") continue;
        const fieldType = ["STRING", "STRING_LIST", "REFERENCE_LIST", "INT64_LIST", "UNKNOWN_LIST", "EMPTY_LIST"].includes(field.type) ? field.type : "other";
        const shape = Array.isArray(field.value) ? field.value.length === 0 ? "empty-array" : "array" : field.value == null ? "null" : typeof field.value === "string" ? "string" : "other";
        const bucket = `${key}:${fieldType}:${shape}`;
        result.relationshipFieldTypes[bucket] = (result.relationshipFieldTypes[bucket] ?? 0) + 1;
      }
    }
    result.queryContinuationPresent = typeof body.continuationMarker === "string";
    result.errors = records.filter(r => typeof r?.serverErrorCode === "string").length;
    if (result.errors) {
      const known = new Set(["CONFLICT", "SERVER_RECORD_CHANGED", "ALREADY_EXISTS", "BATCH_REQUEST_FAILED", "ATOMIC_ERROR",
        "BATCH_ERROR", "NOT_EXECUTED", "BAD_REQUEST", "INVALID_ARGUMENTS", "VALIDATION_ERROR", "UNKNOWN_ITEM", "NOT_FOUND",
        "THROTTLED", "REQUEST_RATE_LIMITED", "AUTHENTICATION_REQUIRED", "ACCESS_DENIED"]);
      result.recordErrorCodes = {};
      for (const record of records) if (typeof record?.serverErrorCode === "string") {
        const code = known.has(record.serverErrorCode) ? record.serverErrorCode : "other";
        result.recordErrorCodes[code] = (result.recordErrorCodes[code] ?? 0) + 1;
      }
    }
    result.responseError = typeof body.serverErrorCode === "string";
    if (result.responseError) {
      result.responseErrorCode = /^[A-Z_]{1,64}$/.test(body.serverErrorCode) ? body.serverErrorCode : "other";
      // Only fixed protocol words are retained, never Apple's free-form reason.
      const reason = typeof body.reason === "string" ? body.reason : "";
      result.errorTerms = ["unsupported", "unknown", "invalid", "missing", "query", "filter", "field", "reference", "record", "zone", "type", "limit", "List", "reminderList", "includeCompleted", "LookupValidatingReference", "permission", "index", "not found", "deleted"].filter(term => reason.toLowerCase().includes(term.toLowerCase()));
      result.errorReasonLength = reason.length;
    }
  }
  return result;
}
