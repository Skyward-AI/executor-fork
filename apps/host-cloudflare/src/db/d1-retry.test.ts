import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";

import {
  D1CallError,
  classifyD1Failure,
  isReadOnlySql,
  retryTransientD1Call,
  withD1TransientRetry,
} from "./d1-retry";

const bindingRejection = (message: string): Error =>
  // oxlint-disable-next-line executor/no-error-constructor -- test double: the D1 binding rejects with a plain Error carrying the documented message
  new Error(message);

const INCIDENT_ERROR = "D1_ERROR: internal error; reference = 6kq3v9j0mmpdu3qgcsbmz2ib";
const UNREACHABLE_ERROR = "D1_ERROR: Cannot resolve D1 DB due to transient issue on remote node.";
const CONSTRAINT_ERROR = "D1_ERROR: UNIQUE constraint failed: integration.slug: SQLITE_CONSTRAINT";

const failingCall = (failures: readonly string[], success: string) => {
  const calls = { count: 0 };
  const call = (): Promise<string> => {
    calls.count += 1;
    const failure = failures[calls.count - 1];
    return failure === undefined
      ? Promise.resolve(success)
      : // oxlint-disable-next-line executor/no-promise-reject -- test double: a D1 call that rejects like the binding does
        Promise.reject(bindingRejection(failure));
  };
  return { call, calls };
};

const runWithVirtualTime = <A>(effect: Effect.Effect<A, unknown>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(Effect.exit(effect));
    yield* TestClock.adjust(Duration.seconds(30));
    return yield* Fiber.join(fiber);
  });

describe("classifyD1Failure", () => {
  it.each([
    [INCIDENT_ERROR, "maybe-executed"],
    ["D1_ERROR: Network connection lost.", "maybe-executed"],
    ["D1_ERROR: Replica disconnected from primary.", "maybe-executed"],
    ["D1_ERROR: Internal error in D1 DB storage caused object to be reset.", "maybe-executed"],
    ["D1_ERROR: D1 DB reset because its code was updated.", "maybe-executed"],
    ["D1_ERROR: Can't read from request stream because client disconnected.", "maybe-executed"],
    ["D1_ERROR: D1 DB is overloaded. Requests queued for too long.", "maybe-executed"],
    [UNREACHABLE_ERROR, "not-executed"],
    [
      "D1_ERROR: Internal error while starting up D1 DB storage caused object to be reset.",
      "not-executed",
    ],
    ["D1_ERROR: D1 DB is overloaded. Too many requests queued.", "not-executed"],
    [CONSTRAINT_ERROR, "permanent"],
    ['D1_ERROR: near "SELEC": syntax error at offset 0: SQLITE_ERROR', "permanent"],
    ["D1_ERROR: no such table: integration: SQLITE_ERROR", "permanent"],
    ["D1_ERROR: No SQL statements detected.", "permanent"],
    ["D1_ERROR: Exceeded maximum DB size.", "permanent"],
    [
      "D1_ERROR: D1 DB storage operation exceeded timeout which caused object to be reset.",
      "permanent",
    ],
    ["D1_ERROR: D1 DB's isolate exceeded its memory limit and was reset.", "permanent"],
    ["D1_ERROR: D1 DB exceeded its CPU time limit and was reset.", "permanent"],
    ["D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'", "permanent"],
    ["internal error", "permanent"],
  ])("%s -> %s", (message, expected) => {
    expect(classifyD1Failure(bindingRejection(message))).toBe(expected);
  });

  it("reads the documented message from the error cause", () => {
    // oxlint-disable-next-line executor/no-error-constructor -- test double: drizzle wraps the binding error as the cause of its own query error
    const wrapped = new Error("Failed query: select 1", {
      cause: bindingRejection(INCIDENT_ERROR),
    });
    expect(classifyD1Failure(wrapped)).toBe("maybe-executed");
  });

  it("treats a non-error rejection as permanent", () => {
    expect(classifyD1Failure("D1_ERROR: internal error")).toBe("permanent");
  });
});

describe("isReadOnlySql", () => {
  it.each([
    ['select "id" from "integration" where "tenant" = ?', true],
    ["  WITH t AS (SELECT 1) SELECT * FROM t", true],
    ["EXPLAIN QUERY PLAN SELECT 1", true],
    ['insert into "integration" ("id") values (?)', false],
    ['update "integration" set "name" = ?', false],
    ["WITH t AS (SELECT 1) DELETE FROM integration", false],
    ["CREATE TABLE IF NOT EXISTS t (id text)", false],
    ["PRAGMA table_info('connection')", false],
  ])("%s -> %s", (sql, expected) => {
    expect(isReadOnlySql(sql)).toBe(expected);
  });
});

describe("retryTransientD1Call", () => {
  it.effect("succeeds on the fifth attempt after four transient failures of a read", () =>
    Effect.gen(function* () {
      const { call, calls } = failingCall(
        [INCIDENT_ERROR, INCIDENT_ERROR, INCIDENT_ERROR, INCIDENT_ERROR],
        "rows",
      );

      const exit = yield* runWithVirtualTime(retryTransientD1Call("all", true, call));

      expect(exit).toEqual(Exit.succeed("rows"));
      expect(calls.count).toBe(5);
    }),
  );

  it.effect("rides out a 16 second outage of a read", () =>
    Effect.gen(function* () {
      const outage = { down: true };
      const call = (): Promise<string> =>
        outage.down
          ? // oxlint-disable-next-line executor/no-promise-reject -- test double: a D1 call that rejects like the binding does
            Promise.reject(bindingRejection(INCIDENT_ERROR))
          : Promise.resolve("rows");

      const fiber = yield* Effect.forkChild(Effect.exit(retryTransientD1Call("all", true, call)));
      yield* TestClock.adjust(Duration.seconds(16));
      outage.down = false;
      yield* TestClock.adjust(Duration.seconds(4));
      const exit = yield* Fiber.join(fiber);

      expect(exit).toEqual(Exit.succeed("rows"));
    }),
  );

  it.effect("gives up once the retry budget is spent and surfaces the original error", () =>
    Effect.gen(function* () {
      const calls = { count: 0 };
      const call = (): Promise<string> => {
        calls.count += 1;
        // oxlint-disable-next-line executor/no-promise-reject -- test double: a D1 call that rejects like the binding does
        return Promise.reject(bindingRejection(INCIDENT_ERROR));
      };

      const exit = yield* runWithVirtualTime(retryTransientD1Call("all", true, call));

      expect(exit).toEqual(Exit.fail(new D1CallError({ cause: bindingRejection(INCIDENT_ERROR) })));
      expect(calls.count).toBeGreaterThan(5);
      expect(calls.count).toBeLessThan(25);
    }),
  );

  it.effect("does not retry a constraint violation", () =>
    Effect.gen(function* () {
      const { call, calls } = failingCall([CONSTRAINT_ERROR], "ok");

      const exit = yield* runWithVirtualTime(retryTransientD1Call("run", false, call));

      expect(exit).toEqual(
        Exit.fail(new D1CallError({ cause: bindingRejection(CONSTRAINT_ERROR) })),
      );
      expect(calls.count).toBe(1);
    }),
  );

  it.effect("does not retry a write after a failure that may have applied it", () =>
    Effect.gen(function* () {
      const { call, calls } = failingCall([INCIDENT_ERROR], "ok");

      const exit = yield* runWithVirtualTime(retryTransientD1Call("run", false, call));

      expect(exit).toEqual(Exit.fail(new D1CallError({ cause: bindingRejection(INCIDENT_ERROR) })));
      expect(calls.count).toBe(1);
    }),
  );

  it.effect("retries a write when the database was never reached", () =>
    Effect.gen(function* () {
      const { call, calls } = failingCall([UNREACHABLE_ERROR, UNREACHABLE_ERROR], "ok");

      const exit = yield* runWithVirtualTime(retryTransientD1Call("run", false, call));

      expect(exit).toEqual(Exit.succeed("ok"));
      expect(calls.count).toBe(3);
    }),
  );

  it.effect("waits between attempts instead of retrying immediately", () =>
    Effect.gen(function* () {
      const { call, calls } = failingCall([INCIDENT_ERROR], "rows");

      const fiber = yield* Effect.forkChild(retryTransientD1Call("all", true, call));
      yield* TestClock.adjust(Duration.millis(100));
      const attemptsBeforeFirstDelay = calls.count;
      yield* TestClock.adjust(Duration.millis(200));
      const result = yield* Fiber.join(fiber);

      expect(attemptsBeforeFirstDelay).toBe(1);
      expect(result).toBe("rows");
      expect(calls.count).toBe(2);
    }),
  );
});

const makeFakeD1 = (failures: readonly string[]) => {
  const executed: string[] = [];
  const batches: unknown[][] = [];
  let remainingFailures = [...failures];
  const settle = <A>(sql: string, value: A): Promise<A> => {
    executed.push(sql);
    const [failure, ...rest] = remainingFailures;
    remainingFailures = rest;
    return failure === undefined
      ? Promise.resolve(value)
      : // oxlint-disable-next-line executor/no-promise-reject -- test double: a D1 call that rejects like the binding does
        Promise.reject(bindingRejection(failure));
  };
  const created: D1PreparedStatement[] = [];
  const statement = (sql: string, args: readonly unknown[]): D1PreparedStatement => {
    // oxlint-disable-next-line executor/no-double-cast -- test double: D1 result metadata is irrelevant to the retry wrapper
    const made = {
      bind: (...values: readonly unknown[]) => statement(sql, [...args, ...values]),
      first: () => settle(sql, null),
      run: () => settle(sql, { success: true, meta: {}, results: [] }),
      all: () => settle(sql, { success: true, meta: {}, results: [{ args }] }),
      raw: () => settle(sql, []),
    } as unknown as D1PreparedStatement;
    created.push(made);
    return made;
  };
  const prepare = (sql: string) => statement(sql, []);
  const batch = (statements: D1PreparedStatement[]) => {
    batches.push(statements);
    return settle("batch", []);
  };
  // oxlint-disable-next-line executor/no-double-cast -- test double: only the D1 methods the wrapper forwards are implemented
  const db = {
    prepare,
    batch,
    withSession: () => ({ prepare, batch, getBookmark: () => null }),
  } as unknown as D1Database;
  return { db, executed, batches, created };
};

describe("withD1TransientRetry", () => {
  it.live("retries a bound read through the binding and returns its rows", () =>
    Effect.gen(function* () {
      const fake = makeFakeD1([INCIDENT_ERROR]);
      const db = withD1TransientRetry(fake.db);

      const result = yield* Effect.promise(() =>
        db.withSession("first-primary").prepare("SELECT 1 WHERE ? = ?").bind("a", "b").all(),
      );

      expect(result.results).toEqual([{ args: ["a", "b"] }]);
      expect(fake.executed).toEqual(["SELECT 1 WHERE ? = ?", "SELECT 1 WHERE ? = ?"]);
    }),
  );

  it.live("rejects a write with the original binding error after one attempt", () =>
    Effect.gen(function* () {
      const fake = makeFakeD1([INCIDENT_ERROR]);
      const db = withD1TransientRetry(fake.db);

      const rejection = yield* Effect.promise(() =>
        db
          .prepare("INSERT INTO t (id) VALUES (?)")
          .bind("x")
          .run()
          .then(
            () => "resolved",
            (failure: unknown) => failure,
          ),
      );

      expect(rejection).toEqual(bindingRejection(INCIDENT_ERROR));
      expect(fake.executed).toEqual(["INSERT INTO t (id) VALUES (?)"]);
    }),
  );

  it.live("hands the binding its own statements in a batch", () =>
    Effect.gen(function* () {
      const fake = makeFakeD1([]);
      const db = withD1TransientRetry(fake.db);
      const statements = [db.prepare("SELECT 1"), db.prepare("SELECT 2").bind(7)];

      yield* Effect.promise(() => db.batch(statements));

      expect(fake.batches).toEqual([[fake.created[0], fake.created[2]]]);
    }),
  );
});
