import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  ADMIN_MAX_PAGE_SIZE,
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
  INACTIVE_MEMBER_MS,
  OWNER_START_DEADLINE_MS,
  sweepConnectionHealth,
} from "./sweep";

const ORG_CHECK_INTERVAL_MS = CHECK_INTERVAL_MS.org;
const USER_CHECK_INTERVAL_MS = CHECK_INTERVAL_MS.user;

const TENANT = "acme";
const INTEG = IntegrationSlug.make("probe");
const TEMPLATE = AuthTemplateSlug.make("apiKey");
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

// The probe answers whatever the test set for the connection's name, so each
// case controls a connection's verdict without an upstream.
const makeWorld = () => {
  const verdicts = new Map<string, Omit<HealthCheckResult, "checkedAt">>();
  const plugin = definePlugin(() => ({
    id: "probe" as const,
    storage: () => ({}),
    resolveTools: () =>
      Effect.succeed({ tools: [{ name: ToolName.make("ping"), description: "ping" }] }),
    invokeTool: () => Effect.succeed({ ok: true }),
    checkHealth: ({ credential }) =>
      Effect.sync(
        (): HealthCheckResult => ({
          status: "healthy",
          detail: "probe",
          ...verdicts.get(String(credential.connection)),
          checkedAt: Date.now(),
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
 *  records when the member reaches the executor. */
const member = (db: SqliteTestFumaDb, externalId: string) =>
  Effect.promise(() =>
    db.client.execute({
      sql: "INSERT INTO subject (row_id, tenant, external_id, created_at) VALUES (?, ?, ?, ?)",
      // `created_at` is a timestamp column, stored in seconds.
      args: [`s-${externalId}`, TENANT, externalId, Math.floor(Date.now() / 1000)],
    }),
  );

const decodeStored = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      status: Schema.String,
      reason: Schema.optional(Schema.String),
      checkedAt: Schema.Number,
    }),
  ),
);

/** The connection's stored verdict, as the sweep left it. */
const storedVerdict = (db: SqliteTestFumaDb, name: string) =>
  Effect.promise(async () => {
    const result = await db.client.execute({
      sql: "SELECT last_health FROM connection WHERE name = ?",
      args: [name],
    });
    const raw = result.rows[0]?.last_health;
    if (raw == null) return undefined;
    // The column is a JSON blob.
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw as ArrayBuffer);
    return decodeStored(text);
  });

/** The workspace, its members, and the checks each executor received. */
const setup = (db: SqliteTestFumaDb, options?: { readonly failingMember?: string }) =>
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
    const asMember = (subject: string) =>
      subject === options?.failingMember
        ? Effect.fail(new StorageError({ message: "D1 down", cause: undefined }))
        : executorAs(world, db, subject).pipe(
            Effect.map((executor) => recording(subject, executor)),
          );
    const run = (overrides?: { readonly org?: Executor; readonly now?: () => number }) =>
      sweepConnectionHealth({
        org: overrides?.org ?? recording("svc", org),
        admin: platform.admin!,
        asMember,
        consoleUrl: (integration) => `https://console.test/default/integrations/${integration}`,
        now: overrides?.now ?? Date.now,
      });
    return { world, org, alice, bob, checks, run };
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
        expect(summary).toEqual({
          due: 3,
          checked: 3,
          inactiveMembers: 0,
          failedOwners: 0,
          deferredOwners: 0,
        });
      }),
    ),
  );

  it.effect("counts a verdict written just after the last pass as due on the next", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const { org, alice, checks, run } = yield* setup(db);
        yield* connect(org, "org", "almostAnHour");
        yield* connect(alice, "user", "almostSixHours");
        yield* lastChecked(db, "almostAnHour", "healthy", ORG_CHECK_INTERVAL_MS - 14 * MINUTE);
        yield* lastChecked(db, "almostSixHours", "healthy", USER_CHECK_INTERVAL_MS - 14 * MINUTE);
        yield* connect(org, "org", "tooSoon");
        yield* lastChecked(db, "tooSoon", "healthy", ORG_CHECK_INTERVAL_MS - 16 * MINUTE);

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

  it.effect("stores each verdict on its connection", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const { world, org, alice, run } = yield* setup(db);
        yield* connect(org, "org", "shared");
        yield* connect(alice, "user", "mine");
        world.verdicts.set("shared", {
          status: "expired",
          reason: "credential_refresh_rejected",
          detail: "invalid_grant: Grant not found",
        });

        yield* run();

        expect(yield* storedVerdict(db, "shared")).toMatchObject({
          status: "expired",
          reason: "credential_refresh_rejected",
          checkedAt: expect.any(Number),
        });
        expect(yield* storedVerdict(db, "mine")).toMatchObject({ status: "healthy" });
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

  it.effect("a check that fails is left out without costing the others theirs", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const { org, world, run } = yield* setup(db);
        yield* connect(org, "org", "broken");
        yield* connect(org, "org", "shared");
        world.verdicts.set("shared", { status: "expired" });
        const failing = withCheckHealth(org, (ref: ConnectionRef, options) =>
          String(ref.name) === "broken"
            ? Effect.fail(new StorageError({ message: "D1 down", cause: undefined }))
            : org.connections.checkHealth(ref, options),
        );

        const summary = yield* run({ org: failing });

        expect(summary).toEqual({
          due: 2,
          checked: 1,
          inactiveMembers: 0,
          failedOwners: 0,
          deferredOwners: 0,
        });
        expect(yield* storedVerdict(db, "broken")).toBeUndefined();
        expect((yield* storedVerdict(db, "shared"))?.status).toBe("expired");
      }),
    ),
  );

  it.effect("a member whose executor cannot be built is skipped, not the whole pass", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const { alice, bob, run } = yield* setup(db, { failingMember: "alice" });
        yield* connect(alice, "user", "hers");
        yield* connect(bob, "user", "his");

        const summary = yield* run();

        expect(summary).toEqual({
          due: 2,
          checked: 1,
          inactiveMembers: 0,
          failedOwners: 1,
          deferredOwners: 0,
        });
        expect(yield* storedVerdict(db, "his")).toBeDefined();
        expect(yield* storedVerdict(db, "hers")).toBeUndefined();
      }),
    ),
  );

  it.effect("skips members not seen for a month, so their credentials are not kept alive", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const { run, world } = yield* setup(db);
        yield* member(db, "carol");
        yield* connect(yield* executorAs(world, db, "carol"), "user", "stale");
        // Last seen a month and a day ago, after the connect that counted as a sighting.
        yield* Effect.promise(() =>
          db.client.execute({
            sql: "UPDATE subject SET last_seen_at = ? WHERE external_id = ?",
            args: [String(Date.now() - INACTIVE_MEMBER_MS - DAY), "carol"],
          }),
        );

        const summary = yield* run();

        expect(summary.inactiveMembers).toBe(1);
        expect(yield* storedVerdict(db, "stale")).toBeUndefined();
      }),
    ),
  );

  it.effect("ages out a member who was recorded a month ago and never seen", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const { run, world } = yield* setup(db);
        yield* member(db, "dave");
        yield* connect(yield* executorAs(world, db, "dave"), "user", "unseen");
        yield* Effect.promise(() =>
          db.client.execute({
            sql: "UPDATE subject SET last_seen_at = NULL, created_at = ? WHERE external_id = ?",
            args: [Math.floor((Date.now() - INACTIVE_MEMBER_MS - DAY) / 1000), "dave"],
          }),
        );

        const summary = yield* run();

        expect(summary.inactiveMembers).toBe(1);
        expect(yield* storedVerdict(db, "unseen")).toBeUndefined();
      }),
    ),
  );

  it.effect("pages through every member, past one full admin page", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const { run, world } = yield* setup(db);
        const many = ADMIN_MAX_PAGE_SIZE + 10;
        for (let i = 0; i < many; i++) yield* member(db, `m${String(i).padStart(3, "0")}`);
        const last = `m${String(many - 1).padStart(3, "0")}`;
        yield* connect(yield* executorAs(world, db, last), "user", "lastMembers");

        yield* run();

        expect(yield* storedVerdict(db, "lastMembers")).toBeDefined();
      }),
    ),
  );

  it.effect("starts no further owner once the pass has run for 10 minutes", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const { org, alice, bob, checks, run } = yield* setup(db);
        yield* connect(org, "org", "shared");
        yield* connect(alice, "user", "hers");
        yield* connect(bob, "user", "his");
        // A workspace check that takes the whole budget, by the injected clock.
        let clock = Date.now();
        const slow = withCheckHealth(org, (ref, options) => {
          clock += OWNER_START_DEADLINE_MS;
          return org.connections.checkHealth(ref, options);
        });

        const summary = yield* run({ org: slow, now: () => clock });

        expect(checks).toEqual([]);
        expect(yield* storedVerdict(db, "shared")).toBeDefined();
        expect(yield* storedVerdict(db, "hers")).toBeUndefined();
        expect(yield* storedVerdict(db, "his")).toBeUndefined();
        expect(summary).toEqual({
          due: 3,
          checked: 1,
          inactiveMembers: 0,
          failedOwners: 0,
          deferredOwners: 2,
        });

        // The deferred owners are still due, and the next pass takes them.
        const next = yield* run();
        expect(next).toMatchObject({ checked: 2, deferredOwners: 0 });
        expect(checks.map((c) => c.name).sort()).toEqual(["his", "hers"].sort());
      }),
    ),
  );

  it.effect("still starts an owner one millisecond before the deadline", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const { org, alice, run } = yield* setup(db);
        yield* connect(org, "org", "shared");
        yield* connect(alice, "user", "hers");
        let clock = Date.now();
        const slow = withCheckHealth(org, (ref, options) => {
          clock += OWNER_START_DEADLINE_MS - 1;
          return org.connections.checkHealth(ref, options);
        });

        const summary = yield* run({ org: slow, now: () => clock });

        expect(summary).toMatchObject({ checked: 2, deferredOwners: 0 });
      }),
    ),
  );

  it.effect("does not count an owner with nothing due as deferred", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const { org, alice, run } = yield* setup(db);
        yield* connect(org, "org", "shared");
        yield* connect(alice, "user", "fresh");
        yield* lastChecked(db, "fresh", "healthy", MINUTE);
        let clock = Date.now();
        const slow = withCheckHealth(org, (ref, options) => {
          clock += OWNER_START_DEADLINE_MS;
          return org.connections.checkHealth(ref, options);
        });

        const summary = yield* run({ org: slow, now: () => clock });

        expect(summary).toMatchObject({ checked: 1, deferredOwners: 0 });
      }),
    ),
  );
});
