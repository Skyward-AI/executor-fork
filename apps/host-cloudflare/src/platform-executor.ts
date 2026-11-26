import { Effect, Layer } from "effect";

import { dbProviderLayer, makePlatformExecutor } from "@executor-js/api/server";
import type { Executor } from "@executor-js/sdk";

import { loadConfig, type CloudflareEnv } from "./config";
import { openDb } from "./db/handle";
import { makeCloudflareHostConfig, makeCloudflarePluginsProvider } from "./execution";

// ---------------------------------------------------------------------------
// One subject-less, read-only platform executor per isolate, bound to the same
// D1 database and tenant (`organizationId`) as the public and internal doors.
// The RPC doors that read the tenant as a whole (`ExecutorUnfurl`,
// `ExecutorInternal.connectionHealth`) share it.
// ---------------------------------------------------------------------------

let executor: Promise<Executor> | null = null;

// A failed build is dropped so the next caller retries.
export const platformExecutor = (env: CloudflareEnv): Promise<Executor> => {
  if (executor === null) {
    const building = openDb(env).then((handle) => {
      const config = loadConfig(env);
      return Effect.runPromise(
        makePlatformExecutor(config.organizationId).pipe(
          Effect.provide(
            Layer.mergeAll(
              dbProviderLayer(Effect.succeed(handle)),
              makeCloudflarePluginsProvider(config),
              makeCloudflareHostConfig(config),
            ),
          ),
        ),
      );
    });
    executor = building;
    void building.then(undefined, () => {
      if (executor === building) executor = null;
    });
  }
  return executor;
};
