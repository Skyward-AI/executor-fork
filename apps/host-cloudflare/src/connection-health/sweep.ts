import { Effect, type Scope } from "effect";

import {
  ADMIN_MAX_PAGE_SIZE,
  type AdminSubjectWithConnections,
  type ConnectionName,
  type Executor,
  type ExecutorAdmin,
  type HealthCheckResult,
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
// token that would expire before the next pass, and persists the verdict on the
// connection. Nothing leaves the sweep: the stored verdicts are read back by
// `./read`, which the internal door serves to whoever pulls them.
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
const DUE_SLACK_MS = 15 * 60_000;
/** Once a pass has run this long it starts no further owner, so a slow tenant
 *  cannot run into the platform's limit on a scheduled invocation. The owners
 *  left over are still due on the next pass. */
export const OWNER_START_DEADLINE_MS = 10 * 60_000;
const CHECK_CONCURRENCY = 4;
/** Members not seen for this long are skipped: checking refreshes their
 *  credentials, which would keep a departed member's tokens alive forever. */
export const INACTIVE_MEMBER_MS = 30 * 24 * 60 * 60_000;

export interface ConnectionHealthSweep {
  /** Acts for the workspace: lists and checks its connections. */
  readonly org: Executor;
  /** Tenant-wide read of every member's connections. */
  readonly admin: ExecutorAdmin;
  /** An executor acting as one member, to check that member's connections. */
  readonly asMember: (subject: string) => Effect.Effect<Executor, StorageFailure, Scope.Scope>;
  /** The console page of an integration's connections, if there is one. */
  readonly consoleUrl: (integration: string) => string | null;
  readonly now: () => number;
}

export interface SweepSummary {
  /** Connections whose last verdict was old enough to check. */
  readonly due: number;
  /** Connections checked, each with a fresh stored verdict. */
  readonly checked: number;
  /** Members left out because they have not been seen for a month. */
  readonly inactiveMembers: number;
  /** Owners whose executor could not be built, so none of theirs was checked. */
  readonly failedOwners: number;
  /** Owners with something due that were not started because the pass had run
   *  past its deadline; the next pass picks them up. */
  readonly deferredOwners: number;
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
  readonly executor: Effect.Effect<Executor, StorageFailure, Scope.Scope>;
}

interface PassResult {
  readonly due: number;
  readonly checked: number;
  readonly failed: boolean;
  readonly deferred: boolean;
}

const isDue = (connection: ListedConnection, owner: Owner, now: number): boolean => {
  const previous = connection.lastHealth;
  return previous == null || now - previous.checkedAt >= CHECK_INTERVAL_MS[owner] - DUE_SLACK_MS;
};

/** A member never sighted counts from when they were first recorded, so a
 *  member who never came back still ages out. */
export const isInactive = (member: AdminSubjectWithConnections, now: number): boolean =>
  now - (member.lastSeenAt ?? member.createdAt.getTime()) > INACTIVE_MEMBER_MS;

export const allMembers = (
  admin: ExecutorAdmin,
): Effect.Effect<readonly AdminSubjectWithConnections[], StorageFailure> =>
  Effect.gen(function* () {
    const members: AdminSubjectWithConnections[] = [];
    for (;;) {
      const page = yield* admin.listSubjectsWithConnections({
        limit: ADMIN_MAX_PAGE_SIZE,
        offset: members.length,
      });
      members.push(...page);
      if (page.length < ADMIN_MAX_PAGE_SIZE) return members;
    }
  });

export const sweepConnectionHealth = (
  sweep: ConnectionHealthSweep,
): Effect.Effect<SweepSummary, StorageFailure> =>
  Effect.gen(function* () {
    const now = sweep.now();
    // A connection removed mid-pass, or a storage blip, is logged and left out
    // of the count: one bad row must not cost every other connection its check.
    const check = (executor: Executor, pass: Pass, connection: ListedConnection) =>
      executor.connections
        .checkHealth(
          { owner: pass.owner, integration: connection.integration, name: connection.name },
          { refreshWithinMs: CHECK_INTERVAL_MS[pass.owner] },
        )
        .pipe(
          Effect.as(true),
          Effect.tapError((error) =>
            Effect.logWarning("connection health check failed", error).pipe(
              Effect.annotateLogs({
                integration: String(connection.integration),
                connection: String(connection.name),
                owner: pass.owner,
              }),
            ),
          ),
          Effect.orElseSucceed(() => false),
        );

    // An owner whose executor cannot be built is logged and left out, so one
    // member's broken scope does not cost the rest of the tenant its pass.
    const run = (pass: Pass): Effect.Effect<PassResult> => {
      const due = pass.connections.filter((c) => isDue(c, pass.owner, now));
      const idle: PassResult = { due: due.length, checked: 0, failed: false, deferred: false };
      if (due.length === 0) return Effect.succeed(idle);
      if (sweep.now() - now >= OWNER_START_DEADLINE_MS) {
        return Effect.succeed({ ...idle, deferred: true });
      }
      return Effect.scoped(
        Effect.flatMap(pass.executor, (executor) =>
          Effect.forEach(due, (c) => check(executor, pass, c), { concurrency: CHECK_CONCURRENCY }),
        ),
      ).pipe(
        Effect.map((results) => ({ ...idle, checked: results.filter(Boolean).length })),
        Effect.catch((error) =>
          Effect.logWarning("connection health owner not checked", error).pipe(
            Effect.annotateLogs({ owner: pass.owner }),
            Effect.as({ ...idle, failed: true }),
          ),
        ),
      );
    };

    const members = yield* allMembers(sweep.admin);
    const active = members.filter((member) => !isInactive(member, now));
    const passes: Pass[] = [
      {
        owner: "org",
        subject: null,
        connections: yield* sweep.org.connections.list({ owner: "org" }),
        executor: Effect.succeed(sweep.org),
      },
      ...active.map(
        (member): Pass => ({
          owner: "user",
          subject: member.externalId,
          connections: member.connections.filter((c) => c.owner === "user"),
          executor: sweep.asMember(member.externalId),
        }),
      ),
    ];
    const results = yield* Effect.forEach(passes, run);

    const summary: SweepSummary = {
      due: results.reduce((sum, result) => sum + result.due, 0),
      checked: results.reduce((sum, result) => sum + result.checked, 0),
      inactiveMembers: members.length - active.length,
      failedOwners: results.filter((result) => result.failed).length,
      deferredOwners: results.filter((result) => result.deferred).length,
    };
    yield* Effect.logInfo("connection health sweep finished", summary);
    return summary;
  }).pipe(Effect.withSpan("executor.connection_health.sweep"));
