import { Data, Duration, Effect, Predicate, Schedule } from "effect";
import type { D1Database, D1DatabaseSession, D1PreparedStatement } from "@cloudflare/workers-types";

// ---------------------------------------------------------------------------
// Transient D1 failure retry.
//
// D1 occasionally fails a burst of queries with infrastructure errors (the
// Durable Object behind the database restarts, a node is briefly unreachable)
// and then recovers on its own. Every executor query goes through the D1
// binding, so the binding is wrapped once here and each call rides out a
// short blip with a bounded, jittered exponential backoff.
//
// A failure is retried only when Cloudflare documents it as transient
// (https://developers.cloudflare.com/d1/observability/debug-d1/), and how far
// it is retried depends on whether the statement may already have run:
//
// - "not-executed": the request never reached a running database, so the
//   statement did not run. Safe to retry any statement, writes included.
// - "maybe-executed": the database failed while (or after) the statement ran.
//   A write may or may not have applied, and the binding cannot tell which,
//   so only read-only statements are retried. A write surfaces the original
//   error, as before.
// - "permanent": everything else (SQL errors, constraint violations, limits,
//   query-caused timeouts and resets). Never retried.
// ---------------------------------------------------------------------------

export type D1FailureClass = "not-executed" | "maybe-executed" | "permanent";

const NOT_EXECUTED_MARKERS = [
  "Cannot resolve D1 DB due to transient issue on remote node",
  "Internal error while starting up D1 DB storage caused object to be reset",
  "D1 DB is overloaded. Too many requests queued",
] as const;

const MAYBE_EXECUTED_MARKERS = [
  "D1_ERROR: internal error",
  "Network connection lost",
  "Replica disconnected from primary",
  "Internal error in D1 DB storage caused object to be reset",
  "D1 DB reset because its code was updated",
  "Can't read from request stream because client disconnected",
  "D1 DB is overloaded. Requests queued for too long",
] as const;

const MAX_CAUSE_DEPTH = 4;

const failureMessages = (failure: unknown): readonly string[] => {
  const messages: string[] = [];
  let current: unknown = failure;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && Predicate.isError(current); depth += 1) {
    // oxlint-disable-next-line executor/no-unknown-error-message -- adapter boundary: the D1 binding rejects with a plain Error whose message IS the documented error code
    messages.push(current.message);
    current = current.cause;
  }
  return messages;
};

export const classifyD1Failure = (failure: unknown): D1FailureClass => {
  const messages = failureMessages(failure);
  const mentions = (markers: readonly string[]) =>
    messages.some((message) => markers.some((marker) => message.includes(marker)));
  if (mentions(NOT_EXECUTED_MARKERS)) return "not-executed";
  if (mentions(MAYBE_EXECUTED_MARKERS)) return "maybe-executed";
  return "permanent";
};

const READ_ONLY_LEADING_KEYWORD = /^\s*(?:SELECT|WITH|EXPLAIN)\b/i;
const WRITE_KEYWORD =
  /\b(?:INSERT|UPDATE|DELETE|REPLACE|UPSERT|CREATE|DROP|ALTER|PRAGMA|ATTACH|DETACH|VACUUM|REINDEX|ANALYZE|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

/** Mirrors D1's own read-only detection: only SELECT / WITH / EXPLAIN, and no
 *  keyword that can write anywhere in the text. A false "write" only means the
 *  statement is not retried on a maybe-executed failure. */
export const isReadOnlySql = (sql: string): boolean =>
  READ_ONLY_LEADING_KEYWORD.test(sql) && !WRITE_KEYWORD.test(sql);

export const isRetryableD1Failure = (failure: unknown, readOnly: boolean): boolean => {
  const failureClass = classifyD1Failure(failure);
  if (failureClass === "not-executed") return true;
  return failureClass === "maybe-executed" && readOnly;
};

export const D1_RETRY_MAX_ATTEMPTS = 5;
const D1_RETRY_BASE_DELAY = Duration.millis(200);
const D1_RETRY_MAX_DELAY = Duration.seconds(2);

/** 200ms, 400ms, 800ms, 1600ms (each jittered to 80-120%, capped at 2s):
 *  five attempts within about 3.6 seconds, so an MCP call still answers. */
export const d1RetrySchedule = Schedule.exponential(D1_RETRY_BASE_DELAY).pipe(
  Schedule.modifyDelay((_, delay) => Effect.succeed(Duration.min(delay, D1_RETRY_MAX_DELAY))),
  Schedule.jittered,
  Schedule.both(Schedule.recurs(D1_RETRY_MAX_ATTEMPTS - 1)),
);

/** A rejection from the D1 binding, kept as-is in `cause`. */
export class D1CallError extends Data.TaggedError("D1CallError")<{
  readonly cause: unknown;
}> {}

export const retryTransientD1Call = <A>(
  operation: string,
  readOnly: boolean,
  call: () => Promise<A>,
): Effect.Effect<A, D1CallError> => {
  let attempt = 0;
  return Effect.suspend(() => {
    attempt += 1;
    const current = attempt;
    return Effect.tryPromise({ try: call, catch: (cause) => new D1CallError({ cause }) }).pipe(
      Effect.tapError(({ cause: failure }) =>
        current < D1_RETRY_MAX_ATTEMPTS && isRetryableD1Failure(failure, readOnly)
          ? Effect.logWarning("D1 transient failure, retrying").pipe(
              Effect.annotateLogs({
                "d1.operation": operation,
                "d1.read_only": readOnly,
                "d1.attempt": current,
                "d1.max_attempts": D1_RETRY_MAX_ATTEMPTS,
                "d1.failure_class": classifyD1Failure(failure),
                "d1.failure": failureMessages(failure)[0] ?? "unknown",
              }),
            )
          : Effect.void,
      ),
    );
  }).pipe(
    Effect.retry({
      schedule: d1RetrySchedule,
      while: (failure) => isRetryableD1Failure(failure.cause, readOnly),
    }),
  );
};

const runRetried = <A>(operation: string, readOnly: boolean, call: () => Promise<A>): Promise<A> =>
  Effect.runPromise(
    retryTransientD1Call(operation, readOnly, call).pipe(
      Effect.mapError((failure) => failure.cause),
    ),
  );

interface WrappedStatement {
  readonly inner: D1PreparedStatement;
  readonly readOnly: boolean;
}

const wrappedStatements = new WeakMap<D1PreparedStatement, WrappedStatement>();

const wrapStatement = (inner: D1PreparedStatement, sql: string): D1PreparedStatement => {
  const readOnly = isReadOnlySql(sql);
  const first = <T>(colName?: string): Promise<T | null> =>
    runRetried("first", readOnly, () =>
      colName === undefined ? inner.first<T>() : inner.first<T>(colName),
    );
  function raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  function raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  function raw<T = unknown[]>(options?: {
    readonly columnNames?: boolean;
  }): Promise<[string[], ...T[]] | T[]> {
    return runRetried<[string[], ...T[]] | T[]>("raw", readOnly, () =>
      options?.columnNames === true ? inner.raw<T>({ columnNames: true }) : inner.raw<T>(),
    );
  }
  const wrapped: D1PreparedStatement = {
    bind: (...values) => wrapStatement(inner.bind(...values), sql),
    first,
    run: () => runRetried("run", readOnly, () => inner.run()),
    all: () => runRetried("all", readOnly, () => inner.all()),
    raw,
  };
  wrappedStatements.set(wrapped, { inner, readOnly });
  return wrapped;
};

/** A batch runs as one transaction, so it may be retried after a
 *  maybe-executed failure only when every statement in it is read-only. */
const wrapBatch =
  (batch: D1Database["batch"]): D1Database["batch"] =>
  (statements) =>
    runRetried(
      "batch",
      statements.every((statement) => wrappedStatements.get(statement)?.readOnly === true),
      () =>
        batch(statements.map((statement) => wrappedStatements.get(statement)?.inner ?? statement)),
    );

const wrapSession = (inner: D1DatabaseSession): D1DatabaseSession => ({
  prepare: (query) => wrapStatement(inner.prepare(query), query),
  batch: wrapBatch((statements) => inner.batch(statements)),
  getBookmark: () => inner.getBookmark(),
});

/** The D1 binding with every query retried on documented transient failures. */
export const withD1TransientRetry = (db: D1Database): D1Database => ({
  prepare: (query) => wrapStatement(db.prepare(query), query),
  batch: wrapBatch((statements) => db.batch(statements)),
  exec: (query) => runRetried("exec", isReadOnlySql(query), () => db.exec(query)),
  withSession: (constraintOrBookmark) => wrapSession(db.withSession(constraintOrBookmark)),
  dump: () => db.dump(),
});
