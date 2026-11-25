import { readFileSync } from "node:fs";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";

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
  type Executor,
} from "@executor-js/sdk";
import {
  createSqliteTestFumaDb,
  memoryCredentialsPlugin,
  type SqliteTestFumaDb,
} from "@executor-js/sdk/testing";

import { connectionHealthSnapshot } from "./read";
import { ConnectionHealthSnapshot } from "./snapshot";
import { INACTIVE_MEMBER_MS } from "./sweep";

const encodeSnapshotJson = Schema.encodeSync(Schema.fromJsonString(ConnectionHealthSnapshot));
const decodeSnapshotJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(ConnectionHealthSnapshot),
);

const TENANT = "acme";
const INTEG = IntegrationSlug.make("probe");
const TEMPLATE = AuthTemplateSlug.make("apiKey");
const MINUTE = 60_000;
const CONFIG = {
  organizationId: TENANT,
  organizationSlug: "default",
  webBaseUrl: "https://console.test",
};
// A frozen clock: the read takes `now`, so ages are exact.
const NOW = Date.parse("2026-11-10T12:00:00Z");

const makeWorld = () => {
  const plugin = definePlugin(() => ({
    id: "probe" as const,
    storage: () => ({}),
    resolveTools: () =>
      Effect.succeed({ tools: [{ name: ToolName.make("ping"), description: "ping" }] }),
    invokeTool: () => Effect.succeed({ ok: true }),
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
  return { plugins: [plugin, memoryCredentialsPlugin()] as const };
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

const sql = (db: SqliteTestFumaDb, statement: string, args: (string | number | null)[]) =>
  Effect.promise(() => db.client.execute({ sql: statement, args }));

/** Record a verdict on a connection, as a sweep pass would have. */
const recordHealth = (
  db: SqliteTestFumaDb,
  name: string,
  health: { status: string; reason?: string; checkedAt: number },
) =>
  sql(db, "UPDATE connection SET last_health = ? WHERE name = ?", [JSON.stringify(health), name]);

/** A member as the platform view lists them, last seen `ageMs` before `NOW`. */
const member = (db: SqliteTestFumaDb, externalId: string, seenAgeMs = 0) =>
  sql(
    db,
    "INSERT INTO subject (row_id, tenant, external_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
    [
      `s-${externalId}`,
      TENANT,
      externalId,
      Math.floor((NOW - seenAgeMs) / 1000),
      String(NOW - seenAgeMs),
    ],
  );

const setup = (db: SqliteTestFumaDb) =>
  Effect.gen(function* () {
    const world = makeWorld();
    const org = yield* executorAs(world, db, "svc");
    yield* org.probe.seed();
    const platform = yield* executorAs(world, db, null);
    const read = (executor: Executor = platform) => connectionHealthSnapshot(executor, CONFIG, NOW);
    return { world, org, platform, read };
  });

/** A member who connected, with the last-seen time fixed after the connect. */
const memberWith = (
  world: World,
  db: SqliteTestFumaDb,
  externalId: string,
  names: readonly string[],
  seenAgeMs = 0,
) =>
  Effect.gen(function* () {
    yield* member(db, externalId, seenAgeMs);
    const executor = yield* executorAs(world, db, externalId);
    for (const name of names) yield* connect(executor, "user", name);
    yield* sql(db, "UPDATE subject SET last_seen_at = ? WHERE external_id = ?", [
      String(NOW - seenAgeMs),
      externalId,
    ]);
  });

const healthy = { status: "healthy", checkedAt: NOW - 5 * MINUTE };

describe("connectionHealthSnapshot", () => {
  it.effect("holds the stored verdicts of the workspace and of active members", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const { world, org, read } = yield* setup(db);
        yield* connect(org, "org", "shared");
        yield* recordHealth(db, "shared", {
          status: "expired",
          reason: "credential_refresh_rejected",
          checkedAt: NOW - 20 * MINUTE,
        });
        yield* memberWith(world, db, "alice", ["mine"]);
        yield* recordHealth(db, "mine", healthy);

        const snapshot = yield* read();

        expect(snapshot.tenant).toBe(TENANT);
        expect(snapshot.verdicts).toEqual([
          {
            owner: "org",
            subject: null,
            integration: "probe",
            integrationName: "Probe Service",
            name: "shared",
            url: "https://console.test/default/integrations/probe",
            evidence: "failing",
            status: "expired",
            reason: "credential_refresh_rejected",
            checkedAt: NOW - 20 * MINUTE,
          },
          {
            owner: "user",
            subject: "alice",
            integration: "probe",
            integrationName: "Probe Service",
            name: "mine",
            url: "https://console.test/default/integrations/probe",
            evidence: "healthy",
            status: "healthy",
            reason: null,
            checkedAt: NOW - 5 * MINUTE,
          },
        ]);
        expect(JSON.stringify(snapshot)).not.toContain("httpStatus");
      }),
    ),
  );

  it.effect("omits a connection that was never checked", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const { world, org, read } = yield* setup(db);
        yield* connect(org, "org", "neverChecked");
        yield* connect(org, "org", "checked");
        yield* recordHealth(db, "checked", healthy);
        yield* memberWith(world, db, "alice", ["neverCheckedPersonal"]);

        const snapshot = yield* read();

        expect(snapshot.verdicts.map((v) => v.name)).toEqual(["checked"]);
      }),
    ),
  );

  it.effect("omits members not seen for a month, keeping one exactly at the limit", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const { world, read } = yield* setup(db);
        // The sweep skips a member only once strictly past the limit, so the
        // read agrees with it: at the limit is still active.
        yield* memberWith(world, db, "atLimit", ["atLimitConn"], INACTIVE_MEMBER_MS);
        yield* memberWith(world, db, "pastLimit", ["pastLimitConn"], INACTIVE_MEMBER_MS + 1);
        yield* memberWith(world, db, "departed", ["departedConn"], 90 * 24 * 60 * MINUTE);
        for (const name of ["atLimitConn", "pastLimitConn", "departedConn"]) {
          yield* recordHealth(db, name, healthy);
        }

        const snapshot = yield* read();

        expect(snapshot.verdicts.map((v) => v.subject)).toEqual(["atLimit"]);
      }),
    ),
  );

  it.effect("ages out a member recorded a month ago and never seen", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const { world, read } = yield* setup(db);
        yield* memberWith(world, db, "dave", ["unseen"]);
        yield* sql(
          db,
          "UPDATE subject SET last_seen_at = NULL, created_at = ? WHERE external_id = ?",
          [Math.floor((NOW - INACTIVE_MEMBER_MS - 1000) / 1000) - 1, "dave"],
        );
        yield* recordHealth(db, "unseen", healthy);

        expect((yield* read()).verdicts).toEqual([]);
      }),
    ),
  );

  it.effect("keeps a recorded dead grant failing whatever its age", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const { org, read } = yield* setup(db);
        yield* connect(org, "org", "dead");
        // Recorded when the grant died; no later check will move it.
        const frozen = NOW - 20 * 24 * 60 * MINUTE;
        yield* recordHealth(db, "dead", {
          status: "expired",
          reason: "credential_refresh_rejected",
          checkedAt: frozen,
        });

        const [verdict] = (yield* read()).verdicts;

        expect(verdict).toMatchObject({
          evidence: "failing",
          status: "expired",
          checkedAt: frozen,
        });
      }),
    ),
  );

  it.effect("names an integration by its slug when it has no display name", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const { org, platform, read } = yield* setup(db);
        yield* connect(org, "org", "orphan");
        yield* recordHealth(db, "orphan", healthy);
        const unnamed: Executor = {
          ...platform,
          integrations: { ...platform.integrations, list: () => Effect.succeed([]) },
        };

        const [verdict] = (yield* read(unnamed)).verdicts;

        expect(verdict).toMatchObject({ integration: "probe", integrationName: "probe" });
      }),
    ),
  );

  it.effect("reads every page of members, past one full admin page", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const { world, read } = yield* setup(db);
        const many = ADMIN_MAX_PAGE_SIZE + 10;
        const id = (i: number) => `m${String(i).padStart(4, "0")}`;
        for (let i = 0; i < many; i++) yield* member(db, id(i));
        for (const i of [0, ADMIN_MAX_PAGE_SIZE - 1, ADMIN_MAX_PAGE_SIZE, many - 1]) {
          yield* connect(yield* executorAs(world, db, id(i)), "user", `conn${i}`);
          yield* recordHealth(db, `conn${i}`, healthy);
        }

        const snapshot = yield* read();

        expect(snapshot.verdicts.map((v) => v.subject).sort()).toEqual(
          [0, ADMIN_MAX_PAGE_SIZE - 1, ADMIN_MAX_PAGE_SIZE, many - 1].map(id),
        );
      }),
    ),
  );

  describe("fails rather than answering partially", () => {
    const failing = new StorageError({ message: "D1 down", cause: undefined });

    it.effect("when the workspace connections cannot be read", () =>
      withDb((db) =>
        Effect.gen(function* () {
          const { platform, read } = yield* setup(db);
          const broken: Executor = {
            ...platform,
            connections: { ...platform.connections, list: () => Effect.fail(failing) },
          };

          expect(Exit.isFailure(yield* Effect.exit(read(broken)))).toBe(true);
        }),
      ),
    );

    it.effect("when the integrations cannot be read", () =>
      withDb((db) =>
        Effect.gen(function* () {
          const { platform, read } = yield* setup(db);
          const broken: Executor = {
            ...platform,
            integrations: { ...platform.integrations, list: () => Effect.fail(failing) },
          };

          expect(Exit.isFailure(yield* Effect.exit(read(broken)))).toBe(true);
        }),
      ),
    );

    it.effect("when a later page of members cannot be read", () =>
      withDb((db) =>
        Effect.gen(function* () {
          const { org, platform, read } = yield* setup(db);
          yield* connect(org, "org", "shared");
          yield* recordHealth(db, "shared", healthy);
          for (let i = 0; i < ADMIN_MAX_PAGE_SIZE + 1; i++) yield* member(db, `m${i}`);
          const admin = platform.admin!;
          const broken: Executor = {
            ...platform,
            admin: {
              ...admin,
              listSubjectsWithConnections: (options) =>
                (options?.offset ?? 0) > 0
                  ? Effect.fail(failing)
                  : admin.listSubjectsWithConnections(options),
            },
          };

          expect(Exit.isFailure(yield* Effect.exit(read(broken)))).toBe(true);
        }),
      ),
    );
  });

  it.effect("produces what the contract's schema decodes", () =>
    withDb((db) =>
      Effect.gen(function* () {
        const { world, org, read } = yield* setup(db);
        yield* connect(org, "org", "shared");
        yield* recordHealth(db, "shared", { status: "expired", checkedAt: NOW });
        yield* memberWith(world, db, "alice", ["mine"]);
        yield* recordHealth(db, "mine", healthy);

        const snapshot = yield* read();

        expect(decodeSnapshotJson(encodeSnapshotJson(snapshot))).toEqual(snapshot);
      }),
    ),
  );
});

describe("the contract fixture", () => {
  it("decodes, and carries neither observedAt nor httpStatus", () => {
    const text = readFileSync(new URL("./snapshot.fixture.json", import.meta.url), "utf8");
    const fixture = decodeSnapshotJson(text);

    expect(fixture.verdicts.map((v) => [v.owner, v.evidence, v.status])).toEqual([
      ["org", "failing", "expired"],
      ["user", "healthy", "healthy"],
      ["org", "inconclusive", "unknown"],
    ]);
    expect(text).not.toContain("observedAt");
    expect(text).not.toContain("httpStatus");
  });
});
