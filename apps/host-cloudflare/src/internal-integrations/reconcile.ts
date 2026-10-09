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

export const TOOLS_HASH_KEY_PREFIX = "internal-integrations/tools-hash/";

export const toolsHashKey = (slug: string): string => `${TOOLS_HASH_KEY_PREFIX}${slug}`;

/** The parts of a listed tool that a catalog refresh would change. */
export interface ListedTool {
  readonly toolName: string;
  readonly description?: string | null;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly annotations?: unknown;
}

/** Lists the current tools of an MCP endpoint over the host's internal routing. */
export type ListTools = (endpoint: string) => Effect.Effect<ReadonlyArray<ListedTool>, unknown>;

export interface HashStore {
  readonly get: (key: string) => Promise<{ readonly text: () => Promise<string> } | null>;
  readonly put: (key: string, value: string) => Promise<unknown>;
}

export interface ReconcileDeps {
  /** Without it, existing integrations are never refreshed. */
  readonly listTools?: ListTools;
  /** Without it, every existing integration with the declared endpoint is refreshed. */
  readonly store?: HashStore;
}

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item ?? null)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

/** SHA-256 hex of the tool list, independent of tool order and object key order. */
export const hashToolList = async (tools: ReadonlyArray<ListedTool>): Promise<string> => {
  const normalized = tools
    .map((tool) => ({
      name: tool.toolName,
      description: tool.description ?? null,
      inputSchema: tool.inputSchema ?? null,
      outputSchema: tool.outputSchema ?? null,
      annotations: tool.annotations ?? null,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(normalized)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const warnStore = (message: string) => (cause: unknown) =>
  Effect.logWarning(message, cause).pipe(Effect.annotateLogs({ step: "internal-catalog-refresh" }));

const readStoredHash = (
  store: HashStore | undefined,
  slug: string,
): Effect.Effect<string | undefined> => {
  if (store === undefined) return Effect.succeed(undefined as string | undefined);
  return Effect.tryPromise(async () => {
    const stored = await store.get(toolsHashKey(slug));
    return stored === null ? undefined : await stored.text();
  }).pipe(
    Effect.catch((cause) =>
      warnStore(`tools hash for ${slug} could not be read, refreshing`)(cause).pipe(
        Effect.as(undefined),
      ),
    ),
  );
};

const writeStoredHash = (
  store: HashStore | undefined,
  slug: string,
  hash: string,
): Effect.Effect<void> => {
  if (store === undefined) return Effect.void;
  return Effect.tryPromise(() => store.put(toolsHashKey(slug), hash)).pipe(
    Effect.asVoid,
    Effect.catch(warnStore(`tools hash for ${slug} could not be recorded`)),
  );
};

const listAndHash = (listTools: ListTools, endpoint: string) =>
  listTools(endpoint).pipe(Effect.flatMap((tools) => Effect.promise(() => hashToolList(tools))));

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
  deps: ReconcileDeps,
) =>
  Effect.gen(function* () {
    const slug = IntegrationSlug.make(entry.slug);
    const existing = yield* executor.integrations.get(slug);
    if (existing !== null && existing !== undefined) {
      if (deps.listTools === undefined || storedEndpoint(existing) !== entry.endpoint) {
        yield* Effect.logInfo(`internal integration ${entry.slug} already exists, left untouched`);
        return "skipped" as const;
      }
      const current = yield* listAndHash(deps.listTools, entry.endpoint);
      const stored = yield* readStoredHash(deps.store, entry.slug);
      if (stored === current) {
        yield* Effect.logInfo(`internal integration ${entry.slug} catalog is current`);
        return "skipped" as const;
      }
      yield* refreshMain(executor, slug);
      yield* writeStoredHash(deps.store, entry.slug, current);
      yield* Effect.logInfo(`internal integration ${entry.slug} catalog refreshed`);
      return "refreshed" as const;
    }
    const listTools = deps.listTools;
    const current =
      listTools === undefined
        ? undefined
        : yield* listAndHash(listTools, entry.endpoint).pipe(
            Effect.catch((cause) =>
              warnStore(`tools of ${entry.slug} could not be listed before creation`)(cause).pipe(
                Effect.as(undefined),
              ),
            ),
          );
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
    if (current !== undefined) yield* writeStoredHash(deps.store, entry.slug, current);
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
 * connection `main`, and loads its tools. For an existing integration whose
 * stored endpoint equals the declared one, lists the current tools and
 * refreshes the `main` connection only when their content hash differs from the
 * stored one; the hash is stored after a successful refresh. Never updates or
 * deletes anything, and never fails the caller.
 */
export const reconcileInternalIntegrations = (
  executor: InternalIntegrationExecutor,
  entries: readonly InternalIntegration[],
  deps: ReconcileDeps = {},
): Effect.Effect<ReadonlyArray<readonly [string, ReconcileOutcome]>> =>
  Effect.forEach(entries, (entry) =>
    reconcileOne(executor, entry, deps).pipe(
      Effect.map((outcome) => [entry.slug, outcome] as const),
    ),
  );
