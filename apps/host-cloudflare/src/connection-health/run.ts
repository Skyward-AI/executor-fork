import { Effect, type Scope } from "effect";

import type { ExecutorAdmin, StorageFailure } from "@executor-js/sdk";

import { runBackgroundJob, type BackgroundJob } from "../background";
import type { CloudflareConfig, CloudflareEnv } from "../config";
import { sweepConnectionHealth, type ConnectionHealthSweep } from "./sweep";

/** The console page of an integration, when the deployment pins its origin. */
export const consoleUrlFor =
  (config: Pick<CloudflareConfig, "webBaseUrl" | "organizationSlug">) =>
  (integration: string): string | null =>
    config.webBaseUrl === undefined
      ? null
      : `${config.webBaseUrl.replace(/\/+$/, "")}/${encodeURIComponent(config.organizationSlug)}/integrations/${encodeURIComponent(integration)}`;

// One connection health pass, run from the hourly cron trigger. The workspace's
// connections are checked by the same system principal as the reconcile; each
// member's by an executor acting as that member. None of them records a
// sighting: this is background work, and a sighting would keep every member
// active, so none would ever age out of the sweep.
export const connectionHealthSweepFor = (
  frame: Pick<BackgroundJob, "config" | "accountId" | "actingAs">,
  admin: ExecutorAdmin,
): Effect.Effect<ConnectionHealthSweep, StorageFailure, Scope.Scope> =>
  Effect.map(
    frame.actingAs(frame.accountId, { orgWrites: "allowed", recordSighting: false }),
    (org) => ({
      org,
      admin,
      asMember: (subject) =>
        frame.actingAs(subject, { orgWrites: "denied", recordSighting: false }),
      consoleUrl: consoleUrlFor(frame.config),
      now: Date.now,
    }),
  );

export const sweepConnectionHealthOnce = (env: CloudflareEnv): Promise<void> =>
  runBackgroundJob(env, "connection health sweep", (frame) =>
    Effect.gen(function* () {
      const { admin } = yield* frame.platform();
      if (admin === undefined) return;
      yield* sweepConnectionHealth(yield* connectionHealthSweepFor(frame, admin));
    }),
  );
