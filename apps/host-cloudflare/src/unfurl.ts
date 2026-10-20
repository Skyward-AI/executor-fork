import { Effect, Layer } from "effect";

import { dbProviderLayer, makePlatformExecutor } from "@executor-js/api/server";
import type { AdminArtifactSummary, Executor } from "@executor-js/sdk";

import { loadConfig, type CloudflareEnv } from "./config";
import { openDb } from "./db/handle";
import { makeCloudflareHostConfig, makeCloudflarePluginsProvider } from "./execution";

// ---------------------------------------------------------------------------
// The read behind `ExecutorUnfurl`: link previews for internal services. One
// subject-less, read-only platform executor per isolate, bound to the same D1
// database and tenant (`organizationId`) as the public and internal doors. It
// sees every artifact in the tenant whoever owns it, and selects only title,
// description and last edit.
// ---------------------------------------------------------------------------

const ARTIFACT_ID = /^art_[a-z0-9]{1,60}$/;

let executor: Promise<Executor> | null = null;

// A failed build is dropped so the next caller retries.
const platformExecutor = (env: CloudflareEnv): Promise<Executor> => {
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

export const artifactSummaryFor = async (
  env: CloudflareEnv,
  id: string,
): Promise<AdminArtifactSummary | null> => {
  if (!ARTIFACT_ID.test(id)) return null;
  const admin = (await platformExecutor(env)).admin;
  if (admin === undefined) return null;
  return Effect.runPromise(admin.artifactSummary(id));
};
