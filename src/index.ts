import sitesWorker from "./worker";
import { cloudflareAccessFetch, type CloudflareAccessEnv } from "./platform/cloudflare-access.ts";
import { applicationRoute } from "./api/router";
import { driveTransferRoute } from "./drive/transfer-capability";

const worker = {
  fetch(request: Request, env: Cloudflare.Env & CloudflareAccessEnv, ctx: Parameters<typeof sitesWorker.fetch>[2]) {
    // Transfer routes authenticate their own narrowly scoped capability. They
    // never accept caller-supplied identity headers or grant general API access.
    if (driveTransferRoute(new URL(request.url).pathname)) return applicationRoute(request, env).then(response => response!);
    return cloudflareAccessFetch(request, env, (authenticatedRequest) => sitesWorker.fetch(authenticatedRequest, env, ctx));
  },
};
export default worker;
