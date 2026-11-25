import { Effect } from "effect";

import {
  healthEvidence,
  type AdminConnection,
  type Connection,
  type Executor,
  type HealthCheckResult,
  StorageError,
  type StorageFailure,
} from "@executor-js/sdk";

import type { CloudflareConfig, CloudflareEnv } from "../config";
import { loadConfig } from "../config";
import { platformExecutor } from "../platform-executor";
import { consoleUrlFor } from "./run";
import type { ConnectionHealthSnapshot, ConnectionHealthVerdict } from "./snapshot";
import { allMembers, isInactive } from "./sweep";

// ---------------------------------------------------------------------------
// The read behind `ExecutorInternal.connectionHealth()`: the latest stored
// verdict of every workspace connection and of every active member's personal
// connection, as the sweep persisted them. It checks nothing and writes
// nothing. A storage error fails the read: the caller must be able to tell
// "nothing is failing" from "could not look".
// ---------------------------------------------------------------------------

/** Both listings carry what a verdict needs; `lastHealth` is the stored one. */
type Stored = Pick<Connection | AdminConnection, "integration" | "name" | "lastHealth">;

export const connectionHealthSnapshot = (
  platform: Executor,
  config: Pick<CloudflareConfig, "organizationId" | "webBaseUrl" | "organizationSlug">,
  now: number,
): Effect.Effect<ConnectionHealthSnapshot, StorageFailure> =>
  Effect.gen(function* () {
    const consoleUrl = consoleUrlFor(config);
    const integrationNames = new Map(
      (yield* platform.integrations.list()).map((i) => [String(i.slug), i.name] as const),
    );
    const verdict = (
      owner: "org" | "user",
      subject: string | null,
      connection: Stored,
      result: HealthCheckResult,
    ): ConnectionHealthVerdict => {
      const integration = String(connection.integration);
      return {
        owner,
        subject,
        integration,
        integrationName: integrationNames.get(integration) ?? integration,
        name: String(connection.name),
        url: consoleUrl(integration),
        evidence: healthEvidence(result),
        status: result.status,
        reason: result.reason ?? null,
        checkedAt: result.checkedAt,
      };
    };
    const verdictsOf = (
      owner: "org" | "user",
      subject: string | null,
      connections: readonly Stored[],
    ): ConnectionHealthVerdict[] =>
      connections.flatMap((connection) =>
        connection.lastHealth == null
          ? []
          : [verdict(owner, subject, connection, connection.lastHealth)],
      );

    const workspace = verdictsOf("org", null, yield* platform.connections.list({ owner: "org" }));
    const admin = platform.admin;
    // Without the platform view there is no member listing; answering with the
    // workspace alone would pass for "no member connection is failing".
    if (admin === undefined) {
      return yield* new StorageError({
        message: "platform executor has no admin view",
        cause: undefined,
      });
    }
    const members = (yield* allMembers(admin)).filter((member) => !isInactive(member, now));
    return {
      tenant: config.organizationId,
      verdicts: [
        ...workspace,
        ...members.flatMap((member) =>
          verdictsOf(
            "user",
            member.externalId,
            member.connections.filter((c) => c.owner === "user"),
          ),
        ),
      ],
    };
  }).pipe(Effect.withSpan("executor.connection_health.read"));

/** The RPC body: rejects on any failure, never an empty or partial snapshot. */
export const connectionHealthFor = async (env: CloudflareEnv): Promise<ConnectionHealthSnapshot> =>
  Effect.runPromise(
    connectionHealthSnapshot(await platformExecutor(env), loadConfig(env), Date.now()),
  );
