import { Duration, Effect } from "effect";

import { runBackgroundJob } from "../background";
import type { CloudflareConfig, CloudflareEnv, ConnectionHealthReports } from "../config";
import type { ConnectionHealthSnapshot } from "./snapshot";
import { sweepConnectionHealth } from "./sweep";

/** The receiver looks people up and posts to Slack before it answers. */
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
// sighting: this is background work, and no principal in it is present.
export const sweepConnectionHealthOnce = (env: CloudflareEnv): Promise<void> =>
  runBackgroundJob(env, "connection health sweep", ({ config, accountId, actingAs, platform }) =>
    Effect.gen(function* () {
      const { admin } = yield* platform();
      if (admin === undefined) return;
      yield* sweepConnectionHealth({
        tenant: config.organizationId,
        org: yield* actingAs(accountId, { orgWrites: "allowed", recordSighting: false }),
        admin,
        asMember: (subject) => actingAs(subject, { orgWrites: "denied", recordSighting: false }),
        consoleUrl: consoleUrlFor(config),
        report: reportTo(env.CONNECTION_HEALTH_REPORTS),
        now: Date.now,
      });
    }),
  );
