import { z } from "zod";
import { DRIVE_FILE_LIMIT_LABEL } from "../drive/limits.ts";
import { DriveListingDiagnostics, type DriveListingReason } from "../drive/listing.ts";
import { DriveSharedContext, DriveShareID, type SharedContext, type DriveSharedStore } from "../drive/shared.ts";
import { canonicalJSON } from "../lib/canonical.ts";
import { AppError } from "../errors.ts";
import type { AppleHTTP } from "../transport/apple-http.ts";
import { DRIVE_MAX_METADATA_BYTES, DRIVE_MAX_TRANSFER_BYTES, DriveHTTP, driveContentURL, driveServiceURL } from "../transport/drive-http.ts";

const ROOT_ID = "FOLDER::com.apple.CloudDocs::root";
const ZONE = "com.apple.CloudDocs";
const MAX_ITEMS = 1_000;
const NAME_MAX = 255;
const IDENTIFIER = /^[A-Za-z0-9._:-]{1,512}$/;

export const DRIVE_ROOT = ROOT_ID;

function protocol(message: string): never {
  throw new AppError("PROTOCOL_CHANGED", message);
}

const origin = z.string().url().superRefine((value, ctx) => {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) ctx.addIssue({ code: "custom", message: "Expected a service origin URL." });
  } catch { ctx.addIssue({ code: "custom", message: "Expected an HTTPS service origin." }); }
});

export const DriveConnectionSchema = z.object({
  dsid: z.string().regex(/^\d{1,32}$/),
  clientId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  clientBuildNumber: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  clientMasteringNumber: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  driveURL: origin,
  documentsURL: origin,
}).strict().superRefine((connection, ctx) => {
  try {
    if (!/^p\d+-drivews\.icloud\.com$/.test(new URL(connection.driveURL).hostname)) ctx.addIssue({ code: "custom", path: ["driveURL"], message: "Expected an exact p[digits]-drivews.icloud.com origin." });
    if (!/^p\d+-docws\.icloud\.com$/.test(new URL(connection.documentsURL).hostname)) ctx.addIssue({ code: "custom", path: ["documentsURL"], message: "Expected an exact p[digits]-docws.icloud.com origin." });
  } catch { /* The origin schema already reports malformed URLs. */ }
});
export type DriveConnection = z.infer<typeof DriveConnectionSchema>;

export const DriveItemSchema = z.object({
  id: z.string().regex(/^(?:FOLDER|FILE)(?:_IN_SHARED_FOLDER)?::com\.apple\.CloudDocs::[A-Za-z0-9._-]{1,256}$/),
  // Upstream fixtures show docwsid is an opaque document key (UUID), with "root" for Drive root.
  documentId: z.string().regex(/^[A-Za-z0-9._-]{1,256}$/),
  zone: z.literal(ZONE),
  name: z.string().min(1).max(NAME_MAX),
  type: z.enum(["file", "folder"]),
  etag: z.string().min(1).max(512),
  size: z.number().int().safe().nonnegative().nullable(),
  parentId: z.string().regex(/^FOLDER(?:_IN_SHARED_FOLDER)?::com\.apple\.CloudDocs::[A-Za-z0-9._-]{1,256}$/).nullable(),
  modifiedAt: z.string().datetime({ offset: true }).nullable(),
  shareContext: z.string().uuid().optional(),
}).strict();
export type DriveItem = z.infer<typeof DriveItemSchema>;
export type DriveListing = z.infer<typeof DriveListingDiagnostics> & { folder: DriveItem; items: DriveItem[] };

export const UploadReceiptSchema = z.object({
  referenceChecksum: z.string().min(1).max(8192),
  size: z.number().int().safe().nonnegative().max(DRIVE_MAX_TRANSFER_BYTES),
  fileChecksum: z.string().min(1).max(8192),
  wrappingKey: z.string().min(1).max(8192),
  receipt: z.string().min(1).max(8192).optional(),
}).strict();
export type UploadReceipt = z.infer<typeof UploadReceiptSchema>;

export const DriveUploadAllocationSchema = z.object({
  documentId: z.string().regex(/^[A-Za-z0-9._-]{1,256}$/),
  url: z.string().min(1).max(8192),
}).strict();
export type DriveUploadAllocation = z.infer<typeof DriveUploadAllocationSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, max = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

function ownedId(value: unknown, prefixes: readonly string[] = ["FOLDER", "FILE", "DOCUMENT"]): value is string {
  if (!text(value, 512) || !IDENTIFIER.test(value)) return false;
  const parts = value.split("::");
  return parts.length === 3 && prefixes.includes(parts[0]!) && parts[1] === ZONE && /^[A-Za-z0-9._-]{1,256}$/.test(parts[2]!);
}

function opaqueDocumentId(value: unknown): value is string {
  return text(value, 256) && /^[A-Za-z0-9._-]{1,256}$/.test(value);
}

function readableId(value: unknown, prefixes: readonly string[] = ["FOLDER", "FILE"]): value is string {
  return ownedId(value, prefixes.flatMap(prefix => [prefix, `${prefix}_IN_SHARED_FOLDER`]));
}

function validName(name: string): void {
  if (typeof name !== "string" || name.length < 1 || name.length > NAME_MAX || name.trim() !== name || /[\u0000-\u001f\u007f/\\]/.test(name) || name === "." || name === "..") {
    throw new AppError("VALIDATION_ERROR", "The iCloud Drive name is invalid.");
  }
}

function isoDate(value: unknown): string | null {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return new Date(value).toISOString();
  return null;
}

function item(raw: unknown, expectedParent: string | null = null, shareContext?: string): DriveItem {
  if (!isRecord(raw)) return protocol("Apple returned an invalid iCloud Drive item.");
  const id = raw.drivewsid;
  const documentId = raw.docwsid ?? raw.document_id;
  if (!readableId(id) || !opaqueDocumentId(documentId) || raw.zone !== ZONE || !shareContext && (raw.shareID !== undefined || raw.shareId !== undefined || raw.share !== undefined || String(id).includes("_IN_SHARED_FOLDER::"))) {
    return protocol("Apple returned an unsupported or unscoped iCloud Drive item.");
  }
  const kind = typeof raw.type === "string" ? raw.type.toLowerCase() : "";
  if (kind !== "file" && kind !== "folder") return protocol("Apple returned an unsupported iCloud Drive item type.");
  let name = raw.name;
  if (typeof name === "string" && typeof raw.extension === "string" && raw.extension && !name.endsWith(`.${raw.extension}`)) name = `${name}.${raw.extension}`;
  if (id === ROOT_ID && name === "") name = "root";
  if (!text(name, NAME_MAX) || !text(raw.etag, 512)) return protocol("Apple returned invalid iCloud Drive item metadata.");
  if (id === ROOT_ID && kind !== "folder") return protocol("Apple returned an invalid iCloud Drive root item.");
  const rawParent = raw.parentId ?? raw.parentDrivewsId ?? expectedParent;
  if (rawParent !== null && rawParent !== undefined && !readableId(rawParent, ["FOLDER"])) return protocol("Apple returned an unsupported iCloud Drive parent identity.");
  if (expectedParent !== null && rawParent !== null && rawParent !== undefined && rawParent !== expectedParent) return protocol("Apple returned an iCloud Drive child with a different parent identity.");
  const parentId = rawParent === null || rawParent === undefined ? null : rawParent;
  const size = raw.size === undefined || raw.size === null || kind === "folder" ? null : typeof raw.size === "number" ? raw.size : typeof raw.size === "string" && /^\d+$/.test(raw.size) ? Number(raw.size) : NaN;
  const parsed = DriveItemSchema.safeParse({ id, documentId, zone: ZONE, name, type: kind, etag: raw.etag, size, parentId, modifiedAt: isoDate(raw.dateModified ?? raw.dateChanged), ...(shareContext ? { shareContext } : {}) });
  if (!parsed.success) return protocol("Apple returned invalid iCloud Drive item metadata.");
  return parsed.data;
}

function checkStatus(raw: Record<string, unknown>): void {
  const status = raw.status;
  if (status === undefined || status === null || status === 0 || status === "0" || status === "OK" || status === "SUCCESS") return;
  if (status === "ETAG_CONFLICT") throw new AppError("CONFLICT", "The iCloud Drive item changed since it was read. Refresh it before retrying.", 409);
  protocol("Apple reported an iCloud Drive item or operation error.");
}

function parseJSON(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch { return protocol("Apple returned invalid iCloud Drive metadata JSON."); }
}

function validateItemId(id: string): void {
  if (!readableId(id) || id === "FOLDER::com.apple.CloudDocs::TRASH_ROOT") throw new AppError("VALIDATION_ERROR", "Only ordinary owned or scoped shared iCloud Drive items are supported.");
}

function requireOwned(selected: DriveItem): void {
  if (selected.shareContext || !ownedId(selected.id, ["FOLDER", "FILE"])) throw new AppError("UNSUPPORTED_FEATURE", "Shared iCloud Drive items support browsing and reads only; shared writes are not supported.", 409);
}

export class DriveClient {
  private readonly drive: URL;
  private readonly documents: URL;
  private readonly params: URLSearchParams;
  private readonly transport: DriveHTTP;
  private readonly http: AppleHTTP;
  private readonly dsid: string;
  private readonly sharedStore: DriveSharedStore;
  private readonly sharedContexts = new Map<string, SharedContext>();
  private readonly sharedIds = new Map<string, string>();
  private readonly uploadAllocations = new Map<string, { url: string; name: string; size: number; contentType: string }>();

  constructor(http: AppleHTTP, connection: DriveConnection, sharedStore?: DriveSharedStore) {
    const parsed = DriveConnectionSchema.safeParse(connection);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "The saved iCloud Drive connection is invalid.");
    this.http = http;
    this.dsid = connection.dsid;
    this.drive = driveServiceURL(connection.driveURL, "drivews");
    this.documents = driveServiceURL(connection.documentsURL, "docws");
    this.transport = new DriveHTTP(http);
    this.params = new URLSearchParams({ clientBuildNumber: connection.clientBuildNumber, clientMasteringNumber: connection.clientMasteringNumber, clientId: connection.clientId, dsid: connection.dsid });
    this.sharedStore = sharedStore ?? {
      save: async context => { const id = crypto.randomUUID(); this.sharedContexts.set(id, context); return id; },
      load: async id => { const context = this.sharedContexts.get(id); if (!context) throw new AppError("CONFLICT", "The shared Drive context is unavailable. Browse its parent again.", 409); return context; },
    };
  }

  private async shared(id?: string): Promise<SharedContext | undefined> {
    if (!id) return undefined;
    if (!this.sharedContexts.has(id)) this.sharedContexts.set(id, DriveSharedContext.parse(await this.sharedStore.load(id)));
    return this.sharedContexts.get(id)!;
  }
  private async contextFor(raw: Record<string, unknown>, inheritedId?: string): Promise<string | undefined> {
    const inherited = await this.shared(inheritedId);
    const descriptor = raw.shareID ?? raw.shareId;
    const parsedDescriptor = descriptor === undefined ? undefined : DriveShareID.safeParse(descriptor);
    if (parsedDescriptor && !parsedDescriptor.success) return protocol("Apple returned an unsupported iCloud Drive sharing descriptor.");
    const shareID = descriptor === undefined ? inherited?.shareID : parsedDescriptor!.data;
    if (shareID === undefined) return undefined;
    const owner = isRecord(raw.owner) ? raw.owner.ownerRecordName : undefined;
    const descriptorOwner = isRecord(shareID) ? shareID.ownerRecordName ?? (isRecord(shareID.zoneID) ? shareID.zoneID.ownerRecordName : undefined) : undefined;
    const ownerRecordName = owner ?? (descriptor === undefined ? inherited?.ownerRecordName : descriptorOwner);
    const parsedContext = DriveSharedContext.safeParse({ shareID, ...(ownerRecordName === undefined ? {} : { ownerRecordName }) });
    if (!parsedContext.success) return protocol("Apple returned an unsupported iCloud Drive sharing owner.");
    const context = parsedContext.data;
    const key = canonicalJSON(context);
    if (!this.sharedIds.has(key)) {
      const id = await this.sharedStore.save(context);
      this.sharedIds.set(key, id); this.sharedContexts.set(id, context);
    }
    return this.sharedIds.get(key)!;
  }

  private endpoint(service: "drive" | "documents", path: string, params = this.params): URL {
    const url = new URL(service === "drive" ? this.drive.href : this.documents.href);
    url.pathname = `${path.startsWith("/") ? "" : "/"}${path}`;
    url.search = params.toString();
    return url;
  }

  private async request(service: "drive" | "documents", path: string, method: "GET" | "POST", payload?: unknown, params = this.params): Promise<unknown> {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    if (body !== undefined && new TextEncoder().encode(body).byteLength > DRIVE_MAX_METADATA_BYTES) throw new AppError("VALIDATION_ERROR", "The iCloud Drive request exceeded its metadata byte budget.");
    const url = this.endpoint(service, path, params);
    const result = await this.transport.metadata(url, { method, ...(body === undefined ? {} : { body }), signal: this.http.signal });
    if (result.status === 401 || result.status === 403 || result.status === 421 || result.status === 450) throw new AppError("REAUTH_REQUIRED", "Apple did not accept iCloud Drive access.", 409);
    if (result.status < 200 || result.status >= 300) throw new AppError("UPSTREAM_UNAVAILABLE", "Apple rejected the iCloud Drive request.", 502, false);
    return parseJSON(result.bytes);
  }

  private async details(id: string, shareContext?: string): Promise<Record<string, unknown>> {
    validateItemId(id);
    const shared = await this.shared(shareContext);
    if (id.includes("_IN_SHARED_FOLDER::") && !shared) throw new AppError("VALIDATION_ERROR", "Pass the shareContext returned with this shared Drive item.", 400);
    // Files use Apple's exact-item lookup; the folder endpoint rejects file IDs.
    const fileLookup = id.startsWith("FILE::") || id.startsWith("FILE_IN_SHARED_FOLDER::");
    const entry = { drivewsid: id, partialData: false, ...(fileLookup ? { includeHierarchy: false } : {}), ...(shared ? { shareID: shared.shareID } : {}) };
    const result = await this.request("drive", fileLookup ? "/retrieveItemDetails" : "/retrieveItemDetailsInFolders", "POST", fileLookup ? { items: [entry] } : [entry]);
    const entries = fileLookup && isRecord(result) ? result.items : result;
    if (fileLookup && isRecord(result)) checkStatus(result);
    if (!Array.isArray(entries) || entries.length !== 1 || !isRecord(entries[0])) return protocol("Apple returned an unsupported iCloud Drive lookup response.");
    checkStatus(entries[0]);
    if (entries[0].drivewsid !== id) return protocol("Apple returned a different iCloud Drive item than the requested identity.");
    return entries[0];
  }

  async getItem(id: string, shareContext?: string): Promise<DriveItem> {
    const raw = await this.details(id, shareContext);
    return item(raw, null, await this.contextFor(raw, shareContext));
  }

  async listItems(folderId: string, shareContext?: string): Promise<DriveListing> {
    if (folderId !== ROOT_ID) validateItemId(folderId);
    const raw = await this.details(folderId, shareContext);
    const folder = item(raw, null, await this.contextFor(raw, shareContext));
    if (folder.type !== "folder") throw new AppError("VALIDATION_ERROR", "The selected iCloud Drive item is not a folder.");
    if (!Array.isArray(raw.items)) return protocol("Apple did not return the folder contents in the supported response shape.");
    // `numberOfItems` includes descendants (the pinned root fixture has 3 direct
    // children and 5 items total). Only directChildrenCount can prove this page.
    const countValue = raw.directChildrenCount;
    const expectedCount = typeof countValue === "number" && Number.isSafeInteger(countValue) && countValue >= 0 ? countValue : null;
    const bounded = raw.items.slice(0, MAX_ITEMS);
    let excludedShared = 0, excludedAppLibrary = 0, excludedOtherZone = 0;
    const items: DriveItem[] = [];
    for (const child of bounded) {
      if (!isRecord(child)) return protocol("Apple returned an invalid iCloud Drive child item.");
      checkStatus(child);
      // Apple's root fixture contains app libraries in other zones. They are
      // outside the ordinary CloudDocs namespace and must not be normalized as
      // regular folders. Return visible owned children and disclose the omission.
      // Count each excluded entry once, prioritising shared over app/zone.
      const descriptor = child.shareID ?? child.shareId;
      if (descriptor !== undefined && !DriveShareID.safeParse(descriptor).success || descriptor === undefined && !folder.shareContext && (child.share !== undefined || String(child.drivewsid).includes("_IN_SHARED_FOLDER::"))) { excludedShared++; continue; }
      const kind = typeof child.type === "string" ? child.type.toUpperCase() : "";
      if (kind === "APP_LIBRARY" || kind === "APP_CONTAINER") { excludedAppLibrary++; continue; }
      if (child.zone !== ZONE) { excludedOtherZone++; continue; }
      items.push(item(child, folder.id, await this.contextFor(child, folder.shareContext)));
    }
    const reasons: z.infer<typeof DriveListingReason>[] = [];
    if (expectedCount === null) reasons.push("missing_direct_children_count");
    else if (raw.items.length !== expectedCount) reasons.push("upstream_count_mismatch");
    if (raw.items.length > MAX_ITEMS) reasons.push("item_limit");
    if (excludedShared) reasons.push("excluded_shared_entries");
    if (excludedAppLibrary) reasons.push("excluded_app_library_entries");
    if (excludedOtherZone) reasons.push("excluded_other_zone_entries");
    return { folder, items, complete: reasons.length === 0, reasons, counts: {
      expected: expectedCount, received: raw.items.length, processed: bounded.length, returned: items.length,
      excluded: excludedShared + excludedAppLibrary + excludedOtherZone, excludedShared, excludedAppLibrary, excludedOtherZone,
      unprocessed: raw.items.length - bounded.length,
    } };
  }

  async prepareDownload(selected: DriveItem): Promise<{ url: string }> {
    const itemValue = DriveItemSchema.parse(selected);
    validateItemId(itemValue.id);
    if (itemValue.type !== "file" || itemValue.size === null) throw new AppError("UNSUPPORTED_FEATURE", "Only ordinary iCloud Drive files can be downloaded.");
    if (itemValue.size > DRIVE_MAX_TRANSFER_BYTES) throw new AppError("UNSUPPORTED_FEATURE", `The iCloud Drive file exceeds the ${DRIVE_FILE_LIMIT_LABEL} transfer limit.`);
    const params = new URLSearchParams(this.params);
    params.set("document_id", itemValue.documentId);
    const shared = await this.shared(itemValue.shareContext);
    if (itemValue.id.includes("_IN_SHARED_FOLDER::") && !shared?.ownerRecordName) throw new AppError("UNSUPPORTED_FEATURE", "Apple did not identify the shared file's owner for a scoped download.", 409);
    const ownerPath = shared?.ownerRecordName ? `/${shared.ownerRecordName}` : "";
    const result = await this.request("documents", `/ws/${ZONE}/download/by_id${ownerPath}`, "GET", undefined, params);
    if (!isRecord(result)) return protocol("Apple returned an unsupported iCloud Drive download response.");
    checkStatus(result);
    if (result.document_id !== undefined && result.document_id !== itemValue.documentId) return protocol("Apple returned a download token for a different document identity.");
    const token = result.data_token;
    if (isRecord(token) && typeof token.url === "string") {
      driveContentURL(token.url, "download");
      return { url: token.url };
    }
    if (result.package_token !== undefined) throw new AppError("UNSUPPORTED_FEATURE", "iCloud Drive package downloads are not supported.");
    return protocol("Apple returned no supported iCloud Drive data download address.");
  }

  async download(selected: DriveItem, signal?: AbortSignal): Promise<Response> {
    const checked = DriveItemSchema.parse(selected);
    if (checked.type === "file" && checked.size === 0) return new Response(null, { status: 200 });
    const prepared = await this.prepareDownload(selected);
    return this.transport.download(prepared.url, signal ?? this.http.signal);
  }

  async allocateUpload(input: { name: string; size: number; contentType: string }): Promise<{ documentId: string; url: string }> {
    validName(input.name);
    if (!Number.isSafeInteger(input.size) || input.size < 0 || input.size > DRIVE_MAX_TRANSFER_BYTES) throw new AppError("VALIDATION_ERROR", `The upload size is outside the supported ${DRIVE_FILE_LIMIT_LABEL} limit.`);
    this.validateUploadContentType(input.contentType);
    const cookieHeader = this.http.jar.header(this.endpoint("documents", `/ws/${ZONE}/upload/web`));
    const cookie = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith("X-APPLE-WEBAUTH-VALIDATE="));
    const token = cookie && /\bt=([^:;]+)/.exec(cookie.slice(cookie.indexOf("=") + 1))?.[1];
    if (!token) throw new AppError("REAUTH_REQUIRED", "The Apple Drive validation cookie is missing.", 409);
    const params = new URLSearchParams(this.params);
    params.set("token", token);
    const response = await this.request("documents", `/ws/${ZONE}/upload/web`, "POST", { filename: input.name, type: "FILE", content_type: input.contentType, size: input.size }, params);
    if (!Array.isArray(response) || response.length !== 1 || !isRecord(response[0])) return protocol("Apple returned an unsupported iCloud Drive upload allocation.");
    checkStatus(response[0]);
    if (!opaqueDocumentId(response[0].document_id) || typeof response[0].url !== "string") return protocol("Apple returned invalid iCloud Drive upload allocation metadata.");
    const allocation = DriveUploadAllocationSchema.parse({ documentId: response[0].document_id, url: response[0].url });
    this.restoreUploadAllocation(allocation, input);
    return allocation;
  }

  /** Restore a decrypted, service-persisted allocation before resuming its byte transfer. */
  restoreUploadAllocation(allocation: DriveUploadAllocation, options: { name: string; size: number; contentType: string }): void {
    const parsed = DriveUploadAllocationSchema.safeParse(allocation);
    if (!parsed.success || !opaqueDocumentId(parsed.data.documentId)) throw new AppError("VALIDATION_ERROR", "The upload allocation is invalid.");
    validName(options.name);
    if (!Number.isSafeInteger(options.size) || options.size < 0 || options.size > DRIVE_MAX_TRANSFER_BYTES) throw new AppError("VALIDATION_ERROR", "The upload size is outside the supported byte budget.");
    this.validateUploadContentType(options.contentType);
    driveContentURL(parsed.data.url, "upload", this.dsid);
    this.uploadAllocations.set(parsed.data.documentId, { url: parsed.data.url, name: options.name, size: options.size, contentType: options.contentType });
  }

  async uploadBytes(allocation: DriveUploadAllocation, body: ReadableStream<Uint8Array>, options: { name: string; size: number; signal?: AbortSignal }): Promise<UploadReceipt> {
    validName(options.name);
    const parsedAllocation = DriveUploadAllocationSchema.safeParse(allocation);
    if (!parsedAllocation.success || !opaqueDocumentId(parsedAllocation.data.documentId)) throw new AppError("VALIDATION_ERROR", "The upload allocation is invalid.");
    if (!Number.isSafeInteger(options.size) || options.size < 0 || options.size > DRIVE_MAX_TRANSFER_BYTES) throw new AppError("VALIDATION_ERROR", "The upload size is outside the supported byte budget.");
    driveContentURL(parsedAllocation.data.url, "upload", this.dsid);
    const retained = this.uploadAllocations.get(parsedAllocation.data.documentId);
    if (!retained || retained.url !== parsedAllocation.data.url || retained.name !== options.name || retained.size !== options.size) throw new AppError("VALIDATION_ERROR", "The upload allocation does not match this Drive client or its declared transfer.");
    const bytes = await this.transport.upload(parsedAllocation.data.url, this.dsid, body, options.size, options.name, retained.contentType, options.signal ?? this.http.signal);
    const parsed = parseJSON(bytes);
    if (!isRecord(parsed) || !isRecord(parsed.singleFile)) return protocol("Apple returned an unsupported iCloud Drive upload receipt.");
    const value = parsed.singleFile;
    if (!text(value.referenceChecksum, 8192) || !text(value.fileChecksum, 8192) || !text(value.wrappingKey, 8192) || value.size !== options.size || (value.receipt !== undefined && !text(value.receipt, 8192))) return protocol("Apple returned invalid iCloud Drive upload receipt metadata.");
    this.uploadAllocations.delete(parsedAllocation.data.documentId);
    return { referenceChecksum: value.referenceChecksum, fileChecksum: value.fileChecksum, wrappingKey: value.wrappingKey, size: value.size, ...(typeof value.receipt === "string" ? { receipt: value.receipt } : {}) };
  }

  private validateUploadContentType(contentType: string): void {
    if (!text(contentType, 255) || !/^[\w.+-]+\/[\w.+-]+$/.test(contentType)) throw new AppError("VALIDATION_ERROR", "The upload content type is invalid.");
  }

  async finalizeUpload(input: { parent: DriveItem; name: string; documentId: string; receipt: UploadReceipt; mtime?: number }): Promise<DriveItem> {
    const parent = DriveItemSchema.parse(input.parent);
    requireOwned(parent);
    if (parent.type !== "folder") throw new AppError("VALIDATION_ERROR", "Uploads require an owned destination folder.");
    validateItemId(parent.id);
    validName(input.name);
    if (!opaqueDocumentId(input.documentId)) throw new AppError("VALIDATION_ERROR", "The upload document identifier is invalid.");
    if (!UploadReceiptSchema.safeParse(input.receipt).success) throw new AppError("VALIDATION_ERROR", "The private upload receipt is invalid.");
    const mtime = input.mtime ?? Date.now();
    if (!Number.isSafeInteger(mtime) || mtime < 0) throw new AppError("VALIDATION_ERROR", "The upload modification time is invalid.");
    const data: Record<string, unknown> = { signature: input.receipt.fileChecksum, wrapping_key: input.receipt.wrappingKey, reference_signature: input.receipt.referenceChecksum, size: input.receipt.size, ...(input.receipt.receipt ? { receipt: input.receipt.receipt } : {}) };
    // Both pyicloud e2e44ab875d47dab4475096021da60030f26c35e and rclone
    // 4f19e9cd6f442282d7fa8d5fdbd28ebb68be1131 serialize true. Neither source
    // documents collision semantics, so this is wire compatibility, not a claim
    // that the server guarantees duplicate preservation or prevents replacement.
    const payload = { data, command: "add_file", create_short_guid: true, document_id: input.documentId, path: { starting_document_id: parent.documentId, path: input.name }, allow_conflict: true, file_flags: { is_writable: true, is_executable: false, is_hidden: false }, mtime, btime: mtime };
    return this.finalizeResult(await this.mutate("/ws/com.apple.CloudDocs/update/documents", payload), parent, input.name, input.documentId, mtime);
  }

  async createFolder(parentId: string, name: string, clientId: string): Promise<DriveItem | { id: string }> {
    validateItemId(parentId);
    if (!ownedId(parentId, ["FOLDER"])) throw new AppError("UNSUPPORTED_FEATURE", "Shared Drive folder creation is not supported.", 409);
    if (!parentId.startsWith("FOLDER::")) throw new AppError("VALIDATION_ERROR", "The iCloud Drive folder parent must be a folder.");
    validName(name);
    if (!text(clientId, 128) || /[^A-Za-z0-9._-]/.test(clientId)) throw new AppError("VALIDATION_ERROR", "The folder creation client identifier is invalid.");
    const response = await this.mutate("/createFolders", { destinationDrivewsId: parentId, folders: [{ clientId: `FOLDER::UNKNOWN_ZONE::TempId-${clientId}`, name }] });
    return this.mutationIdentity(response);
  }

  async renameItem(selected: DriveItem, name: string): Promise<DriveItem> {
    const current = DriveItemSchema.parse(selected);
    requireOwned(current);
    validateItemId(current.id);
    if (current.id === ROOT_ID) throw new AppError("VALIDATION_ERROR", "The iCloud Drive root cannot be renamed.");
    validName(name);
    return this.exactMutationResult(await this.mutate("/renameItems", { items: [{ drivewsid: current.id, etag: current.etag, name }] }), current.id);
  }

  async moveItem(selected: DriveItem, destination: DriveItem): Promise<DriveItem> {
    const current = DriveItemSchema.parse(selected);
    const parent = DriveItemSchema.parse(destination);
    requireOwned(current); requireOwned(parent);
    validateItemId(current.id);
    validateItemId(parent.id);
    if (current.id === ROOT_ID) throw new AppError("VALIDATION_ERROR", "The iCloud Drive root cannot be moved.");
    if (parent.type !== "folder") throw new AppError("VALIDATION_ERROR", "The move destination must be a folder.");
    if (current.id === parent.id) throw new AppError("VALIDATION_ERROR", "An iCloud Drive item cannot be moved into itself.");
    return this.exactMutationResult(await this.mutate("/moveItems", { destinationDrivewsId: parent.id, items: [{ drivewsid: current.id, etag: current.etag, clientId: current.id }] }), current.id);
  }

  private async mutate(path: string, payload: unknown): Promise<unknown> {
    try {
      const response = await this.request(path.includes("/ws/") ? "documents" : "drive", path, "POST", payload);
      if (isRecord(response) && !(path.includes("/update/documents") && isRecord(response.status))) checkStatus(response);
      if (Array.isArray(response)) for (const value of response) if (isRecord(value)) checkStatus(value);
      if (isRecord(response) && Array.isArray(response.folders)) for (const value of response.folders) if (isRecord(value)) checkStatus(value);
      if (isRecord(response) && Array.isArray(response.items)) for (const value of response.items) if (isRecord(value)) checkStatus(value);
      return response;
    } catch (error) {
      if (error instanceof AppError && ["VALIDATION_ERROR", "PROTOCOL_CHANGED", "REAUTH_REQUIRED", "CONFLICT", "FORBIDDEN"].includes(error.code)) throw error;
      throw new AppError("WRITE_OUTCOME_UNKNOWN", "Apple may have accepted this iCloud Drive change, but its result could not be confirmed. Read the item before trying again.", 503, false);
    }
  }

  private mutationIdentity(response: unknown): DriveItem | { id: string } {
    const entries = Array.isArray(response) ? response : isRecord(response) && Array.isArray(response.folders) ? response.folders : null;
    if (!entries || entries.length !== 1 || !isRecord(entries[0])) throw new AppError("WRITE_OUTCOME_UNKNOWN", "Apple may have created the iCloud Drive folder, but returned no exact identity. Read the parent folder before trying again.", 503, false);
    checkStatus(entries[0]);
    const raw = entries[0];
    if (raw.drivewsid && raw.docwsid && raw.zone && raw.type && raw.etag && raw.name) return item(raw);
    if (ownedId(raw.drivewsid, ["FOLDER"])) return { id: raw.drivewsid };
    throw new AppError("WRITE_OUTCOME_UNKNOWN", "Apple may have created the iCloud Drive folder, but returned no exact identity. Read the parent folder before trying again.", 503, false);
  }

  private exactMutationResult(response: unknown, expectedId: string): DriveItem {
    const candidates = Array.isArray(response) ? response : isRecord(response) && Array.isArray(response.items) ? response.items : isRecord(response) ? [response] : [];
    const candidate = candidates.find((value) => isRecord(value) && value.drivewsid !== undefined);
    if (!candidate || !isRecord(candidate) || candidate.drivewsid !== expectedId) throw new AppError("WRITE_OUTCOME_UNKNOWN", "Apple accepted the iCloud Drive change but returned no matching item identity. Read the item before trying again.", 503, false);
    return item(candidate);
  }

  private finalizeResult(response: unknown, parent: DriveItem, name: string, documentId: string, mtime: number): DriveItem {
    if (!isRecord(response) || !isRecord(response.status) || !Number.isSafeInteger(response.status.status_code) || !Array.isArray(response.results) || response.results.length !== 1 || !isRecord(response.results[0])) {
      throw new AppError("WRITE_OUTCOME_UNKNOWN", "Apple may have accepted the iCloud Drive upload, but returned no supported commit result. Read the destination before trying again.", 503, false);
    }
    if (response.status.status_code !== 0) throw new AppError("CONFLICT", "Apple rejected the iCloud Drive upload commit.", 409);
    const result = response.results[0];
    if (!isRecord(result.status) || result.status.status_code !== 0 || !isRecord(result.document)) throw new AppError("WRITE_OUTCOME_UNKNOWN", "Apple may have accepted the iCloud Drive upload, but returned no exact document identity. Read the destination before trying again.", 503, false);
    const doc = result.document;
    const size = typeof doc.size === "number" ? doc.size : typeof doc.size === "string" && /^\d+$/.test(doc.size) ? Number(doc.size) : NaN;
    const parentMatches = doc.parent_id === parent.documentId || doc.parent_id === parent.id;
    if (doc.document_id !== documentId || doc.zone !== ZONE || !parentMatches || doc.name !== name || !text(doc.etag, 512) || !Number.isSafeInteger(size) || size < 0) {
      throw new AppError("WRITE_OUTCOME_UNKNOWN", "Apple returned an iCloud Drive upload result that did not match the requested document identity, name, parent, or size.", 503, false);
    }
    return item({ drivewsid: `FILE::${ZONE}::${documentId}`, docwsid: documentId, zone: ZONE, name, type: doc.type, etag: doc.etag, size, parentId: parent.id, dateModified: mtime });
  }
}
