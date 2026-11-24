import { Effect, Option, Predicate, type Scope } from "effect";

import {
  ADMIN_MAX_PAGE_SIZE,
  isFailingHealth,
  type AdminSubjectWithConnections,
  type ConnectionName,
  type Executor,
  type ExecutorAdmin,
  type HealthCheckResult,
  type HealthStatus,
  type IntegrationSlug,
  type Owner,
  type StorageFailure,
} from "@executor-js/sdk";

// ---------------------------------------------------------------------------
// The scheduled connection health sweep. Nothing else probes a connection that
// nobody uses, so without it a provider-side revocation (a refresh grant that
// reached its absolute lifetime, an uninstalled app) stays invisible until the
// next real call fails. Each pass checks every connection whose last verdict
// is older than its owner's interval, asks `checkHealth` to refresh any OAuth
// token that would expire before the next pass, and reports every failing or
// recovered connection once the checks are done.
// ---------------------------------------------------------------------------

/** Workspace connections are shared by everyone, so they are checked hourly;
 *  personal connections only affect their owner, so every six hours. */
export const CHECK_INTERVAL_MS: Readonly<Record<Owner, number>> = {
  org: 60 * 60_000,
  user: 6 * 60 * 60_000,
};
/** The pass itself runs hourly; a verdict written a few minutes after the last
 *  pass still counts as due on the next one instead of waiting a full extra
 *  interval. */
const DUE_SLACK_MS = 5 * 60_000;
const CHECK_CONCURRENCY = 4;

export interface ConnectionHealthEvent {
  readonly tenant: string;
  readonly connection: {
    readonly owner: Owner;
    /** The owning member's external id for a personal connection; null for a
     *  workspace connection. */
    readonly subject: string | null;
    readonly integration: string;
    readonly integrationName: string;
    readonly name: string;
  };
  /** The status before this check, or null when it had never been checked. */
  readonly previous: HealthStatus | null;
  /** The verdict without its upstream identity or response sample. */
  readonly current: Pick<
    HealthCheckResult,
    "status" | "checkedAt" | "reason" | "httpStatus" | "detail"
  >;
}

export interface ConnectionHealthSweep {
  readonly tenant: string;
  /** Acts for the workspace: lists and checks its connections. */
  readonly org: Executor;
  /** Tenant-wide read of every member's connections. */
  readonly admin: ExecutorAdmin;
  /** An executor acting as one member, to check that member's connections. */
  readonly asMember: (subject: string) => Effect.Effect<Executor, StorageFailure, Scope.Scope>;
  /** Deliver one event; never fails. */
  readonly notify: (event: ConnectionHealthEvent) => Effect.Effect<void>;
  readonly now: () => number;
}

export interface SweepSummary {
  readonly checked: number;
  readonly reported: number;
}

interface ListedConnection {
  readonly integration: IntegrationSlug;
  readonly name: ConnectionName;
  readonly lastHealth?: HealthCheckResult | null;
}

/** One owner's connections to check, and who to check them as. */
interface Pass {
  readonly owner: Owner;
  readonly subject: string | null;
  readonly connections: readonly ListedConnection[];
}

/** Report a connection while it is failing, and once when it recovers. */
export const shouldReport = (
  previous: HealthCheckResult | null,
  current: HealthCheckResult,
): boolean =>
  isFailingHealth(current) || (current.status === "healthy" && isFailingHealth(previous));

const isDue = (connection: ListedConnection, owner: Owner, now: number): boolean => {
  const previous = connection.lastHealth;
  return previous == null || now - previous.checkedAt >= CHECK_INTERVAL_MS[owner] - DUE_SLACK_MS;
};

const allMembers = (admin: ExecutorAdmin) =>
  Effect.gen(function* () {
    const members: AdminSubjectWithConnections[] = [];
    for (let offset = 0; ; offset += ADMIN_MAX_PAGE_SIZE) {
      const page = yield* admin.listSubjectsWithConnections({ limit: ADMIN_MAX_PAGE_SIZE, offset });
      members.push(...page);
      if (page.length < ADMIN_MAX_PAGE_SIZE) return members;
    }
  });

const toEvent = (
  tenant: string,
  integrationName: string,
  pass: Pass,
  connection: ListedConnection,
  result: HealthCheckResult,
): ConnectionHealthEvent => ({
  tenant,
  connection: {
    owner: pass.owner,
    subject: pass.subject,
    integration: String(connection.integration),
    integrationName,
    name: String(connection.name),
  },
  previous: connection.lastHealth?.status ?? null,
  current: {
    status: result.status,
    checkedAt: result.checkedAt,
    reason: result.reason,
    httpStatus: result.httpStatus,
    detail: result.detail,
  },
});

export const sweepConnectionHealth = (
  sweep: ConnectionHealthSweep,
): Effect.Effect<SweepSummary, StorageFailure> =>
  Effect.gen(function* () {
    const now = sweep.now();
    const integrationNames = new Map(
      (yield* sweep.org.integrations.list()).map((i) => [String(i.slug), i.name] as const),
    );

    // Some(event or null) once checked; None when the check could not run. A
    // connection removed mid-pass, or a storage blip, is logged and skipped:
    // one bad row must not cost every other connection its check.
    const check = (executor: Executor, pass: Pass, connection: ListedConnection) =>
      executor.connections
        .checkHealth(
          { owner: pass.owner, integration: connection.integration, name: connection.name },
          { refreshWithinMs: CHECK_INTERVAL_MS[pass.owner] },
        )
        .pipe(
          Effect.map((result) => {
            const integration = String(connection.integration);
            return shouldReport(connection.lastHealth ?? null, result)
              ? toEvent(
                  sweep.tenant,
                  integrationNames.get(integration) ?? integration,
                  pass,
                  connection,
                  result,
                )
              : null;
          }),
          Effect.tapError((error) =>
            Effect.logWarning("connection health check skipped", error).pipe(
              Effect.annotateLogs({
                integration: String(connection.integration),
                connection: String(connection.name),
                owner: pass.owner,
              }),
            ),
          ),
          Effect.option,
        );

    const run = (pass: Pass, executorFor: Effect.Effect<Executor, StorageFailure, Scope.Scope>) => {
      const due = pass.connections.filter((c) => isDue(c, pass.owner, now));
      return due.length === 0
        ? Effect.succeed([])
        : Effect.scoped(
            Effect.flatMap(executorFor, (executor) =>
              Effect.forEach(due, (c) => check(executor, pass, c), {
                concurrency: CHECK_CONCURRENCY,
              }),
            ),
          );
    };

    const workspace = yield* run(
      {
        owner: "org",
        subject: null,
        connections: yield* sweep.org.connections.list({ owner: "org" }),
      },
      Effect.succeed(sweep.org),
    );
    const members = yield* Effect.forEach(yield* allMembers(sweep.admin), (member) =>
      run(
        {
          owner: "user",
          subject: member.externalId,
          connections: member.connections.filter((c) => c.owner === "user"),
        },
        sweep.asMember(member.externalId),
      ),
    );

    const checked = [...workspace, ...members.flat()].flatMap(Option.toArray);
    const events = checked.filter(Predicate.isNotNull);
    yield* Effect.forEach(events, sweep.notify, { concurrency: CHECK_CONCURRENCY, discard: true });

    const summary: SweepSummary = { checked: checked.length, reported: events.length };
    yield* Effect.logInfo("connection health sweep finished", summary);
    return summary;
  }).pipe(Effect.withSpan("executor.connection_health.sweep"));
