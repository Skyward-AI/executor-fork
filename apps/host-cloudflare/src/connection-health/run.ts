import { Duration, Effect, type Scope } from "effect";

import type { ExecutorAdmin, StorageFailure } from "@executor-js/sdk";

import { runBackgroundJob, type BackgroundJob } from "../background";
import type { CloudflareConfig, CloudflareEnv, ConnectionHealthReports } from "../config";
import type { ConnectionHealthSnapshot } from "./snapshot";
import { sweepConnectionHealth, type ConnectionHealthSweep } from "./sweep";

/** The receiver may deliver notices before it answers, so it gets far longer
 *  than a plain RPC round trip. */
const REPORT_TIMEOUT = Duration.seconds(30);

/** The console page of an integration, when the deployment pins its origin. */
export const consoleUrlFor =
  (config: Pick<CloudflareConfig, "webBaseUrl" | "organizationSlug">) =>
  (integration: string): string | null =>
    config.webBaseUrl === undefined
      ? null
      : `${config.webBaseUrl.replace(/\/+$/, "")}/${encodeURIComponent(config.organizationSlug)}/integrations/${encodeURIComponent(integration)}`;

/** Hand the snapshot to the receiver. A timeout does not cancel the remote
 *  call, so neither it nor a rejection means nothing was posted: both are
 *  logged as unconfirmed and the next pass reports the same truth again. */
export const reportTo =
  (receiver: ConnectionHealthReports | undefined) =>
  (snapshot: ConnectionHealthSnapshot): Effect.Effect<void> =>
    receiver === undefined
      ? Effect.logInfo("connection health reports are off: no receiver bound").pipe(
          Effect.annotateLogs({ verdicts: snapshot.verdicts.length }),
        )
      : Effect.tryPromise(() => receiver.report(snapshot)).pipe(
          Effect.timeout(REPORT_TIMEOUT),
          Effect.flatMap(() =>
            Effect.logInfo("connection health report delivered").pipe(
              Effect.annotateLogs({ verdicts: snapshot.verdicts.length }),
            ),
          ),
          Effect.catch((error) =>
            Effect.logWarning("connection health report unconfirmed", error).pipe(
              Effect.annotateLogs({ verdicts: snapshot.verdicts.length }),
            ),
          ),
        );

// One connection health pass, run from the hourly cron trigger. The workspace's
// connections are checked by the same system principal as the reconcile; each
// member's by an executor acting as that member. None of them records a
// sighting: this is background work, and a sighting would keep every member
// active, so none would ever age out of the sweep.
export const connectionHealthSweepFor = (
  frame: Pick<BackgroundJob, "env" | "config" | "accountId" | "actingAs">,
  admin: ExecutorAdmin,
): Effect.Effect<ConnectionHealthSweep, StorageFailure, Scope.Scope> =>
  Effect.map(
    frame.actingAs(frame.accountId, { orgWrites: "allowed", recordSighting: false }),
    (org) => ({
      tenant: frame.config.organizationId,
      org,
      admin,
      asMember: (subject) =>
        frame.actingAs(subject, { orgWrites: "denied", recordSighting: false }),
      consoleUrl: consoleUrlFor(frame.config),
      report: reportTo(frame.env.CONNECTION_HEALTH_REPORTS),
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
