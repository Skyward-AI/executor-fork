import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  AuthTemplateSlug,
  collectTables,
  ConnectionName,
  createExecutor,
  definePlugin,
  IntegrationSlug,
  StorageError,
  Subject,
  Tenant,
  ToolName,
  type ConnectionRef,
  type Executor,
  type HealthCheckResult,
  type HealthStatus,
} from "@executor-js/sdk";
import {
  createSqliteTestFumaDb,
  memoryCredentialsPlugin,
  type SqliteTestFumaDb,
} from "@executor-js/sdk/testing";

import {
  CHECK_INTERVAL_MS,
  shouldReport,
  sweepConnectionHealth,
  type ConnectionHealthEvent,
} from "./sweep";

const ORG_CHECK_INTERVAL_MS = CHECK_INTERVAL_MS.org;
const USER_CHECK_INTERVAL_MS = CHECK_INTERVAL_MS.user;

const TENANT = "acme";
const INTEG = IntegrationSlug.make("probe");
const TEMPLATE = AuthTemplateSlug.make("apiKey");
const MINUTE = 60_000;

// The probe answers whatever the test set for the connection's name, so each
// case controls a connection's verdict without an upstream.
const makeWorld = () => {
  const verdicts = new Map<string, HealthStatus>();
  const plugin = definePlugin(() => ({
    id: "probe" as const,
    storage: () => ({}),
    resolveTools: () =>
      Effect.succeed({ tools: [{ name: ToolName.make("ping"), description: "ping" }] }),
    invokeTool: () => Effect.succeed({ ok: true }),
    checkHealth: ({ credential }) =>
      Effect.sync(
        (): HealthCheckResult => ({
          status: verdicts.get(String(credential.connection)) ?? "healthy",
          checkedAt: Date.now(),
          detail: "probe",
        }),
      ),
    extension: (ctx) => ({
      seed: () =>
        ctx.core.integrations.register({
          slug: INTEG,
          name: "Probe Service",
          description: "probe",
          config: {},
        }),
    }),
  }))();
  // One instance for every executor, so all of them share its credential store.
  return { verdicts, plugins: [plugin, memoryCredentialsPlugin()] as const };
};

type World = ReturnType<typeof makeWorld>;

const executorAs = (
  world: World,
  db: SqliteTestFumaDb,
  subject: string | null,
): Effect.Effect<Executor<World["plugins"]>> =>
  createExecutor({
    tenant: Tenant.make(TENANT),
    ...(subject === null ? { platformView: true } : { subject: Subject.make(subject) }),
    db: db.db,
    plugins: world.plugins,
    onElicitation: "accept-all",
  }).pipe(Effect.orDie);

const withDb = <A, E>(body: (db: SqliteTestFumaDb) => Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => createSqliteTestFumaDb({ tables: collectTables() })),
    body,
    (db) => Effect.promise(() => db.close()),
  );

const connect = (executor: Executor, owner: "org" | "user", name: string) =>
  executor.connections.create({
    owner,
    name: ConnectionName.make(name),
    integration: INTEG,
    template: TEMPLATE,
    value: `token-${name}`,
  });

/** Stamp a connection's last verdict, as an earlier check would have. */
const lastChecked = (db: SqliteTestFumaDb, name: string, status: HealthStatus, ageMs: number) =>
  Effect.promise(() =>
    db.client.execute({
      sql: "UPDATE connection SET last_health = ? WHERE name = ?",
      args: [JSON.stringify({ status, checkedAt: Date.now() - ageMs }), name],
    }),
  );

/** The executor with its `checkHealth` replaced, to observe or fail checks. */
const withCheckHealth = (
  executor: Executor,
  checkHealth: Executor["connections"]["checkHealth"],
): Executor => ({ ...executor, connections: { ...executor.connections, checkHealth } });

/** A member as the platform view lists them: a `subject` row, which a host
 *  records the first time the member reaches the executor. */
const member = (db: SqliteTestFumaDb, externalId: string) =>
  Effect.promise(() =>
    db.client.execute({
      sql: "INSERT INTO subject (row_id, tenant, external_id, created_at) VALUES (?, ?, ?, ?)",
      args: [`s-${externalId}`, TENANT, externalId, Date.now()],
    }),
  );

/** The workspace, two members, and the checks each executor received. */
const setup = (db: SqliteTestFumaDb) =>
  Effect.gen(function* () {
    const world = makeWorld();
    const org = yield* executorAs(world, db, "svc");
    yield* org.probe.seed();
    yield* member(db, "alice");
    yield* member(db, "bob");
    const alice = yield* executorAs(world, db, "alice");
    const bob = yield* executorAs(world, db, "bob");
    const platform = yield* executorAs(world, db, null);
    const checks: { readonly as: string; readonly name: string; readonly within?: number }[] = [];
    const recording = (as: string, executor: Executor) =>
      withCheckHealth(executor, (ref, options) => {
        checks.push({ as, name: String(ref.name), within: options?.refreshWithinMs });
        return executor.connections.checkHealth(ref, options);
      });
    const members = new Map<string, Executor>([
      ["alice", alice],
      ["bob", bob],
    ]);
    const asMember = (subject: string) => {
      const member = members.get(subject);
      return member === undefined
        ? Effect.die(`no member ${subject}`)
        : Effect.succeed(recording(subject, member));
    };
    const events: ConnectionHealthEvent[] = [];
    const run = (overrides?: { readonly org?: Executor }) =>
      sweepConnectionHealth({
        tenant: TENANT,
        org: overrides?.org ?? recording("svc", org),
        admin: platform.admin!,
        asMember,
        notify: (event) => Effect.sync(() => void events.push(event)),
        now: Date.now,
      });
    return { world, org, alice, bob, checks, events, run };
  });

describe("sweepConnectionHealth", () => {
  it.effect("checks only the connections whose last verdict is older than their interval", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const { org, alice, bob, checks, run } = yield* setup(db);
        yield* connect(org, "org", "neverChecked");
        yield* connect(org, "org", "freshOrg");
        yield* connect(org, "org", "staleOrg");
        yield* connect(alice, "user", "freshPersonal");
        yield* connect(bob, "user", "stalePersonal");
        yield* lastChecked(db, "freshOrg", "healthy", 10 * MINUTE);
        yield* lastChecked(db, "staleOrg", "healthy", ORG_CHECK_INTERVAL_MS);
        // Two hours is stale for the workspace, fresh for a personal connection.
        yield* lastChecked(db, "freshPersonal", "healthy", 2 * 60 * MINUTE);
        yield* lastChecked(db, "stalePersonal", "healthy", USER_CHECK_INTERVAL_MS);

        const summary = yield* run();

        expect(checks.map((c) => `${c.as}:${c.name}`).sort()).toEqual([
          "bob:stalePersonal",
          "svc:neverChecked",
          "svc:staleOrg",
        ]);
        expect(summary).toEqual({ checked: 3, reported: 0 });
      }),
    ),
  );

  it.effect("counts a verdict written just after the last pass as due on the next", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const { org, alice, checks, run } = yield* setup(db);
        yield* connect(org, "org", "almostAnHour");
        yield* connect(alice, "user", "almostSixHours");
        // The hourly pass found these a few minutes after the last one wrote them.
        yield* lastChecked(db, "almostAnHour", "healthy", ORG_CHECK_INTERVAL_MS - 3 * MINUTE);
        yield* lastChecked(db, "almostSixHours", "healthy", USER_CHECK_INTERVAL_MS - 3 * MINUTE);

        yield* run();

        expect(checks.map((c) => c.name).sort()).toEqual(["almostAnHour", "almostSixHours"]);
      }),
    ),
  );

  it.effect("refreshes tokens that would expire before the owner's next check", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const { org, alice, checks, run } = yield* setup(db);
        yield* connect(org, "org", "shared");
        yield* connect(alice, "user", "mine");

        yield* run();

        expect(checks.find((c) => c.name === "shared")?.within).toBe(ORG_CHECK_INTERVAL_MS);
        expect(checks.find((c) => c.name === "mine")?.within).toBe(USER_CHECK_INTERVAL_MS);
      }),
    ),
  );

  it.effect("reports a failing workspace connection and a member's recovered one", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const { world, org, alice, events, run } = yield* setup(db);
        yield* connect(org, "org", "shared");
        yield* connect(alice, "user", "mine");
        yield* lastChecked(db, "mine", "expired", USER_CHECK_INTERVAL_MS);
        world.verdicts.set("shared", "expired");

        const summary = yield* run();

        expect(summary).toEqual({ checked: 2, reported: 2 });
        const byName = new Map(events.map((e) => [e.connection.name, e]));
        expect(byName.get("shared")).toMatchObject({
          tenant: TENANT,
          connection: {
            owner: "org",
            subject: null,
            integration: "probe",
            integrationName: "Probe Service",
            name: "shared",
          },
          previous: null,
          current: { status: "expired", detail: "probe" },
        });
        expect(byName.get("mine")).toMatchObject({
          connection: { owner: "user", subject: "alice", name: "mine" },
          previous: "expired",
          current: { status: "healthy" },
        });
      }),
    ),
  );

  it.effect("persists each verdict, so the next pass does not check it again", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const { org, checks, run } = yield* setup(db);
        yield* connect(org, "org", "shared");

        yield* run();
        yield* run();

        expect(checks.map((c) => c.name)).toEqual(["shared"]);
      }),
    ),
  );

  it.effect("a check that fails is skipped without costing the others theirs", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const { org, world, events, run } = yield* setup(db);
        yield* connect(org, "org", "broken");
        yield* connect(org, "org", "shared");
        world.verdicts.set("shared", "expired");
        const failing = withCheckHealth(org, (ref: ConnectionRef, options) =>
          String(ref.name) === "broken"
            ? Effect.fail(new StorageError({ message: "D1 down", cause: undefined }))
            : org.connections.checkHealth(ref, options),
        );

        const summary = yield* run({ org: failing });

        expect(summary).toEqual({ checked: 1, reported: 1 });
        expect(events.map((e) => e.connection.name)).toEqual(["shared"]);
      }),
    ),
  );
});

describe("shouldReport", () => {
  const verdict = (status: HealthStatus, detail?: string): HealthCheckResult => ({
    status,
    checkedAt: 0,
    ...(detail === undefined ? {} : { detail }),
  });
  const toolSync: HealthCheckResult = {
    status: "expired",
    checkedAt: 0,
    reason: "tool_sync_failed",
  };

  it.each([
    ["never checked, now failing", null, verdict("expired"), true],
    ["still failing", verdict("expired"), verdict("expired"), true],
    ["newly misconfigured", verdict("healthy"), verdict("misconfigured"), true],
    ["newly degraded", verdict("healthy"), verdict("degraded"), true],
    ["recovered", verdict("expired"), verdict("healthy"), true],
    ["still healthy", verdict("healthy"), verdict("healthy"), false],
    ["first check healthy", null, verdict("healthy"), false],
    ["cannot probe, then healthy", verdict("unknown"), verdict("healthy"), false],
    ["healthy, then cannot probe", verdict("healthy"), verdict("unknown"), false],
    ["a failed tool sync, not the credential", verdict("healthy"), toolSync, false],
    ["recovered from a failed tool sync", toolSync, verdict("healthy"), false],
  ] as const)("%s", (_, previous, current, expected) => {
    expect(shouldReport(previous, current)).toBe(expected);
  });
});
