import { WorkerEntrypoint } from "cloudflare:workers";

import { setQuickJSModuleLoader } from "@executor-js/runtime-quickjs";
import type { AdminArtifactSummary } from "@executor-js/sdk";

import { makeCloudflareApp, reconcileInternalIntegrationsOnce } from "./app";
import {
  cloudflareAccessConfigErrorMessage,
  loadConfig,
  missingCloudflareAccessVars,
  type CloudflareEnv,
} from "./config";
import { mcpResourceFromPath } from "./mcp/resource";
import { artifactSummaryFor } from "./unfurl";

// Workers cannot fetch the default QuickJS .wasm, so every QuickJS user in this
// script (the fetch handlers and the MCP Durable Objects) resolves the
// WASM-inlined variant through this loader. The import stays dynamic so the
// engine is not instantiated or evaluated at startup.
setQuickJSModuleLoader(() => import("./quickjs").then((m) => m.loadQuickJs()));

// The MCP Durable Object classes, bound in wrangler.jsonc. They must be exported
// at the Worker entry module scope for the runtime to find them.
export { McpExecutionOwnerDirectoryDO, McpSessionDO } from "./mcp";

// ---------------------------------------------------------------------------
// The Worker fetch entry. Most requests go to `ExecutorApp.make`'s Effect web
// handler. `/mcp` and `/mcp/toolkits/:slug` stay at this edge boundary because
// `McpAgent.serve()` needs the Cloudflare `ExecutionContext` to pass
// authenticated session props into the hibernatable Durable Object bridge.
//
// Two doors share that machinery:
//   - the default `fetch` is the PUBLIC door: every request must carry a verified
//     Cloudflare Access assertion.
//   - `ExecutorInternal` is the service-binding door: a worker in the same account
//     reaches it through a `services` binding with `entrypoint: "ExecutorInternal"`.
//     It builds its OWN app from a config marked `trustedInternal`; nothing in
//     `env` or in a request can switch the public door into that mode.
//   - `ExecutorUnfurl` is a narrow read-only RPC door, reached the same way with
//     `entrypoint: "ExecutorUnfurl"`: link previews for internal services.
// ---------------------------------------------------------------------------

interface Serve {
  readonly app: (request: Request) => Promise<Response>;
  readonly mcp: (request: Request, env: CloudflareEnv, ctx: ExecutionContext) => Promise<Response>;
}

const makeResolver = (internal: boolean) => {
  let promise: Promise<Serve> | null = null;
  return (env: CloudflareEnv): Promise<Serve> => {
    if (!promise) {
      promise = makeCloudflareApp(env, loadConfig(env, { internal })).then(
        ({ toWebHandler, mcpAgentHandler }) => ({
          app: toWebHandler().handler,
          mcp: mcpAgentHandler,
        }),
      );
    }
    return promise;
  };
};

const resolvePublic = makeResolver(false);
const resolveInternal = makeResolver(true);

const accessConfigErrorResponse = (missingVars: readonly string[]): Response =>
  new Response(`${cloudflareAccessConfigErrorMessage(missingVars)}\n`, {
    status: 503,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    },
  });

const serveRequest = async (
  request: Request,
  env: CloudflareEnv,
  ctx: ExecutionContext,
  resolve: (env: CloudflareEnv) => Promise<Serve>,
): Promise<Response> => {
  const missingAccessVars = missingCloudflareAccessVars(env);
  if (missingAccessVars.length > 0) {
    return accessConfigErrorResponse(missingAccessVars);
  }

  const serve = await resolve(env);
  const resource = mcpResourceFromPath(new URL(request.url).pathname);
  if (resource !== null) {
    return serve.mcp(request, env, ctx);
  }
  return serve.app(request);
};

/**
 * The service-binding door. Reachable only through a `services` binding from a
 * worker in the same account; the platform gives it no public route. A request
 * acts as the calling service, or as the person named in `X-Executor-Subject`
 * (see `internalPrincipal`).
 */
export class ExecutorInternal extends WorkerEntrypoint<CloudflareEnv> {
  override fetch(request: Request): Promise<Response> {
    return serveRequest(request, this.env, this.ctx, resolveInternal);
  }
}

/**
 * The link-preview door. Reachable only through a `services` binding with
 * `entrypoint: "ExecutorUnfurl"`; it has no route and takes no identity. It
 * returns the title, description and last edit of an artifact in this
 * deployment's tenant, whoever owns it, and never the source, bindings,
 * previews, owner or subject. Read-only.
 */
export class ExecutorUnfurl extends WorkerEntrypoint<CloudflareEnv> {
  artifactSummary(id: string): Promise<AdminArtifactSummary | null> {
    return artifactSummaryFor(this.env, id);
  }
}

export default {
  fetch: (request: Request, env: CloudflareEnv, ctx: ExecutionContext): Promise<Response> =>
    serveRequest(request, env, ctx, resolvePublic),
  scheduled: (
    _controller: ScheduledController,
    env: CloudflareEnv,
    ctx: ExecutionContext,
  ): void => {
    ctx.waitUntil(reconcileInternalIntegrationsOnce(env));
  },
};
