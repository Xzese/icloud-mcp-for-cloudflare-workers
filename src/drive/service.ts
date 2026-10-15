import { uploadDriveSocket } from "../transport/drive-upload-socket.ts";
import { z } from "zod";
import { DRIVE_FILE_LIMIT_LABEL, DRIVE_DIRECT_UPLOAD_BYTES, DRIVE_UPLOAD_PART_BYTES, DRIVE_UPLOAD_MINIMUM_LEASE_MS, DRIVE_TRANSFER_BLOCK_BYTES } from "./limits.ts";
import { DriveStaging } from "./staging.ts";
import { sha256 } from "@noble/hashes/sha2.js";
import { AppError } from "../errors.ts";
import { AppleAuthHTTP } from "../auth/apple/http.ts";
import { requireAppleEnabled } from "../auth/gates.ts";
import { requireDriveConnection, requireServiceReady, sessionServices } from "../auth/apple/services.ts";
import { freshPcsCheckpoint } from "../auth/apple/pcs.ts";
import { AppleSessionRenewal, appleRequestBudget, appleSuccess } from "../auth/apple/session-renewal.ts";
import { AppleSessionRepository, type ResumeFence } from "../persistence/apple-sessions.ts";
import { ServiceSettingsRepository } from "../persistence/service-settings.ts";
import { requireServicePermission, type ServicePermission } from "../services/settings.ts";
import { DriveOperationRepository, type DriveOperation, type DriveOperationData, type DriveScope } from "../persistence/drive-operations.ts";
import { DriveClient, DRIVE_ROOT, DriveItemSchema, UploadReceiptSchema, type DriveItem } from "../icloud/drive.ts";
import { DriveHTTP, type DriveByteRange } from "../transport/drive-http.ts";
import { DriveSharedContext } from "./shared.ts";
import { resolveDriveFolderPath } from "./folder-path.ts";
import { newTraversal, traversalPage, TraversalState } from "./traversal.ts";
import { DriveFolderListingDiagnostics, type DriveSearchReason } from "./listing.ts";
import { accountScope, fingerprint } from "../lib/canonical.ts";
import { b64, unb64, hex } from "../crypto/bytes.ts";
import type { RuntimeEnv } from "../platform/sites.ts";
import { issueDriveTransfer, type TransferClaim } from "./transfer-capability.ts";
import { ListDrive, GetDriveItem, SearchDrive, TraverseDrive, ResolveDriveFolderPath, ReadDrive, DownloadDrive, UploadDrive, UploadDriveMetadata, CreateDriveFolder, RenameDriveItem, MoveDriveItem, GetDriveOperation, OperationId, INLINE_FILE_BYTES, DRIVE_FILE_BYTES, INLINE_UPLOAD_GUIDANCE } from "./schemas.ts";

type Saved = Awaited<ReturnType<AppleSessionRepository["load"]>>;
type Upload = z.infer<typeof UploadDriveMetadata>;
interface Context { scope: DriveScope; permission: ServicePermission; saved: Saved; fence: ResumeFence; http: AppleAuthHTTP; client: DriveClient; access: { rejected: boolean }; }
const Allocation = z.object({ documentId: z.string().min(1).max(256), url: z.string().url() }).strict();
const SearchFolder = z.object({ id: z.string(), shareContext: z.string().uuid().optional() }).strict();
const folderKey = (folder: { id: string; shareContext?: string }) => folder.shareContext ? `${folder.id}|${folder.shareContext}` : folder.id;
const SearchState = z.object({ root: z.string(), rootContext: z.string().uuid().optional(), query: z.string(), queue: z.array(z.union([z.string().transform((id): z.infer<typeof SearchFolder> => ({ id })), SearchFolder])).max(1000), seen: z.array(z.string()).max(1000), pending: z.array(DriveItemSchema).max(1000), visited: z.number().int().min(0).max(1000), incomplete: z.boolean(), incompleteFolders: z.array(DriveFolderListingDiagnostics).max(1000).default([]), budgetExhausted: z.boolean().default(false) }).strict();
function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new AppError("VALIDATION_ERROR", "The Drive request is invalid.", 400);
  return result.data;
}
function unknownOutcome(id: string): AppError { return new AppError("WRITE_OUTCOME_UNKNOWN", `The outcome of Drive operation ${id} is uncertain. Retain this operation ID and inspect it; do not issue a new operation key.`, 503); }
function conflict(message: string): never { throw new AppError("CONFLICT", message, 409); }
function mutable(item: DriveItem) {
  if (item.shareContext || item.id.includes("_IN_SHARED_FOLDER::")) throw new AppError("UNSUPPORTED_FEATURE", "Shared Drive items support browsing and reads only.", 409);
  if (item.id === DRIVE_ROOT || item.documentId === "root") throw new AppError("UNSUPPORTED_FEATURE", "The native Drive root cannot be changed.", 409);
}
function ordinaryFile(item: DriveItem, limit: number) {
  if (item.type !== "file" || item.size === null || item.size > limit) throw new AppError("UNSUPPORTED_FEATURE", `Select an ordinary file within the ${limit} byte content limit.`, 409);
}
function exact(a: DriveItem, b: DriveItem) { return a.id === b.id && a.documentId === b.documentId && a.etag === b.etag && a.type === b.type && a.size === b.size && a.parentId === b.parentId && a.name === b.name && a.shareContext === b.shareContext && a.package === b.package; }

function byteRange(header: string | null, size: number): DriveByteRange | undefined {
  if (header === null) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || !match[1] && !match[2]) throw new AppError("VALIDATION_ERROR", "Use one bytes=start-end or suffix byte range.", 416);
  const first = match[1] ? Number(match[1]) : null, last = match[2] ? Number(match[2]) : null;
  if (first !== null && !Number.isSafeInteger(first) || last !== null && !Number.isSafeInteger(last) || size === 0 || first !== null && (first >= size || last !== null && last < first) || first === null && last === 0) throw new AppError("VALIDATION_ERROR", "The Drive byte range is outside this file.", 416);
  return first === null ? { start: Math.max(0, size - last!), end: size - 1, total: size } : { start: first, end: Math.min(last ?? size - 1, size - 1), total: size };
}

export class DriveService {
  private readonly env: RuntimeEnv;
  private readonly owner: string;
  private readonly sessions: AppleSessionRepository;
  private readonly settings: ServiceSettingsRepository;
  private readonly operations: DriveOperationRepository;
  constructor(env: RuntimeEnv, owner: string) {
    this.env = env;
    this.owner = owner;
    this.operations = new DriveOperationRepository(env, owner);
    this.sessions = new AppleSessionRepository(env, owner);
    this.settings = new ServiceSettingsRepository(env, owner);
  }
  private async permission(permission: ServicePermission) {
    requireAppleEnabled(this.env);
    const settings = await this.settings.load();
    requireServicePermission(settings.settings, permission);
    return settings.revision;
  }
  private async guard(scope: DriveScope, permission: ServicePermission) {
    if (await this.permission(permission) !== scope.permissionRevision) conflict("Drive permissions changed during this request. Start a fresh request.");
    const saved = await this.sessions.load();
    requireServiceReady(saved.session, saved.state, "drive", saved.action);
    const connection = requireDriveConnection(saved.session);
    if (saved.fence.generation !== scope.generation || await accountScope(this.owner, connection.dsid) !== scope.account) conflict("The Apple account changed during this Drive request.");
    if (Date.now() >= scope.expiresAt) throw new AppError("AUTH_EXPIRED", "The Drive request's account session expired.", 409);
    return saved;
  }
  private async open(permission: ServicePermission, expectedGeneration?: number, pinned?: DriveScope): Promise<Context> {
    const revision = await this.permission(permission);
    let saved = await this.sessions.load();
    requireServiceReady(saved.session, saved.state, "drive", saved.action);
    if (expectedGeneration !== undefined && saved.fence.generation !== expectedGeneration) conflict("The Apple account generation changed. Refresh before continuing.");
    if (!pinned) saved = await new AppleSessionRenewal(this.env, this.sessions).ensure(saved.fence.generation, appleRequestBudget());
    requireServiceReady(saved.session, saved.state, "drive", saved.action);
    const connection = requireDriveConnection(saved.session);
    const scope = { account: await accountScope(this.owner, connection.dsid), generation: saved.fence.generation, permissionRevision: revision, expiresAt: Math.min(saved.session.login.expiresAt, pinned?.expiresAt ?? Infinity) };
    if (pinned && (scope.account !== pinned.account || scope.generation !== pinned.generation || scope.permissionRevision !== pinned.permissionRevision)) conflict("The Drive request's settings or account changed.");
    if (scope.expiresAt <= Date.now()) throw new AppError("AUTH_EXPIRED", "This Drive authorization expired.", 410);
    const fence = await this.sessions.claimRenewal(saved.fence.generation, saved.fence.version);
    try {
      saved = await this.sessions.load();
      await this.sessions.assertAccountLease(fence);
      const access = { rejected: false };
      const send: typeof fetch = async (input, init) => {
        await this.guard(scope, permission);
        await this.sessions.assertAccountLease(fence);
        const response = await fetch(input, init);
        if ([401, 403, 421, 423, 450].includes(response.status)) access.rejected = true;
        return response;
      };
      const http = AppleAuthHTTP.restore(saved.session.auth, send);
      return { scope, permission, saved, fence, http, client: new DriveClient(http.http, connection, { save: context => this.operations.saveSharedContext(context, scope), load: async id => parse(DriveSharedContext, await this.operations.loadSharedContext(id, scope)) }), access };
    } catch (error) { await this.sessions.releaseResume(fence); throw error; }
  }
  private async finish(context: Context) {
    await this.guard(context.scope, context.permission);
    await this.sessions.commitResume(context.fence, appleSuccess({ ...context.saved.session, auth: context.http.snapshot() }), context.saved.state, context.saved.action ?? undefined);
    await this.guard(context.scope, context.permission);
  }
  private async close(context: Context, originalError?: unknown) {
    await this.sessions.releaseResume(context.fence);
    if (!context.access.rejected) return;
    try {
      // A metadata access rejection revokes only Drive consent. This local
      // transition never validates tokens, prompts a device, or retries a write.
      const saved = await this.sessions.load();
      if (saved.fence.generation !== context.scope.generation || await accountScope(this.owner, saved.session.connection.dsid) !== context.scope.account) return;
      const services = sessionServices(saved.session, saved.state, saved.action);
      if (services.drive.state !== "READY") return;
      const fence = await this.sessions.claimRenewal(saved.fence.generation, saved.fence.version);
      try {
        await this.sessions.commitResume(fence, {
          ...saved.session,
          auth: saved.fence.version === context.fence.version + 1 ? { ...saved.session.auth, cookies: context.http.snapshot().cookies } : saved.session.auth,
          services: { ...services, drive: { ...services.drive, state: "DEVICE_APPROVAL_PENDING", pcs: freshPcsCheckpoint(), action: "approve-device-consent", lastErrorCode: "DEVICE_APPROVAL_PENDING" } },
        }, saved.state, saved.action ?? undefined);
      } finally { await this.sessions.releaseResume(fence); }
    } catch (error) {
      // An uncertain dispatched write must keep its public recovery contract
      // even if a concurrent account operation prevents the consent checkpoint.
      if (originalError instanceof AppError && originalError.code === "WRITE_OUTCOME_UNKNOWN") throw originalError;
      throw error;
    }
  }
  private async metadata<T>(permission: ServicePermission, generation: number | undefined, run: (context: Context) => Promise<T>, pinned?: DriveScope): Promise<T> {
    const context = await this.open(permission, generation, pinned);
    let failure: unknown;
    try { const result = await run(context); await this.finish(context); return result; }
    catch (error) { failure = error; throw error; }
    finally { await this.close(context, failure); }
  }
  async list(input: unknown) {
    const request = parse(ListDrive, input);
    return this.metadata("drive.browse", request.expectedGeneration, async c => ({ ...await c.client.listItems(request.folderId, request.shareContext), generation: c.scope.generation }));
  }
  async get(input: unknown) {
    const request = parse(GetDriveItem, input);
    return this.metadata("drive.browse", request.expectedGeneration, async c => ({ item: await c.client.getItem(request.itemId, request.shareContext), generation: c.scope.generation }));
  }
  async traverse(input: unknown) {
    const { continuation, expectedGeneration, ...options } = parse(TraverseDrive, input);
    const context = await this.open("drive.browse", expectedGeneration);
    let failure: unknown;
    try {
      const retained = continuation ? await this.operations.loadTraversalHandle(continuation, context.scope) : null;
      const state = retained ? parse(TraversalState, retained.data) : newTraversal(options);
      if (await fingerprint(state.input) !== await fingerprint(options)) conflict("Repeat the same folder, share context, query and limits when continuing a traversal.");
      const page = await traversalPage(context.client, state);
      await this.finish(context);
      await this.operations.retainTraversalShares([
        ...page.result.items.map(item => item.shareContext),
        ...(page.canContinue ? [...page.state.queue.map(folder => folder.shareContext), page.state.pending?.folder.shareContext, ...(page.state.pending?.items.map(item => item.shareContext) ?? [])] : []),
      ], context.scope);
      const next = continuation && retained
        ? await this.operations.advanceTraversalHandle(continuation, retained.envelope, page.canContinue ? page.state : null, context.scope)
        : page.canContinue ? (await this.operations.handle("traversal", page.state, context.scope)).id : null;
      return { ...page.result, continuation: next, generation: context.scope.generation };
    } catch (error) { failure = error; throw error; }
    finally { await this.close(context, failure); }
  }
  async resolveFolderPath(input: unknown) {
    const request = parse(ResolveDriveFolderPath, input);
    return this.metadata("drive.browse", request.expectedGeneration, async c => ({
      ...await resolveDriveFolderPath(c.client, request.folderId, request.path, request.shareContext), generation: c.scope.generation,
    }));
  }
  async search(input: unknown) {
    const request = parse(SearchDrive, input);
    return this.metadata("drive.browse", request.expectedGeneration, async c => {
      const state = request.continuation ? parse(SearchState, await this.operations.consumeHandle(request.continuation, "search", c.scope)) : parse(SearchState, { root: request.folderId, rootContext: request.shareContext, query: request.query, queue: [{ id: request.folderId, shareContext: request.shareContext }], seen: [], pending: [], visited: 0, incomplete: false });
      if (state.root !== request.folderId || state.rootContext !== request.shareContext || state.query !== request.query) conflict("Repeat the original root and query when continuing a Drive search.");
      const matches: DriveItem[] = [];
      let foldersRead = 0;
      while (matches.length < 200) {
        if (state.pending.length) {
          const item = state.pending.shift()!;
          if (item.name.toLocaleLowerCase().includes(request.query.toLocaleLowerCase())) matches.push(item);
          if (item.type === "folder" && !state.seen.includes(folderKey(item)) && !state.queue.some(folder => folderKey(folder) === folderKey(item))) {
            if (state.queue.length + state.seen.length < 1000) state.queue.push({ id: item.id, shareContext: item.shareContext });
            else state.budgetExhausted = true;
          }
          continue;
        }
        if (!state.queue.length || foldersRead >= 3 || state.visited >= 1000) break;
        const folder = state.queue.shift()!;
        const key = folderKey(folder);
        if (state.seen.includes(key)) continue;
        state.seen.push(key);
        const page = await c.client.listItems(folder.id, folder.shareContext);
        foldersRead++;
        const available = 1000 - state.visited;
        state.pending = page.items.slice(0, available);
        state.visited += state.pending.length;
        state.incomplete ||= !page.complete;
        if (!page.complete) state.incompleteFolders.push({ folderId: page.folder.id, shareContext: page.folder.shareContext, complete: page.complete, reasons: page.reasons, counts: page.counts });
        state.budgetExhausted ||= page.items.length > available;
      }
      const canContinue = state.pending.length > 0 || state.queue.length > 0 && state.visited < 1000;
      const continuation = canContinue ? (await this.operations.handle("search", state, c.scope)).id : null;
      const reasons = new Set<z.infer<typeof DriveSearchReason>>(state.incompleteFolders.flatMap(folder => folder.reasons));
      // Older ten-minute handles may predate per-folder diagnostics.
      if (state.incomplete && !state.incompleteFolders.length) reasons.add("listing_details_unavailable");
      if (canContinue) reasons.add("continuation_required");
      if (state.budgetExhausted || state.queue.length > 0 && state.visited >= 1000) reasons.add("search_item_limit");
      return { items: matches, complete: reasons.size === 0, reasons: [...reasons], incompleteFolders: state.incompleteFolders, continuation, scope: "selected-folder-tree", consistency: "live-pages-not-snapshot", foldersRead, visited: state.visited, generation: c.scope.generation };
    });
  }
  private async transferClient(scope: DriveScope, permission: ServicePermission, auth: Saved["session"]["auth"]) {
    const send: typeof fetch = async (input, init) => {
      await this.guard(scope, permission);
      if (permission === "drive.upload" && this.env.DRIVE_UPLOAD_TRANSPORT !== "fetch" && init?.method === "POST" && Number(new Headers(init.headers).get("content-length")) > 64 * 1024 ** 2) {
        return uploadDriveSocket(new URL(String(input)), init);
      }
      return fetch(input, init);
    };
    return AppleAuthHTTP.restore(auth, send);
  }
  private checkedStream(source: ReadableStream<Uint8Array>, scope: DriveScope, permission: ServicePermission, size: number | null, signal?: AbortSignal, hash?: string, blockBytes = DRIVE_TRANSFER_BLOCK_BYTES) {
    type BulkReader = { readAtLeast(min: number, view: Uint8Array): Promise<ReadableStreamReadResult<Uint8Array>>; cancel(reason?: unknown): Promise<void>; releaseLock(): void };
    let bulkReader: BulkReader | undefined;
    try {
      const candidate = source.getReader({ mode: "byob" }) as unknown as BulkReader;
      if (typeof candidate.readAtLeast === "function") bulkReader = candidate;
      else candidate.releaseLock();
    } catch { /* Portable JS streams retain the zero-copy fragment path. */ }
    const reader = bulkReader ?? source.getReader();
    // Native streaming SHA-256 avoids spending the hosted Worker's CPU budget
    // hashing gigabytes in JavaScript. Neither path retains the complete file.
    const NativeDigest = (crypto as Crypto & { DigestStream?: typeof DigestStream }).DigestStream;
    const nativeDigest = hash !== undefined && NativeDigest ? new NativeDigest("SHA-256") : undefined;
    const digestWriter = nativeDigest?.getWriter();
    void nativeDigest?.digest.catch(() => {});
    const digest = hash !== undefined && !nativeDigest ? sha256.create() : undefined;
    const finishDigest = async () => {
      if (nativeDigest && digestWriter) {
        await digestWriter.close();
        digestWriter.releaseLock();
        return hex(new Uint8Array(await nativeDigest.digest));
      }
      return digest ? hex(digest.digest()) : undefined;
    };
    const cancelDigest = async (reason?: unknown) => { await digestWriter?.abort(reason).catch(() => {}); };
    console.info({ event: "drive-transfer-reader", bulk: !!bulkReader, nativeHash: !!nativeDigest, hashing: hash !== undefined });
    let count = 0;
    let saved: Saved | undefined, pending: Uint8Array | undefined, ended = false;
    const guard = async () => {
      if (Date.now() >= scope.expiresAt) throw new AppError("AUTH_EXPIRED", "The Drive request's account session expired.", 409);
      for (let attempt = 0; attempt < 3; attempt++) {
        saved ??= await this.guard(scope, permission);
        if (await this.sessions.driveTransferCurrent(saved.fence, scope.permissionRevision)) {
          if (Date.now() >= scope.expiresAt) throw new AppError("AUTH_EXPIRED", "The Drive request's account session expired.", 409);
          return;
        }
        saved = undefined;
      }
      conflict("The Apple session is busy updating. Resume this Drive request after inspecting its operation.");
    };
    let verified = false;
    const checkActive = () => {
      if (signal?.aborted) throw signal.reason ?? new AppError("CONFLICT", "The Drive transfer was cancelled.", 409);
      if (Date.now() >= scope.expiresAt) throw new AppError("AUTH_EXPIRED", "The Drive authorization expired during transfer.", 409);
    };
    let authorizedThrough = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          checkActive();
          while (!pending?.byteLength && !ended) {
            const capacity = Math.min(blockBytes, size === null ? blockBytes : Math.max(1, size - count));
            const next = bulkReader
              ? await bulkReader.readAtLeast(capacity, new Uint8Array(capacity))
              : await (reader as ReadableStreamDefaultReader<Uint8Array>).read();
            if (next.value?.byteLength) pending = next.value;
            else if (next.done) ended = true;
          }
          checkActive();
          if (ended) {
            await guard();
            if (size !== null && count !== size || hash !== undefined && await finishDigest() !== hash) throw new AppError("VALIDATION_ERROR", "The Drive content length or SHA-256 digest did not match its metadata.", 400);
            checkActive();
            verified = true; reader.releaseLock(); controller.close(); return;
          }
          // Authorize byte windows without copying network chunks into large
          // aggregate buffers. Those copies consumed the hosted CPU budget on
          // both uploads and downloads. A slice never crosses a guard window.
          if (count >= authorizedThrough) {
            await guard();
            authorizedThrough = count + blockBytes;
          }
          const take = Math.min(pending!.byteLength, authorizedThrough - count);
          const block = pending!.subarray(0, take);
          pending = pending!.subarray(take);
          count += take;
          if (size !== null && count > size || count > DRIVE_FILE_BYTES) throw new AppError("VALIDATION_ERROR", "The Drive content exceeded its declared size.", 400);
          if (digestWriter) await digestWriter.write(block);
          else digest?.update(block);
          checkActive();
          controller.enqueue(block);
        } catch (error) { await cancelDigest(error); await reader.cancel(error).catch(() => {}); controller.error(error); }
      },
      async cancel(reason) { await cancelDigest(reason); await reader.cancel(reason).catch(() => {}); },
    }, { highWaterMark: 0 });
    return { stream, verified: () => verified, cancel: async (reason?: unknown) => { await cancelDigest(reason); await reader.cancel(reason).catch(() => {}); } };
  }
  private async content(item: DriveItem, c: Context, signal?: AbortSignal, range?: DriveByteRange, inline = false) {
    ordinaryFile(item, DRIVE_FILE_BYTES);
    const prepared = item.size === 0 && !item.package ? null : await c.client.prepareDownload(item);
    const packaged = item.package || prepared?.package;
    if (packaged && (inline || range)) throw new AppError("UNSUPPORTED_FEATURE", "Download this iCloud package as a complete archive. Text reads and byte ranges are unavailable for packages.", 409);
    await this.finish(c);
    const http = await this.transferClient(c.scope, "drive.contents", c.http.snapshot());
    await this.guard(c.scope, "drive.contents");
    const response = prepared ? await new DriveHTTP(http.http).download(prepared.url, signal, range, packaged ? undefined : item.size!) : new Response(new Uint8Array());
    try { await this.guard(c.scope, "drive.contents"); }
    catch (error) { await response.body?.cancel(error).catch(() => {}); throw error; }
    const source = response.body ?? new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
    const size = range ? range.end - range.start + 1 : item.size!;
    const checked = this.checkedStream(source, c.scope, "drive.contents", packaged ? null : size, signal, undefined, inline ? 4096 : DRIVE_TRANSFER_BLOCK_BYTES);
    const headers = new Headers({ "Content-Type": response.headers.get("content-type") ?? "application/octet-stream", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
    if (!packaged) { headers.set("Content-Length", String(size)); headers.set("Accept-Ranges", "bytes"); }
    if (range) headers.set("Content-Range", `bytes ${range.start}-${range.end}/${item.size}`);
    const encodedName = encodeURIComponent(new TextDecoder().decode(new TextEncoder().encode(packaged ? `${item.name}.zip` : item.name))).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    headers.set("Content-Disposition", `attachment; filename="download"; filename*=UTF-8''${encodedName}`);
    // workerd derives Content-Length from the body, ignoring the header on an
    // arbitrary JS stream. Preserve exact framing without buffering the file.
    let body = checked.stream;
    if (!packaged && typeof FixedLengthStream === "function") {
      const fixed = new FixedLengthStream(size);
      void body.pipeTo(fixed.writable).catch(() => {});
      body = fixed.readable;
    }
    // Never forward CDN headers, signed addresses, or Apple receipt fields.
    return new Response(body, { status: range ? 206 : 200, headers });
  }
  async read(input: unknown) {
    const request = parse(ReadDrive, input);
    if (request.previewBytes !== undefined && request.encoding !== "utf8") throw new AppError("VALIDATION_ERROR", "Text previews require UTF-8 encoding. Use an authenticated download for binary files.", 400);
    const c = await this.open("drive.contents", request.expectedGeneration);
    try {
      const item = await c.client.getItem(request.itemId, request.shareContext);
      ordinaryFile(item, DRIVE_FILE_BYTES);
      if (item.package) throw new AppError("UNSUPPORTED_FEATURE", "Use an authenticated download for iCloud package archives.", 409);
      if (request.previewBytes === undefined && item.size! > INLINE_FILE_BYTES) throw new AppError("UNSUPPORTED_FEATURE", `This file exceeds the 64 KiB inline read limit. Request a UTF-8 preview with previewBytes (up to 8192), or use download_icloud_drive_file / dashboard Download for full contents up to ${DRIVE_FILE_LIMIT_LABEL}.`, 409);
      const response = await this.content(item, c, undefined, undefined, true);
      let bytes: Uint8Array;
      if (request.previewBytes === undefined) bytes = new Uint8Array(await response.arrayBuffer());
      else {
        const reader = response.body!.getReader(), chunks: Uint8Array[] = [];
        let count = 0;
        try {
          while (count < Math.min(request.previewBytes, item.size!)) {
            const next = await reader.read();
            if (next.done) break;
            const prefix = next.value.subarray(0, request.previewBytes - count);
            chunks.push(prefix); count += prefix.byteLength;
          }
          // A preview deliberately cancels the remainder; it never claims that
          // the unread suffix or full content length has been verified.
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        bytes = new Uint8Array(count);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      }
      await this.guard(c.scope, "drive.contents");
      const truncated = bytes.length < item.size!;
      let content: string;
      try { content = request.encoding === "base64" ? b64(bytes) : new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: truncated }); }
      catch { throw new AppError("UNSUPPORTED_FEATURE", "This content is not valid UTF-8 text. Use an authenticated download, or a base64 full read for files up to 64 KiB.", 409); }
      return { item, encoding: request.encoding, content, bytesRead: bytes.length, truncated, generation: c.scope.generation };
    } finally { await this.close(c); }
  }
  async downloadTransfer(input: unknown) {
    const prepared = await this.download(input, true);
    return { ...prepared, url: prepared.transfer!.url };
  }
  async download(input: unknown, delegated = false) {
    const request = parse(DownloadDrive, input);
    return this.metadata("drive.contents", request.expectedGeneration, async c => {
      const item = await c.client.getItem(request.itemId, request.shareContext);
      ordinaryFile(item, DRIVE_FILE_BYTES);
      const handle = await this.operations.handle("download", { item }, c.scope);
      return { handleId: handle.id, url: `/api/drive/downloads/${handle.id}`, expiresAt: handle.expiresAt, item, generation: c.scope.generation,
        ...(delegated ? { transfer: await issueDriveTransfer(this.env, this.owner, "download", handle.id, await fingerprint(item), { ...c.scope, expiresAt: handle.expiresAt }, { size: item.package ? null : item.size! }) } : {}) };
    });
  }
  async downloadContent(handleId: string, signal?: AbortSignal, rangeHeader: string | null = null, claim?: TransferClaim): Promise<Response> {
    parse(z.string().uuid(), handleId);
    if (claim && (claim.kind !== "download" || claim.id !== handleId || claim.owner !== this.owner)) conflict("This capability belongs to another download.");
    const c = await this.open("drive.contents", claim?.scope.generation, claim?.scope);
    try {
      const saved = parse(z.object({ item: DriveItemSchema }).strict(), await this.operations.consumeHandle(handleId, "download", c.scope));
      if (claim && await fingerprint(saved.item) !== claim.inputHash) conflict("This capability belongs to another file version.");
      const current = await c.client.getItem(saved.item.id, saved.item.shareContext);
      if (!exact(current, saved.item)) conflict("The Drive file changed after its download handle was created. Request a fresh download.");
      return await this.content(current, c, signal, byteRange(rangeHeader, current.size!));
    } finally { await this.close(c); }
  }
  private async destination(c: Context, parentId: string, name: string, excludedId?: string) {
    const listing = await c.client.listItems(parentId);
    if (listing.folder.shareContext) throw new AppError("UNSUPPORTED_FEATURE", "Shared Drive destinations support browsing and reads only.", 409);
    if (!listing.complete) throw new AppError("UNSUPPORTED_FEATURE", "The destination listing is incomplete; absence of a filename collision cannot be proved.", 409);
    if (listing.items.some(item => item.id !== excludedId && item.name.normalize("NFC").toLocaleLowerCase() === name.normalize("NFC").toLocaleLowerCase())) conflict("The destination already contains that filename. Drive writes never overwrite existing files.");
    return listing.folder;
  }
  private publicOperation(row: DriveOperation, data: DriveOperationData) {
    const safe = DriveItemSchema.safeParse(data.result);
    return { operationId: row.operation_id, phase: row.phase, result: safe.success ? { item: safe.data } : null, generation: row.generation,
      ...(data.staging ? { staging: { partBytes: DRIVE_UPLOAD_PART_BYTES, uploadedParts: data.staging.parts.map(part => part.partNumber).sort((a, b) => a - b), staged: !!data.staging.objectEtag, cancelled: data.staging.cancelled, expiresAt: row.expires_at } } : {}) };
  }
  private async recover(c: Context, row: DriveOperation, data: DriveOperationData): Promise<DriveOperation> {
    // A lost response is never permission to send another mutation. Only a
    // durably witnessed exact identity AND post-write etag can confirm recovery.
    const witnessed = DriveItemSchema.safeParse(data.receipt);
    if (witnessed.success && data.itemId === witnessed.data.id) {
      const current = await c.client.getItem(witnessed.data.id);
      if (exact(current, witnessed.data)) return this.operations.checkpoint(row, "confirmed", { ...data, result: current });
    }
    if (row.phase !== "unknown") row = await this.operations.checkpoint(row, "unknown", data);
    return row;
  }
  private async dispatch(c: Context, row: DriveOperation, data: DriveOperationData, write: () => Promise<unknown>, expected: (item: DriveItem) => boolean) {
    let current = row;
    await this.guard(c.scope, c.permission);
    await this.sessions.assertAccountLease(c.fence);
    await this.operations.assertLease(current);
    current = await this.operations.checkpoint(current, "committing", data);
    try {
      // The second check closes settings/lease races during intent encryption.
      await this.guard(c.scope, c.permission);
      await this.sessions.assertAccountLease(c.fence);
      await this.operations.assertLease(current);
      const response = await write();
      let item: DriveItem;
      const normalized = DriveItemSchema.safeParse(response);
      if (normalized.success) item = normalized.data;
      else {
        const identity = parse(z.object({ id: DriveItemSchema.shape.id }).strict(), response);
        item = await c.client.getItem(identity.id);
      }
      if (!expected(item)) throw unknownOutcome(current.operation_id);
      data = { ...data, itemId: item.id, receipt: item };
      current = await this.operations.checkpoint(current, "committing", data);
      const verified = await c.client.getItem(item.id);
      if (!exact(item, verified)) throw unknownOutcome(current.operation_id);
      await this.guard(c.scope, c.permission);
      current = await this.operations.checkpoint(current, "confirmed", { ...data, result: item });
      return current;
    } catch {
      // All failures after the durable commit checkpoint are conservatively
      // uncertain, including lease expiry and missing/malformed acknowledgments.
      try { current = await this.operations.checkpoint(current, "unknown", data); } catch { /* The existing committing checkpoint remains recoverable. */ }
      throw unknownOutcome(current.operation_id);
    } finally { await this.operations.release(current); }
  }
  private async mutate(kind: string, input: Record<string, unknown> & { operationId: string; expectedGeneration?: number }, prepare: (c: Context) => Promise<{ data?: Record<string, unknown>; write: () => Promise<unknown>; expected: (item: DriveItem) => boolean }>) {
    return this.metadata("drive.organize", input.expectedGeneration, async c => {
      let row = await this.operations.create(input.operationId, kind, input, c.scope);
      let data = await this.operations.data(row);
      if (row.phase === "confirmed") return this.publicOperation(row, data);
      row = await this.operations.claim(row, c.scope);
      try {
        if (row.phase !== "prepared") {
          row = await this.recover(c, row, data);
          if (row.phase !== "confirmed") throw unknownOutcome(row.operation_id);
          return this.publicOperation(row, await this.operations.data(row));
        }
        const plan = await prepare(c);
        data = { ...data, ...plan.data };
        row = await this.dispatch(c, row, data, plan.write, plan.expected);
        return this.publicOperation(row, await this.operations.data(row));
      } finally { await this.operations.release(row); }
    });
  }
  async createFolder(input: unknown) {
    const request = parse(CreateDriveFolder, input);
    return this.mutate("create-folder", request, async c => {
      await this.destination(c, request.parentId, request.name);
      return { write: () => c.client.createFolder(request.parentId, request.name, request.operationId), expected: (item: DriveItem) => item.type === "folder" && item.name === request.name && item.parentId === request.parentId };
    });
  }
  async rename(input: unknown) {
    const request = parse(RenameDriveItem, input);
    return this.mutate("rename", request, async c => {
      const item = await c.client.getItem(request.itemId); mutable(item);
      if (item.etag !== request.etag) conflict("The Drive item version changed. Read it before renaming.");
      if (!item.parentId) throw new AppError("UNSUPPORTED_FEATURE", "The item's owned parent could not be verified.", 409);
      await this.destination(c, item.parentId, request.name, item.id);
      return { data: { itemId: item.id }, write: () => c.client.renameItem(item, request.name), expected: (next: DriveItem) => next.id === item.id && next.documentId === item.documentId && next.name === request.name && next.parentId === item.parentId };
    });
  }
  async move(input: unknown) {
    const request = parse(MoveDriveItem, input);
    return this.mutate("move", request, async c => {
      const item = await c.client.getItem(request.itemId); mutable(item);
      if (item.etag !== request.etag) conflict("The Drive item version changed. Read it before moving.");
      const parent = await this.destination(c, request.destinationId, item.name, item.id);
      let ancestor = parent, reachedRoot = false;
      const seen = new Set<string>();
      for (let depth = 0; depth < 64; depth++) {
        if (ancestor.id === item.id || seen.has(ancestor.id)) conflict("A folder cannot be moved into itself, a descendant, or an unverified parent cycle.");
        seen.add(ancestor.id);
        if (ancestor.id === DRIVE_ROOT) { reachedRoot = true; break; }
        if (!ancestor.parentId) break;
        ancestor = await c.client.getItem(ancestor.parentId);
        if (ancestor.type !== "folder") break;
      }
      if (!reachedRoot) throw new AppError("UNSUPPORTED_FEATURE", "The destination's owned ancestor chain could not be verified within 64 folders.", 409);
      return { data: { itemId: item.id }, write: () => c.client.moveItem(item, parent), expected: (next: DriveItem) => next.id === item.id && next.documentId === item.documentId && next.parentId === parent.id && next.name === item.name };
    });
  }
  async prepareUpload(input: unknown) {
    const request = parse(UploadDriveMetadata, input);
    if (request.size > DRIVE_DIRECT_UPLOAD_BYTES) this.requireStagingBucket();
    return this.metadata("drive.upload", request.expectedGeneration, async c => {
      const row = await this.operations.create(request.operationId, "upload", request, c.scope);
      if (row.permission_revision !== c.scope.permissionRevision) conflict("Upload permissions changed since this intent was prepared.");
      if (row.phase === "prepared") await this.destination(c, request.parentId, request.name);
      return { operationId: request.operationId, uploadPath: `/api/drive/uploads/${request.operationId}/content` };
    });
  }
  private requireStagingBucket() {
    if (!this.env.BUCKET) throw new AppError("CONFIGURATION_REQUIRED", "Files above 64 MiB require a private BUCKET R2 binding and the multipart upload flow on Workers or Sites.", 503);
    return this.env.BUCKET;
  }
  async prepareStreamUpload(input: unknown) {
    const request = parse(UploadDriveMetadata, input);
    return this.metadata("drive.upload", request.expectedGeneration, async c => {
      // A distinct kind pins the transport in the idempotency fingerprint.
      // Neither a staged intent nor the ordinary HTTP route can use this key.
      const row = await this.operations.create(request.operationId, "stream-upload", request, c.scope);
      if (row.permission_revision !== c.scope.permissionRevision) conflict("Upload permissions changed since this intent was prepared.");
      if (row.phase === "prepared") await this.destination(c, request.parentId, request.name);
      return { operationId: row.operation_id, phase: row.phase, socketPath: `/api/drive/uploads/${row.operation_id}/stream` };
    });
  }
  async prepareTransferUpload(input: unknown) {
    const request = parse(UploadDriveMetadata, input);
    return this.metadata("drive.upload", request.expectedGeneration, async c => {
      const row = await this.operations.create(request.operationId, "stream-upload", request, c.scope);
      if (row.permission_revision !== c.scope.permissionRevision) conflict("Upload permissions changed since this intent was prepared.");
      if (row.phase === "prepared") await this.destination(c, request.parentId, request.name);
      const result = this.publicOperation(row, await this.operations.data(row));
      // Inspect uncertain work through MCP; never mint a fresh dispatch right
      // for an operation whose Apple outcome is not provably replayable.
      if (!["prepared", "allocated", "uploaded", "confirmed"].includes(row.phase)) return result;
      return { ...result, transfer: await issueDriveTransfer(this.env, this.owner, "upload", row.operation_id, row.input_hash,
        { ...c.scope, expiresAt: Math.min(c.scope.expiresAt, row.expires_at) }, { size: request.size, sha256: request.sha256 }) };
    });
  }
  async streamUploadStatus(operationId: string, claim?: TransferClaim) {
    if (claim && (claim.kind !== "upload" || claim.id !== operationId || claim.owner !== this.owner)) conflict("This capability belongs to another upload.");
    return this.metadata("drive.upload", undefined, async c => {
      const row = await this.operations.get(parse(OperationId, operationId), c.scope);
      if (row.kind !== "stream-upload") conflict("This operation was not prepared for direct streaming.");
      if (claim && (row.input_hash !== claim.inputHash || row.permission_revision !== c.scope.permissionRevision)) conflict("This capability belongs to different upload input or permissions.");
      if (!["prepared", "allocated", "uploaded", "confirmed"].includes(row.phase)) throw unknownOutcome(row.operation_id);
      return { operationId: row.operation_id, phase: row.phase, size: parse(UploadDriveMetadata, (await this.operations.data(row)).input).size };
    }, claim?.scope);
  }
  async uploadStreamContent(operationId: string, body: ReadableStream<Uint8Array>, signal: AbortSignal, claim?: TransferClaim, ready?: () => void) {
    return this.uploadContent(operationId, body, signal, false, true, claim, ready);
  }
  private staging(context: Context) {
    return new DriveStaging(this.requireStagingBucket(), this.operations, context.scope, () => this.guard(context.scope, "drive.upload"));
  }
  async prepareMultipartUpload(input: unknown) {
    const request = parse(UploadDriveMetadata, input);
    this.requireStagingBucket();
    if (!request.size) throw new AppError("VALIDATION_ERROR", "Use the direct upload flow for an empty file.", 400);
    await this.prepareUpload(request);
    return this.metadata("drive.upload", request.expectedGeneration, c => this.staging(c).prepare(request.operationId));
  }
  async uploadPart(operationId: string, partNumber: number, checksum: string, body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
    try {
      const context = await this.open("drive.upload");
      // Client network time must not hold the 30-second Apple metadata lease.
      try { await this.finish(context); } finally { await this.close(context); }
      return await this.staging(context).part(parse(OperationId, operationId), partNumber, checksum, body, signal);
    } finally { await body.cancel().catch(() => {}); }
  }
  async completeMultipartUpload(input: unknown, signal?: AbortSignal) {
    const request = parse(GetDriveOperation, input), bucket = this.requireStagingBucket();
    const ready = await this.metadata("drive.upload", request.expectedGeneration, async c => {
      const staging = await this.staging(c).complete(request.operationId);
      const row = await this.operations.get(request.operationId, c.scope);
      return { staging, operation: this.publicOperation(row, await this.operations.data(row)) };
    });
    if (ready.operation.phase === "confirmed") {
      await bucket.delete(ready.staging.key); return ready.operation;
    }
    const object = await bucket.get(ready.staging.key, { onlyIf: { etagMatches: ready.staging.objectEtag! } });
    if (!object || !("body" in object)) throw new AppError("CONFLICT", "The staged upload expired or changed. Inspect its operation before continuing.", 409);
    const result = await this.uploadContent(request.operationId, object.body, signal, true);
    if (result.phase === "confirmed") await bucket.delete(ready.staging.key);
    return result;
  }
  async discardMultipartUpload(input: unknown) {
    const request = parse(GetDriveOperation, input);
    return this.metadata("drive.upload", request.expectedGeneration, c => this.staging(c).discard(request.operationId));
  }
  async upload(input: unknown) {
    const validated = UploadDrive.safeParse(input);
    if (!validated.success && validated.error.issues.some(issue => issue.code === "too_big" && ["size", "contentBase64"].includes(String(issue.path[0])))) throw new AppError("VALIDATION_ERROR", INLINE_UPLOAD_GUIDANCE, 413);
    const request = parse(UploadDrive, input);
    const metadata = parse(UploadDriveMetadata, Object.fromEntries(Object.entries(request).filter(([key]) => key !== "contentBase64")));
    if (request.contentBase64 === undefined || request.contentBase64 === "" && request.size > 0) return this.prepareTransferUpload(metadata);
    if (request.size > INLINE_FILE_BYTES) throw new AppError("VALIDATION_ERROR", INLINE_UPLOAD_GUIDANCE, 413);
    let bytes: Uint8Array;
    try { bytes = unb64(request.contentBase64, INLINE_FILE_BYTES); } catch { throw new AppError("VALIDATION_ERROR", "The inline upload is not valid bounded base64.", 400); }
    if (bytes.length !== request.size || hex(sha256(bytes)) !== request.sha256) throw new AppError("VALIDATION_ERROR", "The inline upload length or SHA-256 digest did not match.", 400);
    await this.prepareUpload(metadata);
    return this.uploadContent(request.operationId, new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }));
  }
  async uploadContent(operationId: string, body: ReadableStream<Uint8Array>, signal?: AbortSignal, staged = false, streamed = false, claim?: TransferClaim, ready?: () => void) {
    operationId = parse(OperationId, operationId);
    if (claim && (claim.kind !== "upload" || claim.id !== operationId || claim.owner !== this.owner)) conflict("This capability belongs to another upload.");
    let c: Context | null = await this.open("drive.upload", claim?.scope.generation, claim?.scope);
    const scope = c.scope;
    let row: DriveOperation;
    let data: DriveOperationData;
    let request: Upload;
    try {
      row = await this.operations.get(operationId, scope);
      if (claim && (row.input_hash !== claim.inputHash || row.permission_revision !== scope.permissionRevision)) conflict("This capability belongs to different upload input or permissions.");
      data = await this.operations.data(row);
      if (row.kind !== (streamed ? "stream-upload" : "upload")) conflict("This operation belongs to a different upload transport.");
      request = parse(UploadDriveMetadata, data.input);
      if (row.phase !== "confirmed" && (data.staging?.cancelled || staged && !data.staging?.objectEtag)) conflict("This staged upload is unavailable.");
      if (row.phase !== "confirmed" && !staged && !streamed && (request.size > DRIVE_DIRECT_UPLOAD_BYTES || data.staging)) throw new AppError("VALIDATION_ERROR", "Use prepare-multipart-upload, numbered parts and complete-multipart-upload for this file. Direct uploads allow at most 64 MiB.", 413);
    } catch (error) {
      await this.close(c);
      await body.cancel(error).catch(() => {});
      throw error;
    }
    let failure: unknown;
    try {
      if (row.phase === "confirmed") { await body.cancel(); await this.finish(c); return this.publicOperation(row, data); }
      row = await this.operations.claim(row, scope);
      if (["committing", "unknown", "allocating", "uploading", "failed"].includes(row.phase)) {
        await body.cancel(); row = await this.recover(c, row, data);
        if (row.phase !== "confirmed") throw unknownOutcome(operationId);
        await this.finish(c); return this.publicOperation(row, await this.operations.data(row));
      }
      if (row.phase === "prepared") {
        if (signal?.aborted) throw signal.reason;
        await this.destination(c, request.parentId, request.name);
        if (signal?.aborted) throw signal.reason;
        await this.guard(scope, "drive.upload");
        row = await this.operations.checkpoint(row, "allocating", data);
        await this.operations.assertLease(row);
        const allocation = await c.client.allocateUpload(request);
        data = { ...data, allocation };
        row = await this.operations.checkpoint(row, "allocated", data);
      }
      if (row.phase === "allocated") {
        const allocation = parse(Allocation, data.allocation);
        await this.operations.assertLease(row, DRIVE_UPLOAD_MINIMUM_LEASE_MS);
        row = await this.operations.checkpoint(row, "uploading", data);
        await this.finish(c);
        const auth = c.http.snapshot(); c = null;
        const http = await this.transferClient(scope, "drive.upload", auth);
        const saved = await this.guard(scope, "drive.upload");
        const client = new DriveClient(http.http, requireDriveConnection(saved.session));
        client.restoreUploadAllocation(allocation, request);
        const checked = this.checkedStream(body, scope, "drive.upload", request.size, signal, request.sha256);
        let receipt;
        try {
          ready?.();
          receipt = await client.uploadBytes(allocation, checked.stream, { name: request.name, size: request.size, signal });
          if (!checked.verified()) throw new AppError("VALIDATION_ERROR", "The upload server responded before the full content was verified.", 400);
        } catch (error) { await checked.cancel(error); throw error; }
        await this.guard(scope, "drive.upload");
        data = { ...data, receipt };
        row = await this.operations.checkpoint(row, "uploaded", data);
        c = await this.open("drive.upload", scope.generation, scope);
      } else await body.cancel();
      if (row.phase !== "uploaded") throw unknownOutcome(operationId);
      const allocation = parse(Allocation, data.allocation), receipt = parse(UploadReceiptSchema, data.receipt);
      if (signal?.aborted) throw signal.reason;
      const parent = await this.destination(c!, request.parentId, request.name);
      row = await this.dispatch(c!, row, data, () => c!.client.finalizeUpload({ parent, name: request.name, documentId: allocation.documentId, receipt }), item => item.documentId === allocation.documentId && item.type === "file" && item.name === request.name && item.parentId === parent.id && item.size === request.size);
      await this.finish(c!);
      return this.publicOperation(row, await this.operations.data(row));
    } catch (error) {
      failure = error;
      if (["allocating", "uploading"].includes(row.phase)) {
        try { row = await this.operations.checkpoint(row, "unknown", data); } catch { /* Expired lease retains the unsafe phase. */ }
        if (!(error instanceof AppError && ["FORBIDDEN", "CONFLICT", "VALIDATION_ERROR"].includes(error.code))) { failure = unknownOutcome(operationId); throw failure; }
      }
      throw error;
    } finally {
      await this.operations.release(row);
      if (c) await this.close(c, failure);
      await body.cancel().catch(() => {});
    }
  }
  async operation(input: unknown) {
    const request = parse(GetDriveOperation, input);
    return this.metadata("drive.browse", request.expectedGeneration, async c => {
      let row = await this.operations.get(request.operationId, c.scope);
      let data = await this.operations.data(row);
      if (["committing", "unknown"].includes(row.phase) && row.permission_revision === c.scope.permissionRevision && row.lease_until <= Date.now()) {
        row = await this.operations.claim(row, c.scope);
        try { row = await this.recover(c, row, data); data = await this.operations.data(row); }
        finally { await this.operations.release(row); }
      }
      return this.publicOperation(row, data);
    });
  }
}
