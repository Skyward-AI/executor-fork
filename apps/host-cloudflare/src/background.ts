import { Effect, type Scope } from "effect";

import {
  makePlatformExecutor,
  makeScopedExecutor,
  type DbProvider,
  type HostConfig,
  type PluginsProvider,
} from "@executor-js/api/server";
import type { Executor, OrgWriteAccess, StorageFailure } from "@executor-js/sdk";

import { internalPrincipal } from "./auth/cloudflare-access";
import { loadConfig, type CloudflareConfig, type CloudflareEnv } from "./config";
import { openDb } from "./db/handle";
import { makeCloudflareExecutionStackLayer } from "./execution";
import type { CloudflarePlugins } from "./plugins";

// ---------------------------------------------------------------------------
// The frame every cron job runs in: the loaded config, the system principal the
// internal service binding acts as, and executors over the isolate's one D1
// handle that close when the job ends. A job never throws; a failure is logged
// as the job aborting.
// ---------------------------------------------------------------------------

type ExecutorServices = DbProvider | PluginsProvider | HostConfig;

export interface BackgroundJob {
  readonly env: CloudflareEnv;
  readonly config: CloudflareConfig;
  /** The system principal's account id. */
  readonly accountId: string;
  /** An executor acting as `subject`, closed with the job. */
  readonly actingAs: (
    subject: string,
    options: { readonly orgWrites: OrgWriteAccess; readonly recordSighting?: boolean },
  ) => Effect.Effect<Executor<CloudflarePlugins>, StorageFailure, Scope.Scope>;
  /** The tenant-wide, read-only platform view, closed with the job. */
  readonly platform: () => Effect.Effect<Executor, StorageFailure, Scope.Scope>;
}

export const runBackgroundJob = (
  env: CloudflareEnv,
  name: string,
  job: (frame: BackgroundJob) => Effect.Effect<void, unknown, Scope.Scope>,
): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const config = loadConfig(env);
      const accountId = internalPrincipal(config, { subject: null, email: null })?.accountId;
      if (accountId === undefined) return;
      const scoped = <A extends { readonly close: () => Effect.Effect<unknown, unknown> }>(
        make: Effect.Effect<A, StorageFailure, ExecutorServices>,
      ) =>
        Effect.acquireRelease(
          Effect.promise(() => openDb(env)).pipe(
            Effect.flatMap((handle) =>
              make.pipe(Effect.provide(makeCloudflareExecutionStackLayer(config, handle))),
            ),
          ),
          (executor) => executor.close().pipe(Effect.ignore),
        );
      yield* job({
        env,
        config,
        accountId,
        actingAs: (subject, options) =>
          scoped(
            makeScopedExecutor<CloudflarePlugins>(
              subject,
              config.organizationId,
              config.organizationName,
              options,
            ),
          ),
        platform: () => scoped(makePlatformExecutor(config.organizationId)),
      });
    }).pipe(
      Effect.scoped,
      Effect.catchCause((cause) =>
        Effect.logWarning(`${name} aborted`, cause).pipe(
          Effect.annotateLogs({ step: name.replaceAll(" ", "-") }),
        ),
      ),
    ),
  );
