import { AppError, publicError } from "../errors.ts";
import { requireOwner, requireSameOrigin, type RuntimeEnv } from "../platform/sites.ts";
import { handleMCP } from "../mcp/handler.ts";
import { limitedBytes } from "../transport/apple-http.ts";
import { appleAuthSocket } from "../auth/socket.ts";
import { AppleConnectionService, ControlledRead, ResumeRequest } from "../auth/service.ts";
import { appleGates, requireAppleEnabled } from "../auth/gates.ts";
import { credentialDocument, credentialScript } from "../auth/credential-page.ts";
import { ReminderJobService } from "../jobs/service.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
export async function applicationRoute(request: Request, env: RuntimeEnv, credentialJS?: string): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== "/mcp" && path !== "/connect/apple" && !path.startsWith("/api/")) return null;
  const requestId = crypto.randomUUID();
  try {
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
      requireSameOrigin(request, env);
      const jobRoute = /^\/api\/reminder-jobs(?:\/([a-f0-9-]{36})\/(append|preview|start|cancel|resume|continue))?$/i.exec(path);
      if (jobRoute || path === "/api/reminder-updates/prepare" || path === "/api/reminder-evidence/capture" || path === "/api/reminder-evidence/atomic-protection") {
        const bytes = await limitedBytes(new Response(request.body, { headers: request.headers }), 65_536);
        let value: unknown;
        try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
        catch { throw new AppError("VALIDATION_ERROR", "Provide a valid reminder-job or update-preparation request.", 400); }
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("VALIDATION_ERROR", "A JSON object is required.", 400);
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
