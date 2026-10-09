import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { createExecutor, IntegrationSlug } from "@executor-js/sdk";
import { makeHostedFetch, makeHostedHttpClientLayer } from "@executor-js/sdk/host-internal";
import { makeTestConfig } from "@executor-js/sdk/testing";
import { makeAnnotationsMcpServer } from "@executor-js/plugin-mcp/testing";

import type { InternalIntegration } from "../config";
import { makeCloudflarePlugins } from "../plugins";
import { makeInternalListTools } from "./list-tools";
import {
  hashToolList,
  reconcileInternalIntegrations,
  toolsHashKey,
  type HashStore,
  type ListedTool,
} from "./reconcile";

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const FIXTURE: InternalIntegration = {
  slug: "fixture",
  name: "Fixture",
  description: "A fixture tool server",
  endpoint: "https://tools.internal/mcp/fixture",
};

interface ToolRecord {
  readonly name: string;
  readonly [key: string]: unknown;
}

const makeBinding = () => {
  const methods: string[] = [];
  const state: { transformTools: (tools: ToolRecord[]) => ToolRecord[]; down: boolean } = {
    transformTools: (tools) => tools,
    down: false,
  };
  return {
    methods,
    state,
    fetch: async (request: Request): Promise<Response> => {
      if (state.down) return new Response("down", { status: 503 });
      const body = decodeJson(await request.clone().text());
      const method =
        Option.isSome(body) && typeof body.value === "object" && body.value !== null
          ? Reflect.get(body.value, "method")
          : undefined;
      if (method !== undefined) {
        methods.push(`${new URL(request.url).pathname} ${String(method)}`);
      }
      const server = makeAnnotationsMcpServer();
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await server.connect(transport);
      const response = await transport.handleRequest(request);
      if (method !== "tools/list") return response;
      const payload = decodeJson(await response.text());
      if (Option.isNone(payload)) return response;
      const result: unknown = Reflect.get(payload.value as object, "result");
      const tools: unknown = Reflect.get(result as object, "tools");
      Reflect.set(result as object, "tools", state.transformTools(tools as ToolRecord[]));
      return new Response(JSON.stringify(payload.value), {
        status: response.status,
        headers: response.headers,
      });
    },
  };
};

const makeExecutor = (binding: { readonly fetch: (request: Request) => Promise<Response> }) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const internalHosts = { "tools.internal": binding };
      const config = makeTestConfig({
        plugins: makeCloudflarePlugins("test-secret-key-0123456789abcdef"),
      });
      const executor = yield* createExecutor({
        ...config,
        httpClientLayer: makeHostedHttpClientLayer({ internalHosts }),
        fetch: makeHostedFetch({ internalHosts }),
      });
      return { executor, testDb: config.testDb };
    }),
    ({ executor, testDb }) =>
      executor
        .close()
        .pipe(
          Effect.ignore,
          Effect.andThen(Effect.promise(() => testDb.close()).pipe(Effect.ignore)),
        ),
  );

const toolIds = (tools: ReadonlyArray<{ readonly address: unknown }>) =>
  tools.map((tool) => String(tool.address)).sort();

const listCalls = (binding: ReturnType<typeof makeBinding>) =>
  binding.methods.filter((call) => call === "/mcp/fixture tools/list").length;

const makeStore = (fail = false) => {
  const data = new Map<string, string>();
  const store: HashStore = {
    get: (key: string) => {
      // oxlint-disable-next-line executor/no-promise-reject -- boundary: stand-in for a failing R2 binding
      if (fail) return Promise.reject("r2 down");
      const value = data.get(key);
      return Promise.resolve(value === undefined ? null : { text: () => Promise.resolve(value) });
    },
    put: (key: string, value: string) => {
      // oxlint-disable-next-line executor/no-promise-reject -- boundary: stand-in for a failing R2 binding
      if (fail) return Promise.reject("r2 down");
      data.set(key, value);
      return Promise.resolve();
    },
  };
  return { data, store };
};

const depsFor = (binding: ReturnType<typeof makeBinding>, store?: HashStore) => ({
  listTools: makeInternalListTools({ "tools.internal": binding }),
  store,
});

const HASH_KEY = toolsHashKey("fixture");

describe("reconcileInternalIntegrations", () => {
  it.live("creates the integration and its org connection main with the tools loaded", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binding = makeBinding();
        const { executor } = yield* makeExecutor(binding);

        const outcome = yield* reconcileInternalIntegrations(executor, [FIXTURE]);

        expect(outcome).toEqual([["fixture", "created"]]);
        const connections = yield* executor.connections.list({
          integration: IntegrationSlug.make("fixture"),
        });
        expect(connections.map((c) => [c.owner, String(c.name)])).toEqual([["org", "main"]]);
        const tools = yield* executor.tools.list({ integration: IntegrationSlug.make("fixture") });
        expect(toolIds(tools)).toEqual([
          "tools.fixture.org.main.delete",
          "tools.fixture.org.main.delete_titled",
          "tools.fixture.org.main.list",
          "tools.fixture.org.main.meta_stamped",
          "tools.fixture.org.main.ping",
        ]);
      }),
    ),
  );

  it.live("a second run writes nothing and does not touch the binding", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binding = makeBinding();
        const { executor } = yield* makeExecutor(binding);
        yield* reconcileInternalIntegrations(executor, [FIXTURE]);
        const callsAfterFirst = binding.methods.length;

        const outcome = yield* reconcileInternalIntegrations(executor, [FIXTURE]);

        expect(outcome).toEqual([["fixture", "skipped"]]);
        expect(binding.methods.length).toBe(callsAfterFirst);
        const connections = yield* executor.connections.list({
          integration: IntegrationSlug.make("fixture"),
        });
        expect(connections).toHaveLength(1);
      }),
    ),
  );

  it.live("leaves an existing integration with the same slug untouched", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binding = makeBinding();
        const { executor } = yield* makeExecutor(binding);
        yield* executor.mcp.addServer({
          transport: "remote",
          name: "Admin made",
          slug: "fixture",
          description: "Admin description",
          endpoint: "https://other.example.com/mcp",
        });

        const outcome = yield* reconcileInternalIntegrations(executor, [FIXTURE]);

        expect(outcome).toEqual([["fixture", "skipped"]]);
        const integration = yield* executor.integrations.get(IntegrationSlug.make("fixture"));
        expect(integration).toMatchObject({ name: "Admin made", description: "Admin description" });
        const connections = yield* executor.connections.list({
          integration: IntegrationSlug.make("fixture"),
        });
        expect(connections).toEqual([]);
        expect(binding.methods).toEqual([]);
      }),
    ),
  );

  it.live("refreshes only what it created", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binding = makeBinding();
        const { executor } = yield* makeExecutor(binding);
        yield* executor.mcp.addServer({
          transport: "remote",
          name: "Existing",
          slug: "existing",
          endpoint: "https://tools.internal/mcp/existing",
        });

        const outcome = yield* reconcileInternalIntegrations(executor, [
          { ...FIXTURE, slug: "existing", endpoint: "https://tools.internal/mcp/existing" },
          FIXTURE,
        ]);

        expect(outcome).toEqual([
          ["existing", "skipped"],
          ["fixture", "created"],
        ]);
        const existingTools = yield* executor.tools.list({
          integration: IntegrationSlug.make("existing"),
        });
        expect(existingTools).toEqual([]);
        expect(binding.methods.some((call) => call.startsWith("/mcp/existing"))).toBe(false);
        expect(binding.methods.some((call) => call === "/mcp/fixture tools/list")).toBe(true);
      }),
    ),
  );

  it.live("an existing integration is left alone when no tool lister is given", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binding = makeBinding();
        const { executor } = yield* makeExecutor(binding);
        yield* reconcileInternalIntegrations(executor, [FIXTURE]);
        const before = listCalls(binding);

        yield* reconcileInternalIntegrations(executor, [FIXTURE]);

        expect(listCalls(binding)).toBe(before);
      }),
    ),
  );

  it.live("never touches an existing integration with a different endpoint", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binding = makeBinding();
        const { executor } = yield* makeExecutor(binding);
        const { data, store } = makeStore();
        yield* executor.mcp.addServer({
          transport: "remote",
          name: "Admin made",
          slug: "fixture",
          endpoint: "https://tools.internal/mcp/other",
        });

        const outcome = yield* reconcileInternalIntegrations(
          executor,
          [FIXTURE],
          depsFor(binding, store),
        );

        expect(outcome).toEqual([["fixture", "skipped"]]);
        expect(binding.methods).toEqual([]);
        expect(data.size).toBe(0);
      }),
    ),
  );
});

describe("content-hash catalog refresh", () => {
  const created = (binding: ReturnType<typeof makeBinding>, store: HashStore) =>
    Effect.gen(function* () {
      const { executor } = yield* makeExecutor(binding);
      yield* reconcileInternalIntegrations(executor, [FIXTURE]);
      return { executor, store };
    });

  it.live("refreshes and stores the hash when none is stored", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binding = makeBinding();
        const { data, store } = makeStore();
        const { executor } = yield* created(binding, store);
        const before = listCalls(binding);

        const outcome = yield* reconcileInternalIntegrations(
          executor,
          [FIXTURE],
          depsFor(binding, store),
        );

        expect(outcome).toEqual([["fixture", "refreshed"]]);
        expect(listCalls(binding)).toBe(before + 2);
        expect(data.get(HASH_KEY)).toMatch(/^[0-9a-f]{64}$/);
      }),
    ),
  );

  it.live("does not refresh when the tools are unchanged, only lists them", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binding = makeBinding();
        const { data, store } = makeStore();
        const { executor } = yield* created(binding, store);
        const deps = depsFor(binding, store);
        yield* reconcileInternalIntegrations(executor, [FIXTURE], deps);
        const hash = data.get(HASH_KEY);
        const before = listCalls(binding);

        const outcome = yield* reconcileInternalIntegrations(executor, [FIXTURE], deps);

        expect(outcome).toEqual([["fixture", "skipped"]]);
        expect(listCalls(binding)).toBe(before + 1);
        expect(data.get(HASH_KEY)).toBe(hash);
      }),
    ),
  );

  it.live("refreshes and stores a new hash when a tool is added", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binding = makeBinding();
        const { data, store } = makeStore();
        const { executor } = yield* created(binding, store);
        const deps = depsFor(binding, store);
        yield* reconcileInternalIntegrations(executor, [FIXTURE], deps);
        const oldHash = data.get(HASH_KEY);
        binding.state.transformTools = (tools) => [
          ...tools,
          { name: "brand_new", description: "new", inputSchema: { type: "object" } },
        ];

        const outcome = yield* reconcileInternalIntegrations(executor, [FIXTURE], deps);

        expect(outcome).toEqual([["fixture", "refreshed"]]);
        expect(data.get(HASH_KEY)).not.toBe(oldHash);
        const tools = yield* executor.tools.list({ integration: IntegrationSlug.make("fixture") });
        expect(toolIds(tools)).toContain("tools.fixture.org.main.brand_new");
      }),
    ),
  );

  it.live("does not store the hash when the refresh fails, and retries on the next run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binding = makeBinding();
        const { data, store } = makeStore();
        const { executor } = yield* created(binding, store);
        const failing = {
          listTools: makeInternalListTools({ "tools.internal": binding }),
          store,
        };
        let listed = 0;
        const gated = {
          ...failing,
          listTools: (endpoint: string) =>
            failing.listTools(endpoint).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  listed += 1;
                  binding.state.down = true;
                }),
              ),
            ),
        };

        const first = yield* reconcileInternalIntegrations(executor, [FIXTURE], gated);

        expect(first).toEqual([["fixture", "failed"]]);
        expect(listed).toBe(1);
        expect(data.has(HASH_KEY)).toBe(false);
        binding.state.down = false;
        const second = yield* reconcileInternalIntegrations(executor, [FIXTURE], failing);
        expect(second).toEqual([["fixture", "refreshed"]]);
        expect(data.has(HASH_KEY)).toBe(true);
      }),
    ),
  );

  it.live("a tools/list failure skips the integration and records nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binding = makeBinding();
        const { data, store } = makeStore();
        const { executor } = yield* created(binding, store);
        binding.state.down = true;

        const outcome = yield* reconcileInternalIntegrations(
          executor,
          [FIXTURE],
          depsFor(binding, store),
        );

        expect(outcome).toEqual([["fixture", "failed"]]);
        expect(data.size).toBe(0);
      }),
    ),
  );

  it.live("stores the hash of a newly created integration", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binding = makeBinding();
        const { data, store } = makeStore();
        const { executor } = yield* makeExecutor(binding);

        const outcome = yield* reconcileInternalIntegrations(
          executor,
          [FIXTURE],
          depsFor(binding, store),
        );

        expect(outcome).toEqual([["fixture", "created"]]);
        const second = yield* reconcileInternalIntegrations(
          executor,
          [FIXTURE],
          depsFor(binding, store),
        );
        expect(second).toEqual([["fixture", "skipped"]]);
        expect(data.has(HASH_KEY)).toBe(true);
      }),
    ),
  );

  it.live("refreshes and does not fail when R2 errors", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binding = makeBinding();
        const { store } = makeStore(true);
        const { executor } = yield* created(binding, store);

        const outcome = yield* reconcileInternalIntegrations(
          executor,
          [FIXTURE],
          depsFor(binding, store),
        );

        expect(outcome).toEqual([["fixture", "refreshed"]]);
      }),
    ),
  );

  it.live("refreshes every time when no store is bound", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binding = makeBinding();
        const { executor } = yield* created(binding, makeStore().store);

        const outcome = yield* reconcileInternalIntegrations(executor, [FIXTURE], depsFor(binding));

        expect(outcome).toEqual([["fixture", "refreshed"]]);
      }),
    ),
  );
});

describe("hashToolList", () => {
  const tool = (toolName: string, extra: Partial<ListedTool> = {}): ListedTool => ({
    toolName,
    description: `${toolName} tool`,
    inputSchema: { type: "object", properties: { a: { type: "string" }, b: { type: "number" } } },
    annotations: { readOnlyHint: true },
    ...extra,
  });

  it.live("is stable across tool order and object key order", () =>
    Effect.promise(async () => {
      const reordered = tool("beta", {
        inputSchema: {
          properties: { b: { type: "number" }, a: { type: "string" } },
          type: "object",
        },
      });
      expect(await hashToolList([tool("alpha"), tool("beta")])).toBe(
        await hashToolList([reordered, tool("alpha")]),
      );
    }),
  );

  it.live("changes with a description, a schema or an annotation", () =>
    Effect.promise(async () => {
      const base = await hashToolList([tool("alpha")]);
      expect(await hashToolList([tool("alpha", { description: "other" })])).not.toBe(base);
      expect(await hashToolList([tool("alpha", { inputSchema: { type: "string" } })])).not.toBe(
        base,
      );
      expect(
        await hashToolList([tool("alpha", { annotations: { readOnlyHint: false } })]),
      ).not.toBe(base);
    }),
  );

  it.live("has a known SHA-256 for an empty list", () =>
    Effect.promise(async () => {
      expect(await hashToolList([])).toBe(
        "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
      );
    }),
  );
});
