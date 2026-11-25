import { readFileSync } from "node:fs";

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

import { ConnectionHealthSnapshot, type ConnectionHealthVerdict } from "./snapshot";
import { CHECK_INTERVAL_MS, INACTIVE_MEMBER_MS, sweepConnectionHealth } from "./sweep";

const decodeSnapshot = Schema.decodeUnknownSync(Schema.fromJsonString(ConnectionHealthSnapshot));
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

/** The workspace, its members, the checks each executor received, and the
 *  snapshots the sweep reported. */
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
    const snapshots: ConnectionHealthSnapshot[] = [];
    const run = (overrides?: { readonly org?: Executor }) =>
      sweepConnectionHealth({
        tenant: TENANT,
        org: overrides?.org ?? recording("svc", org),
        admin: platform.admin!,
        asMember,
        consoleUrl: (integration) => `https://console.test/default/integrations/${integration}`,
        report: (snapshot) => Effect.sync(() => void snapshots.push(snapshot)),
        now: Date.now,
      });
    const verdictOf = (name: string): ConnectionHealthVerdict | undefined =>
      snapshots.at(-1)?.verdicts.find((v) => v.name === name);
    return { world, org, alice, bob, checks, snapshots, verdictOf, run };
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
        expect(summary).toEqual({ due: 3, checked: 3, inactiveMembers: 0, failedOwners: 0 });
      }),
    ),
  );

  it.effect("counts a verdict written just after the last pass as due on the next", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const { org, alice, checks, run } = yield* setup(db);
        yield* connect(org, "org", "almostAnHour");
        yield* connect(alice, "user", "almostSixHours");
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

  it.effect("reports one snapshot of every checked connection, healthy ones included", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const { world, org, alice, snapshots, verdictOf, run } = yield* setup(db);
        yield* connect(org, "org", "shared");
        yield* connect(alice, "user", "mine");
        world.verdicts.set("shared", {
          status: "expired",
          reason: "credential_refresh_rejected",
          httpStatus: 400,
          detail: "invalid_grant: Grant not found",
        });

        yield* run();

        expect(snapshots).toHaveLength(1);
        expect(snapshots[0]).toMatchObject({ tenant: TENANT, observedAt: expect.any(Number) });
        expect(verdictOf("shared")).toEqual({
          owner: "org",
          subject: null,
          integration: "probe",
          integrationName: "Probe Service",
          name: "shared",
          url: "https://console.test/default/integrations/probe",
          evidence: "failing",
          status: "expired",
          reason: "credential_refresh_rejected",
          httpStatus: 400,
          checkedAt: expect.any(Number),
        });
        expect(verdictOf("mine")).toMatchObject({
          owner: "user",
          subject: "alice",
          evidence: "healthy",
          status: "healthy",
          reason: null,
          httpStatus: null,
        });
        expect(JSON.stringify(snapshots)).not.toContain("Grant not found");
      }),
    ),
  );

  it.effect("reports even when nothing was due, so a lost pass is repaired by the next", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const { org, snapshots, run } = yield* setup(db);
        yield* connect(org, "org", "shared");
        yield* lastChecked(db, "shared", "healthy", MINUTE);

        yield* run();

        expect(snapshots).toEqual([
          { tenant: TENANT, observedAt: expect.any(Number), verdicts: [] },
        ]);
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
        const { org, world, verdictOf, run } = yield* setup(db);
        yield* connect(org, "org", "broken");
        yield* connect(org, "org", "shared");
        world.verdicts.set("shared", { status: "expired" });
        const failing = withCheckHealth(org, (ref: ConnectionRef, options) =>
          String(ref.name) === "broken"
            ? Effect.fail(new StorageError({ message: "D1 down", cause: undefined }))
            : org.connections.checkHealth(ref, options),
        );

        const summary = yield* run({ org: failing });

        expect(summary).toEqual({ due: 2, checked: 1, inactiveMembers: 0, failedOwners: 0 });
        expect(verdictOf("broken")).toBeUndefined();
        expect(verdictOf("shared")?.evidence).toBe("failing");
      }),
    ),
  );

  it.effect("a member whose executor cannot be built is skipped, not the whole pass", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const { alice, bob, verdictOf, run } = yield* setup(db, { failingMember: "alice" });
        yield* connect(alice, "user", "hers");
        yield* connect(bob, "user", "his");

        const summary = yield* run();

        expect(summary).toEqual({ due: 2, checked: 1, inactiveMembers: 0, failedOwners: 1 });
        expect(verdictOf("his")?.subject).toBe("bob");
      }),
    ),
  );

  it.effect("skips members not seen for a month, so their credentials are not kept alive", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const { verdictOf, run, world } = yield* setup(db);
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
        expect(verdictOf("stale")).toBeUndefined();
      }),
    ),
  );

  it.effect("ages out a member who was recorded a month ago and never seen", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const { verdictOf, run, world } = yield* setup(db);
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
        expect(verdictOf("unseen")).toBeUndefined();
      }),
    ),
  );

  it.effect("pages through every member, past one full admin page", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const { verdictOf, run, world } = yield* setup(db);
        const many = ADMIN_MAX_PAGE_SIZE + 10;
        for (let i = 0; i < many; i++) yield* member(db, `m${String(i).padStart(3, "0")}`);
        const last = `m${String(many - 1).padStart(3, "0")}`;
        yield* connect(yield* executorAs(world, db, last), "user", "lastMembers");

        yield* run();

        expect(verdictOf("lastMembers")?.subject).toBe(last);
      }),
    ),
  );

  it.effect("speaks the contract the receiver's fixture pins", () =>
    Effect.sync(() => {
      const fixture = decodeSnapshot(
        readFileSync(new URL("./snapshot.fixture.json", import.meta.url), "utf8"),
      );
      expect(fixture.verdicts.map((v) => [v.owner, v.evidence, v.status])).toEqual([
        ["org", "failing", "expired"],
        ["user", "healthy", "healthy"],
        ["org", "inconclusive", "unknown"],
      ]);
    }),
  );

  it.effect("reports a snapshot the contract accepts", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const { world, org, alice, snapshots, run } = yield* setup(db);
        yield* connect(org, "org", "shared");
        yield* connect(alice, "user", "mine");
        world.verdicts.set("shared", { status: "expired", reason: "credential_refresh_rejected" });

        yield* run();

        expect(decodeSnapshot(JSON.stringify(snapshots[0]))).toEqual(snapshots[0]);
      }),
    ),
  );
});
