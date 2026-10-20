import { Effect } from "effect";
import { HttpEffect, HttpRouter } from "effect/unstable/http";

import {
  dbProviderLayer,
  ExecutorApp,
  makeScopedExecutor,
  textFailureStrategy,
} from "@executor-js/api/server";

import { internalPrincipal } from "./auth/cloudflare-access";
import { reconcileInternalIntegrations } from "./internal-integrations/reconcile";
import { makeInternalListTools } from "./internal-integrations/list-tools";
import { loadConfig, type CloudflareConfig, type CloudflareEnv } from "./config";
import { makeCloudflarePlugins, type CloudflarePlugins } from "./plugins";
import { openDb } from "./db/handle";
import { cloudflareAccessIdentityLayer } from "./auth/cloudflare-access";
import {
  CloudflareCodeExecutorProvider,
  makeCloudflareExecutionStackLayer,
  makeCloudflareHostConfig,
  makeCloudflarePluginsProvider,
} from "./execution";
import { ErrorCaptureLive } from "./observability";
import { cloudflareAccountMiddleware } from "./account/account-provider";
import { makeCloudflareApprovalHandler } from "./mcp";
import { makeCloudflareMcpAgentHandler } from "./mcp/agent-handler";

// ===========================================================================
// The Cloudflare host, as ONE `ExecutorApp.make` call: the 4th app alongside
// cloud / self-host / local, differing only by the injected Layers.
//
// The whole scenario in 60 seconds: Cloudflare Access is the identity (validate
// the Cf-Access-Jwt-Assertion JWT, no Better Auth, no WorkOS, no app login),
// D1 is the SQLite store (same FumaDB assembly as self-host), QuickJS is the
// in-process code substrate, no billing, single-tenant. `diff` against
// host-selfhost/src/app.ts is three injected Layers: identity, db, plugins/config.
//
// Built per isolate (async) so the D1 schema bring-up happens once at first
// fetch; `env` arrives with that fetch (a Worker has no module-scope bindings),
// so the providers close over it instead of reading process.env.
// ===========================================================================

// One reconcile pass, run from the cron trigger (never on the request path), by a
// system executor that may write org rows. Also refreshes existing declared
// catalogs whose tool list changed. Never throws.
export const reconcileInternalIntegrationsOnce = (env: CloudflareEnv): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const config = loadConfig(env);
      const accountId = internalPrincipal(config, { subject: null, email: null })?.accountId;
      if (config.internalIntegrations.length === 0 || accountId === undefined) return;
      const handle = yield* Effect.promise(() => openDb(env));
      const executor = yield* makeScopedExecutor<CloudflarePlugins>(
        accountId,
        config.organizationId,
        config.organizationName,
        { orgWrites: "allowed" },
      ).pipe(Effect.provide(makeCloudflareExecutionStackLayer(config, handle)));
      yield* reconcileInternalIntegrations(executor, config.internalIntegrations, {
        listTools: makeInternalListTools(config.internalHosts),
        store: env.BLOBS,
      }).pipe(Effect.ensuring(executor.close().pipe(Effect.ignore)));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("internal integration reconcile aborted", cause).pipe(
          Effect.annotateLogs({ step: "reconcile-internal-integrations" }),
        ),
      ),
    ),
  );

export const makeCloudflareApp = async (
  env: CloudflareEnv,
  config: CloudflareConfig = loadConfig(env),
) => {
  const plugins = makeCloudflarePlugins(config.secretKey);

  // Open and idempotently bring up the D1 schema once. This is the long-lived
  // handle the per-request scoped executor reads through the DbProvider seam.
  const handle = await openDb(env);
  const identityLayer = cloudflareAccessIdentityLayer(config);
  const mcpAgentHandler = makeCloudflareMcpAgentHandler(config);
  const approvalHandler = makeCloudflareApprovalHandler(config, env);

  const { appLayer, toWebHandler } = ExecutorApp.make({
    plugins,
    providers: {
      identity: identityLayer,
      db: dbProviderLayer(Effect.succeed(handle)),
      engine: { codeExecutor: CloudflareCodeExecutorProvider },
      plugins: {
        provider: makeCloudflarePluginsProvider(config),
        config: makeCloudflareHostConfig(config),
      },
      errorCapture: ErrorCaptureLive,
      // The account API (`/api/account/*`) backs the shared multiplayer shell's
      // auth context; `me` reflects the Access principal. Members/keys are
      // Access-managed, so the rest of the surface is stubbed.
      account: cloudflareAccountMiddleware(config),
    },
    extensions: {
      routes: [
        // Browser approval of paused MCP executions: the console resume page
        // reads paused detail (GET) and records the decision (POST .../resume),
        // Access-gated, routed to the owning session's Durable Object.
        HttpRouter.add("*", "/api/mcp-sessions/*", HttpEffect.fromWebHandler(approvalHandler)),
      ],
    },
    config: { mountPrefix: "/api", failure: textFailureStrategy },
    boot: identityLayer,
  });

  return { appLayer, toWebHandler, mcpAgentHandler };
};
