import { Effect, Result } from "effect";

import { runBackgroundJob } from "../background";
import type { CloudflareEnv } from "../config";
import { makeStandardWebhookSender } from "../standard-webhook";
import { sweepConnectionHealth, type ConnectionHealthEvent } from "./sweep";
import { resolveConnectionHealthWebhook } from "./webhook-config";

// One connection health pass, run from the hourly cron trigger. The workspace's
// connections are checked by the same system principal as the reconcile; each
// member's by an executor acting as that member. None of them records a
// sighting: this is background work, and no principal in it is present.
export const sweepConnectionHealthOnce = (env: CloudflareEnv): Promise<void> =>
  runBackgroundJob(env, "connection health sweep", ({ config, accountId, actingAs, platform }) =>
    Effect.gen(function* () {
      const { admin } = yield* platform();
      if (admin === undefined) return;
      const notify = yield* Result.match(resolveConnectionHealthWebhook(env), {
        onSuccess: (webhook) => {
          if (webhook === undefined) return Effect.succeed(() => Effect.void);
          const deliver = makeStandardWebhookSender(webhook);
          return Effect.succeed((event: ConnectionHealthEvent) =>
            deliver("connection.health", event),
          );
        },
        onFailure: (problem) =>
          Effect.logWarning(`connection health reports disabled: ${problem}`).pipe(
            Effect.as(() => Effect.void),
          ),
      });
      yield* sweepConnectionHealth({
        tenant: config.organizationId,
        org: yield* actingAs(accountId, { orgWrites: "allowed", recordSighting: false }),
        admin,
        asMember: (subject) => actingAs(subject, { orgWrites: "denied", recordSighting: false }),
        notify,
        now: Date.now,
      });
    }),
  );
