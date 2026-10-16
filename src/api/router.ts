import { AppError, publicError } from "../errors.ts";
import { requireOwner, requireSameOrigin, type RuntimeEnv } from "../platform/sites.ts";
import { handleMCP } from "../mcp/handler.ts";
import { limitedBytes } from "../transport/apple-http.ts";
import { appleAuthSocket } from "../auth/socket.ts";
import { AppleConnectionService, ControlledRead, ResumeRequest } from "../auth/service.ts";
import { appleGates, requireAppleEnabled } from "../auth/gates.ts";
import { credentialDocument, credentialScript } from "../auth/credential-page.ts";
import { ReminderJobService } from "../jobs/service.ts";
import { z } from "zod";
import { ServiceSettingsRepository } from "../persistence/service-settings.ts";
import { ServiceSettingsSchema } from "../services/settings.ts";
import { DriveService } from "../drive/service.ts";
import { probeDriveContentSocket } from "../transport/drive-socket-probe.ts";
import { driveUploadSocket, driveStoredUploadSocket } from "../drive/upload-socket.ts";
import { authorizeDriveTransfer, driveTransferRoute } from "../drive/transfer-capability.ts";
import { DriveConsent, INLINE_REQUEST_BYTES, INLINE_UPLOAD_GUIDANCE } from "../drive/schemas.ts";

async function readJSON(request: Request, limit = 12_288): Promise<unknown> {
  const bytes = await limitedBytes(new Response(request.body, { headers: request.headers }), limit);
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new AppError("VALIDATION_ERROR", "Provide a valid JSON request.", 400); }
}

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff", "x-robots-tag": "noindex, nofollow, noarchive, nosnippet", "referrer-policy": "no-referrer" } });
export async function applicationRoute(request: Request, env: RuntimeEnv, credentialJS?: string): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== "/mcp" && path !== "/connect/apple" && !path.startsWith("/api/")) return null;
  const requestId = crypto.randomUUID();
  try {
    const transfer = driveTransferRoute(path);
    if (transfer) {
      const claim = await authorizeDriveTransfer(request, env, transfer);
      const service = new DriveService(env, claim.owner);
      if (transfer.kind === "staged-upload") return request.headers.get("upgrade")?.toLowerCase() === "websocket"
        ? await driveStoredUploadSocket(request, service, claim) : json(await service.resumableTransfer(request, claim));
      if (transfer.kind === "upload" && request.headers.get("x-drive-transfer-action") === "diagnose") {
        await service.streamUploadStatus(claim.id, claim);
        return json(await probeDriveContentSocket());
      }
      const response = transfer.kind === "upload"
        ? await driveUploadSocket(request, env, service, claim.id, claim)
        : await service.downloadContent(claim.id, request.signal, request.headers.get("range"), claim);
      response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
      response.headers.set("Referrer-Policy", "no-referrer");
      response.headers.set("Cache-Control", "private, no-store");
      return response;
    }
    if (path === "/api/bootstrap/identity" && request.method === "GET") {
      // An administrator can provision this exact site-scoped ID. Never claim it automatically.
      const user = request.headers.get("oai-authenticated-user-id");
      if (!user || user.length > 256) throw new AppError("UNAUTHENTICATED", "Sign in with ChatGPT first.", 401);
      if (env.APP_ORIGIN && new URL(request.url).origin !== env.APP_ORIGIN) throw new AppError("FORBIDDEN", "Use the private Site origin.", 403);
      return json({ authenticatedUserId: user, ownerBound: user === env.REMINDERS_OWNER_ID, automaticOwnerClaim: false });
    }
    const owner = requireOwner(request, env);
    if (path === "/connect/apple" && request.method === "GET") return credentialDocument(request, env);
    if (path === "/api/auth/client.js" && request.method === "GET") {
      if (!credentialJS) throw new AppError("CONFIGURATION_REQUIRED", "The credential document script is unavailable.", 503);
      return credentialScript(credentialJS);
    }
    if (path === "/api/auth/socket") return await appleAuthSocket(request, env, owner);
    if (path === "/mcp") {
      if (request.headers.get("origin") && request.headers.get("origin") !== env.APP_ORIGIN) throw new AppError("FORBIDDEN", "This request origin is not allowed.", 403);
      if (request.method !== "POST") return json({ error: { code: "METHOD_NOT_ALLOWED", message: "Use stateless POST requests." } }, 405);
      return await handleMCP(request, env, owner);
    }
    if (request.method === "GET") {
      const streamUpload = /^\/api\/drive\/uploads\/([a-f0-9-]{36})\/stream$/i.exec(path);
      if (streamUpload) return await driveUploadSocket(request, env, new DriveService(env, owner), z.string().uuid().parse(streamUpload[1]).toLowerCase());
      if (path === "/api/settings") return json(await new ServiceSettingsRepository(env, owner).load());
      const download = /^\/api\/drive\/downloads\/([a-f0-9-]{36})$/i.exec(path);
      if (download) return await new DriveService(env, owner).downloadContent(z.string().uuid().parse(download[1]), request.signal, request.headers.get("range"));
      if (path === "/api/auth/config") return json(appleGates(env));
      if (path === "/api/connection") return json(await new AppleConnectionService(env, owner).status());
      const job = /^\/api\/reminder-jobs\/([a-f0-9-]{36})$/i.exec(path);
      if (job) {
        const query = new URL(request.url).searchParams;
        if ([...query.keys()].some(key => key !== "offset" && key !== "limit") || query.getAll("offset").length > 1 || query.getAll("limit").length > 1) throw new AppError("VALIDATION_ERROR", "Use only offset and limit for job status.", 400);
        return json(await new ReminderJobService(env, owner).get({ jobId: job[1], offset: query.has("offset") ? Number(query.get("offset")) : 0, limit: query.has("limit") ? Number(query.get("limit")) : 50 }));
      }
    }
    if (request.method === "POST") {
      const uploadPart = /^\/api\/drive\/uploads\/([a-f0-9-]{36})\/parts\/([1-9]\d{0,3})$/i.exec(path);
      const uploadContent = /^\/api\/drive\/uploads\/([a-f0-9-]{36})\/content$/i.exec(path);
      if (uploadContent || uploadPart) {
        // Binary transfers retain the owner/origin checks without the JSON-only
        // content type restriction used by ordinary dashboard actions.
        if (!env.APP_ORIGIN || request.headers.get("origin") !== env.APP_ORIGIN || new URL(request.url).origin !== env.APP_ORIGIN) throw new AppError("FORBIDDEN", "Use the private application origin for uploads.", 403);
        if (request.headers.get("content-type") !== "application/octet-stream") throw new AppError("VALIDATION_ERROR", "Upload an application/octet-stream body.", 400);
        const body = request.body ?? new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
        if (uploadPart) return json(await new DriveService(env, owner).uploadPart(z.string().uuid().parse(uploadPart[1]), Number(uploadPart[2]), request.headers.get("x-content-sha256") ?? "", body, request.signal));
        return json(await new DriveService(env, owner).uploadContent(z.string().uuid().parse(uploadContent![1]), body, request.signal));
      }
      requireSameOrigin(request, env);
      if (path === "/api/drive/complete-multipart-upload") return json(await new DriveService(env, owner).completeMultipartUpload(await readJSON(request), request.signal));
      if (path === "/api/settings") {
        const value = z.object({ expectedRevision: z.number().int().nonnegative().safe(), settings: ServiceSettingsSchema }).strict().safeParse(await readJSON(request));
        if (!value.success) throw new AppError("VALIDATION_ERROR", "Provide valid service preferences and their current revision.", 400);
        return json(await new ServiceSettingsRepository(env, owner).save(value.data));
      }
      if (path === "/api/drive/approve" || path === "/api/reminders/approve") {
        const value = DriveConsent.safeParse(await readJSON(request));
        if (!value.success) throw new AppError("VALIDATION_ERROR", "Refresh the Apple connection before approving Drive.", 400);
        const connection = new AppleConnectionService(env, owner);
        return json(await (path === "/api/drive/approve" ? connection.approveDrive(value.data.expectedGeneration, value.data.restartApproval) : connection.approveReminders(value.data.expectedGeneration, value.data.restartApproval)));
      }
      const driveActions = { list: "list", lookup: "get", search: "search", traverse: "traverse", "resolve-folder-path": "resolveFolderPath", read: "read", download: "download", upload: "upload", "prepare-upload": "prepareUpload", "prepare-stream-upload": "prepareStreamUpload", "prepare-multipart-upload": "prepareMultipartUpload", "discard-multipart-upload": "discardMultipartUpload", "create-folder": "createFolder", rename: "rename", move: "move", operation: "operation" } as const;
      const driveAction = path.startsWith("/api/drive/") ? path.slice("/api/drive/".length) : "";
      if (Object.hasOwn(driveActions, driveAction)) {
        const method = driveActions[driveAction as keyof typeof driveActions];
        let input;
        try { input = await readJSON(request, method === "upload" ? INLINE_REQUEST_BYTES : 12_288); }
        catch (error) {
          if (method === "upload" && error instanceof AppError && error.code === "PROTOCOL_CHANGED") throw new AppError("VALIDATION_ERROR", INLINE_UPLOAD_GUIDANCE, 413);
          throw error;
        }
        return json(await new DriveService(env, owner)[method](input));
      }
      const jobRoute = /^\/api\/reminder-jobs(?:\/([a-f0-9-]{36})\/(append|preview|start|cancel|resume|continue))?$/i.exec(path);
      if (jobRoute || path === "/api/reminders/inspect" || path === "/api/reminder-updates/prepare" || path === "/api/reminder-evidence/capture" || path === "/api/reminder-evidence/atomic-protection") {
        const bytes = await limitedBytes(new Response(request.body, { headers: request.headers }), 65_536);
        let value: unknown;
        try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
        catch { throw new AppError("VALIDATION_ERROR", "Provide a valid reminder-job or update-preparation request.", 400); }
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("VALIDATION_ERROR", "A JSON object is required.", 400);
        if (path === "/api/reminders/inspect") return json(await new AppleConnectionService(env, owner).inspectReminder(value));
        if (path === "/api/reminder-evidence/capture") return json(await new AppleConnectionService(env, owner).captureEvidence(value));
        if (path === "/api/reminder-evidence/atomic-protection") return json(await new AppleConnectionService(env, owner).verifyAtomicEvidence(value));
        if (path === "/api/reminder-updates/prepare") return json(await new AppleConnectionService(env, owner).prepareUpdate(value));
        const jobs = new ReminderJobService(env, owner);
        const action = jobRoute![2]?.toLowerCase() as "append" | "preview" | "start" | "cancel" | "resume" | "continue" | undefined;
        if (!action) return json(await jobs.create(value));
        if (Object.hasOwn(value, "jobId")) throw new AppError("VALIDATION_ERROR", "The job ID belongs in the route, not in the body.", 400);
        return json(await jobs[action]({ ...value, jobId: jobRoute![1] }));
      }
      if (path === "/api/auth/disconnect") return json(await new AppleConnectionService(env, owner).disconnect());
      if (path.startsWith("/api/auth/") || path === "/api/apple/read") {
        requireAppleEnabled(env);
        if (path !== "/api/auth/resume" && path !== "/api/apple/read") throw new AppError("UNSUPPORTED_AUTH", "Use the secure browser proof exchange. This server does not accept Apple passwords or password-derived keys.");
        const bytes = await limitedBytes(new Response(request.body, { headers: request.headers }), 12_288);
        let value: unknown; try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new AppError("VALIDATION_ERROR", "Provide a valid connection request."); }
        const service = new AppleConnectionService(env, owner);
        if (path === "/api/auth/resume") {
          const parsed = ResumeRequest.safeParse(value); if (!parsed.success) throw new AppError("VALIDATION_ERROR", "Refresh status before checking device approval.");
          return json(await service.resume(parsed.data.expectedGeneration, parsed.data.restartApproval));
        }
        const parsed = ControlledRead.safeParse(value); if (!parsed.success) throw new AppError("VALIDATION_ERROR", "Select a valid controlled Reminders read.");
        return json(await service.read(parsed.data));
      }
      if (path === "/api/mutations") {
        requireAppleEnabled(env);
        const bytes = await limitedBytes(new Response(request.body, { headers: request.headers }), 65_536);
        let value: unknown;
        try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new AppError("VALIDATION_ERROR", "Provide a valid reminder mutation request.", 400); }
        return json(await new AppleConnectionService(env, owner).mutate(value));
      }

    }
    return json({ error: { code: "NOT_FOUND", message: "This application route is unavailable.", requestId } }, 404);
  } catch (error) {
    const result = publicError(error, requestId); const status = error instanceof AppError ? error.status : 503;
    // No raw errors, Apple response bodies, content, URLs, headers or arguments are logged.
    return json({ error: result }, status);
  }
}
