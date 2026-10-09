import { Effect } from "effect";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  type ConnectionRef,
} from "@executor-js/sdk";

import type { InternalIntegration } from "../config";

export const INTERNAL_CONNECTION_NAME = "main";

export type ReconcileOutcome = "created" | "refreshed" | "skipped" | "failed";

export interface InternalIntegrationExecutor {
  readonly integrations: {
    readonly get: (slug: IntegrationSlug) => Effect.Effect<unknown, unknown>;
  };
  readonly mcp: {
    readonly addServer: (input: {
      readonly transport: "remote";
      readonly name: string;
      readonly slug: string;
      readonly description: string;
      readonly endpoint: string;
      readonly remoteTransport: "streamable-http";
      readonly auth: { readonly kind: "none" };
    }) => Effect.Effect<unknown, unknown>;
  };
  readonly connections: {
    readonly create: (input: {
      readonly owner: "org";
      readonly name: ConnectionName;
      readonly integration: IntegrationSlug;
      readonly template: AuthTemplateSlug;
      readonly values: Record<string, never>;
    }) => Effect.Effect<unknown, unknown>;
    readonly refresh: (ref: ConnectionRef) => Effect.Effect<unknown, unknown>;
    readonly list: (filter: {
      readonly integration: IntegrationSlug;
    }) => Effect.Effect<ReadonlyArray<unknown>, unknown>;
  };
}

const storedEndpoint = (integration: unknown): string | undefined => {
  if (typeof integration !== "object" || integration === null) return undefined;
  const url: unknown = Reflect.get(integration, "displayUrl");
  return typeof url === "string" ? url : undefined;
};

class ToolSyncFailed {
  readonly _tag = "ToolSyncFailed";
}

// A refresh that cannot reach the server succeeds and records the failure on the connection.
const refreshMain = (executor: InternalIntegrationExecutor, slug: IntegrationSlug) =>
  Effect.gen(function* () {
    const name = ConnectionName.make(INTERNAL_CONNECTION_NAME);
    yield* executor.connections.refresh({ owner: "org", integration: slug, name });
    const connections = yield* executor.connections.list({ integration: slug });
    const main = connections.find(
      (connection) =>
        typeof connection === "object" &&
        connection !== null &&
        Reflect.get(connection, "owner") === "org" &&
        String(Reflect.get(connection, "name")) === INTERNAL_CONNECTION_NAME,
    );
    const health: unknown =
      main === undefined ? undefined : Reflect.get(main as object, "lastHealth");
    const reason: unknown =
      typeof health === "object" && health !== null ? Reflect.get(health, "reason") : undefined;
    if (reason === "tool_sync_failed") return yield* Effect.fail(new ToolSyncFailed());
  });

const reconcileOne = (
  executor: InternalIntegrationExecutor,
  entry: InternalIntegration,
  refreshExisting: boolean,
) =>
  Effect.gen(function* () {
    const slug = IntegrationSlug.make(entry.slug);
    const existing = yield* executor.integrations.get(slug);
    if (existing !== null && existing !== undefined) {
      if (refreshExisting && storedEndpoint(existing) === entry.endpoint) {
        yield* refreshMain(executor, slug);
        yield* Effect.logInfo(`internal integration ${entry.slug} catalog refreshed`);
        return "refreshed" as const;
      }
      yield* Effect.logInfo(`internal integration ${entry.slug} already exists, left untouched`);
      return "skipped" as const;
    }
    yield* executor.mcp.addServer({
      transport: "remote",
      name: entry.name,
      slug: entry.slug,
      description: entry.description,
      endpoint: entry.endpoint,
      remoteTransport: "streamable-http",
      auth: { kind: "none" },
    });
    const name = ConnectionName.make(INTERNAL_CONNECTION_NAME);
    yield* executor.connections.create({
      owner: "org",
      name,
      integration: slug,
      template: AuthTemplateSlug.make("none"),
      values: {},
    });
    yield* refreshMain(executor, slug);
    return "created" as const;
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning(`internal integration ${entry.slug} could not be reconciled`, cause).pipe(
        Effect.annotateLogs({ step: "reconcile-internal-integration", slug: entry.slug }),
        Effect.as("failed" as const),
      ),
    ),
  );

/**
 * Creates each declared integration that does not exist yet, with its org
 * connection `main`, and loads its tools. With `refreshExisting`, also refreshes
 * the `main` connection of an existing integration whose stored endpoint equals
 * the declared one. Never updates or deletes anything, and never fails the caller.
 */
export const reconcileInternalIntegrations = (
  executor: InternalIntegrationExecutor,
  entries: readonly InternalIntegration[],
  options: { readonly refreshExisting?: boolean } = {},
): Effect.Effect<ReadonlyArray<readonly [string, ReconcileOutcome]>> =>
  Effect.forEach(entries, (entry) =>
    reconcileOne(executor, entry, options.refreshExisting === true).pipe(
      Effect.map((outcome) => [entry.slug, outcome] as const),
    ),
  );

export const REFRESHED_VERSION_KEY = "internal-integrations/refreshed-version";

export interface RefreshedVersionStore {
  readonly get: (key: string) => Promise<{ readonly text: () => Promise<string> } | null>;
  readonly put: (key: string, value: string) => Promise<unknown>;
}

const warnStore = (message: string) => (cause: unknown) =>
  Effect.logWarning(message, cause).pipe(Effect.annotateLogs({ step: "internal-catalog-refresh" }));

/** True unless the stored version id equals `versionId`; any doubt means refresh. */
export const needsCatalogRefresh = (
  versionId: string | undefined,
  store: RefreshedVersionStore | undefined,
): Effect.Effect<boolean> => {
  if (versionId === undefined || store === undefined) return Effect.succeed(true);
  return Effect.tryPromise(async () => {
    const stored = await store.get(REFRESHED_VERSION_KEY);
    return stored === null ? undefined : await stored.text();
  }).pipe(
    Effect.map((stored) => stored !== versionId),
    Effect.catch((cause) =>
      warnStore("refreshed version could not be read, refreshing")(cause).pipe(Effect.as(true)),
    ),
  );
};

export const recordRefreshedVersion = (
  versionId: string | undefined,
  store: RefreshedVersionStore | undefined,
): Effect.Effect<void> => {
  if (versionId === undefined || store === undefined) return Effect.void;
  return Effect.tryPromise(() => store.put(REFRESHED_VERSION_KEY, versionId)).pipe(
    Effect.asVoid,
    Effect.catch(warnStore("refreshed version could not be recorded")),
  );
};

/**
 * Reconciles, refreshing existing catalogs when this version has not refreshed
 * yet. The version is recorded only when no entry failed, so a binding that was
 * down at boot is retried on the next boot.
 */
export const reconcileForVersion = (
  executor: InternalIntegrationExecutor,
  entries: readonly InternalIntegration[],
  versionId: string | undefined,
  store: RefreshedVersionStore | undefined,
): Effect.Effect<ReadonlyArray<readonly [string, ReconcileOutcome]>> =>
  Effect.gen(function* () {
    const refreshExisting = yield* needsCatalogRefresh(versionId, store);
    const outcomes = yield* reconcileInternalIntegrations(executor, entries, { refreshExisting });
    if (refreshExisting && outcomes.every(([, outcome]) => outcome !== "failed")) {
      yield* recordRefreshedVersion(versionId, store);
    }
    return outcomes;
  });
