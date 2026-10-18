import { Effect, Layer, type Context } from "effect";

import {
  CodeExecutorProvider,
  DbProvider,
  dbProviderLayer,
  EngineDecorator,
  EngineDecoratorNoop,
  HostConfig,
  PluginsProvider,
  type ExecutorDbHandle,
} from "@executor-js/api/server";
import { ARTIFACT_COMPILE_FINGERPRINT } from "@executor-js/mcp-apps-shell/compile-fingerprint";
import { makeDynamicWorkerExecutor } from "@executor-js/runtime-dynamic-worker";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";
import { env } from "cloudflare:workers";

import type { CloudflareConfig } from "./config";
import { makeCloudflarePlugins } from "./plugins";

// ---------------------------------------------------------------------------
// Cloudflare execution-stack seams — the same shape as self-host (QuickJS code
// substrate, no-op engine decorator), with the plugins + host config built from
// the per-request `env`-derived config rather than process.env.
//
// Code substrate: when the Worker declares a `worker_loaders` LOADER binding,
// use the dynamic-worker executor (cloud's substrate) — real isolates with
// `globalOutbound: null`. Without the binding, fall back to QuickJS-wasm,
// which runs in a single Worker with no extra binding.
// ---------------------------------------------------------------------------

export { makeExecutionStack } from "@executor-js/api/server";
export { EngineDecoratorNoop };

type CodeExecutor = Context.Service.Shape<typeof CodeExecutorProvider>;

// QuickJS must have the Workers WASM-inlined variant loaded before it runs
// (the default variant cannot fetch its .wasm on Workers). Executors are built
// synchronously, so the load happens on the first `execute`, the async boundary
// right before code runs. Building the app or serving a request that never
// executes code does not load QuickJS. The load is memoized per isolate.
export const withLazyPreload = (
  executor: CodeExecutor,
  preload: () => Promise<void>,
): CodeExecutor => ({
  ...executor,
  execute: (code, toolInvoker) =>
    Effect.promise(preload).pipe(Effect.flatMap(() => executor.execute(code, toolInvoker))),
});

const preloadQuickJsOnDemand = (): Promise<void> =>
  import("./quickjs").then((m) => m.preloadQuickJs());

export const CloudflareCodeExecutorProvider: Layer.Layer<CodeExecutorProvider> = Layer.sync(
  CodeExecutorProvider,
  () => {
    const loader = (env as { LOADER?: WorkerLoader }).LOADER;
    return loader
      ? makeDynamicWorkerExecutor({ loader })
      : withLazyPreload(makeQuickJsExecutor(), preloadQuickJsOnDemand);
  },
);

export const makeCloudflarePluginsProvider = (
  config: CloudflareConfig,
): Layer.Layer<PluginsProvider> =>
  Layer.succeed(PluginsProvider)({
    plugins: (context) =>
      makeCloudflarePlugins(config.secretKey, {
        activeToolkitSlug:
          context?.mcpResource?.kind === "toolkit" ? context.mcpResource.slug : undefined,
        allowLocalNetwork: config.allowLocalNetwork,
      }),
  });

export const makeCloudflareHostConfig = (config: CloudflareConfig): Layer.Layer<HostConfig> =>
  Layer.succeed(HostConfig)({
    allowLocalNetwork: config.allowLocalNetwork,
    internalHosts: config.internalHosts,
    webBaseUrl: config.webBaseUrl,
    oauthCallbackPath: "/api/oauth/callback",
    // Each MCP session's executor lives in a Durable Object with a small memory
    // limit, and one rebuild holds a whole catalog (a large OpenAPI spec) in
    // memory. Rebuild stale catalogs one at a time so many of them cannot take
    // the session down together.
    toolsSyncConcurrency: 1,
    // Tailwind and Sucrase load on the first save or render read, not at
    // Worker startup.
    artifactCompiler: {
      fingerprint: ARTIFACT_COMPILE_FINGERPRINT,
      compile: (code) =>
        Effect.promise(() =>
          import("@executor-js/mcp-apps-shell/precompile").then((m) => m.precompileArtifact(code)),
        ),
    },
    // Absent unless both gateway ids are set, which leaves search lexical.
    ...(config.jevGateway === undefined ? {} : { jevGateway: config.jevGateway }),
  });

/**
 * The five execution-stack seams the shared `makeExecutionStack` reads from,
 * bundled into one Layer over the long-lived D1 handle. Mirrors self-host's
 * `SelfHostExecutionStackLayer`. The HTTP path wires these seams individually
 * through `ExecutorApp.make`; the MCP session store provides this whole Layer to
 * build a per-session engine off the envelope's request pipeline.
 */
export const makeCloudflareExecutionStackLayer = (
  config: CloudflareConfig,
  dbHandle: ExecutorDbHandle,
): Layer.Layer<
  DbProvider | PluginsProvider | HostConfig | CodeExecutorProvider | EngineDecorator
> =>
  Layer.mergeAll(
    dbProviderLayer(Effect.succeed(dbHandle)),
    makeCloudflarePluginsProvider(config),
    makeCloudflareHostConfig(config),
    CloudflareCodeExecutorProvider,
    EngineDecoratorNoop,
  );
