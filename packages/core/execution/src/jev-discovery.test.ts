import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { makeJevToolDiscoveryProvider } from "./jev-discovery";
import type {
  PagedResult,
  ToolDiscoveryInput,
  ToolDiscoveryProvider,
  ToolDiscoveryResult,
} from "./tool-invoker";

// The shape the catalog really yields: a prefixed `address` and its own
// `integration`. Fixtures that invented a `path` field hid a production crash.
const TOOLS = [
  {
    address: "tools.linear.issues.list",
    integration: "linear",
    name: "list issues",
    description: "List Linear issues",
  },
  {
    address: "tools.github.pulls.list",
    integration: "github",
    name: "list pull requests",
    description: "List GitHub pull requests",
  },
];

// Only the slice of Executor this provider touches: the tool list it scores.
const executorWith = (tools: readonly Record<string, unknown>[]) =>
  // A test double for the ONE Executor method this provider calls; building a
  // whole Executor would test the fixture rather than the rescue.
  // oxlint-disable-next-line executor/no-double-cast -- boundary: test double
  ({
    tools: { list: () => Effect.succeed(tools) },
  }) as unknown as ToolDiscoveryInput["executor"];

const input = (
  overrides: Partial<ToolDiscoveryInput> = {},
): ToolDiscoveryInput => ({
  executor: executorWith(TOOLS),
  query: "muestrame mis tareas pendientes",
  limit: 10,
  offset: 0,
  ...overrides,
});

const emptyPage: PagedResult<ToolDiscoveryResult> = {
  items: [],
  total: 0,
  hasMore: false,
  nextOffset: null,
};

const lexical = (
  result: PagedResult<ToolDiscoveryResult>,
  calls?: { count: number },
): ToolDiscoveryProvider => ({
  searchTools: () =>
    Effect.sync(() => {
      if (calls !== undefined) {
        calls.count += 1;
      }
      return result;
    }),
});

const jevReturning = (
  body: string,
): Effect.Effect<{
  readonly layer: Layer.Layer<HttpClient.HttpClient>;
  readonly calls: Ref.Ref<number>;
}> =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const layer = Layer.succeed(HttpClient.HttpClient)(
      HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
        Effect.gen(function* () {
          yield* Ref.update(calls, (n) => n + 1);
          return HttpClientResponse.fromWeb(
            request,
            new Response(body, {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }),
      ),
    );
    return { layer, calls };
  });

const GATEWAY = { accountId: "acct", gatewayId: "staging-gateway" };

describe("makeJevToolDiscoveryProvider", () => {
  it.effect("scores with Jev even when lexical already matched", () =>
    Effect.gen(function* () {
      const { layer, calls } = yield* jevReturning(`{"answers":{"1":{"noul":0.95}}}`);
      const hit: PagedResult<ToolDiscoveryResult> = {
        items: [
          {
            path: "linear.issues.list",
            name: "list issues",
            integration: "linear",
            score: 90,
          },
        ],
        total: 1,
        hasMore: false,
        nextOffset: null,
      };
      const provider = makeJevToolDiscoveryProvider({
        gateway: { ...GATEWAY },
        httpClientLayer: layer,
        delegate: lexical(hit),
      });

      const result = yield* provider
        .searchTools(input())
        .pipe(Effect.provide(layer));

      expect(yield* Ref.get(calls)).toBe(1);
      // Jev's ranking wins over lexical's: it scored the GitHub tool, which the
      // lexical hit never contained, and the lexical score of 90 is not returned.
      expect(result.items.map((item) => item.path)).toEqual([
        "github.pulls.list",
      ]);
      expect(result.items[0]?.score).toBe(95);
    }));

  it.effect("rescues a cross-language query the lexical ranker drops entirely", () =>
    Effect.gen(function* () {
      // "tareas pendientes" shares no token with `linear.issues.list`, so the
      // lexical ranker returns nothing — the cliff this exists for.
      const { layer } = yield* jevReturning(
        `{"answers":{"0":{"noul":0.68},"1":{"noul":0.1}}}`,
      );
      const provider = makeJevToolDiscoveryProvider({
        gateway: { ...GATEWAY },
        httpClientLayer: layer,
        delegate: lexical(emptyPage),
      });

      const result = yield* provider
        .searchTools(input())
        .pipe(Effect.provide(layer));

      expect(result.items.map((item) => item.path)).toEqual([
        "linear.issues.list",
      ]);
      expect(result.items[0]?.score).toBe(68);
      expect(result.total).toBe(1);
    }));

  it.effect("keeps the lexical answer when Jev fails, so search never gets worse", () =>
    Effect.gen(function* () {
      const layer = Layer.succeed(HttpClient.HttpClient)(
        HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response("boom", { status: 500 }),
            ),
          ),
        ),
      );
      const provider = makeJevToolDiscoveryProvider({
        gateway: { ...GATEWAY },
        httpClientLayer: layer,
        delegate: lexical(emptyPage),
      });

      const result = yield* provider
        .searchTools(input())
        .pipe(Effect.provide(layer));

      expect(result).toEqual(emptyPage);
    }));

  it.effect("drops a weak opinion instead of offering it as a match", () =>
    Effect.gen(function* () {
      const { layer } = yield* jevReturning(
        `{"answers":{"0":{"noul":0.05},"1":{"noul":0.02}}}`,
      );
      const provider = makeJevToolDiscoveryProvider({
        gateway: { ...GATEWAY },
        httpClientLayer: layer,
        delegate: lexical(emptyPage),
      });

      const result = yield* provider
        .searchTools(input())
        .pipe(Effect.provide(layer));

      expect(result).toEqual(emptyPage);
    }));

  it.effect("skips the rescue for an empty query, which is enumeration not search", () =>
    Effect.gen(function* () {
      const { layer, calls } = yield* jevReturning(`{"answers":{}}`);
      const provider = makeJevToolDiscoveryProvider({
        gateway: { ...GATEWAY },
        httpClientLayer: layer,
        delegate: lexical(emptyPage),
      });

      yield* provider
        .searchTools(input({ query: "   " }))
        .pipe(Effect.provide(layer));

      expect(yield* Ref.get(calls)).toBe(0);
    }));

  it.effect("shards a catalog too large for one call rather than truncating it", () =>
    Effect.gen(function* () {
      // Descriptions are capped before scoring, so what fills a shard is the
      // number of tools. 400 of them does not fit one state budget.
      const many = Array.from({ length: 400 }, (_, index) => ({
        address: `tools.integration${index}.do.thing`,
        integration: `integration${index}`,
        name: `tool ${index}`,
        description: "d".repeat(400),
      }));
      const { layer, calls } = yield* jevReturning(`{"answers":{"0":{"noul":0.9}}}`);
      const provider = makeJevToolDiscoveryProvider({
        gateway: { ...GATEWAY },
        httpClientLayer: layer,
        delegate: lexical(emptyPage),
      });

      const result = yield* provider
        .searchTools(input({ executor: executorWith(many) }))
        .pipe(Effect.provide(layer));

      // Growth costs more calls, never a silently truncated catalog.
      expect(yield* Ref.get(calls)).toBeGreaterThan(1);
      // Each shard answers about ITS OWN tools, so id "0" resolves per shard and
      // every shard contributes its own top match.
      expect(result.items.length).toBe(yield* Ref.get(calls));
    }));

  it.effect("reads tools that carry an address rather than a path", () =>
    Effect.gen(function* () {
      // The catalog yields `address` (prefixed) and its own `integration`; reading
      // `path` off it directly was undefined and took the whole search down with
      // a TypeError in production.
      const addressed = [
        {
          address: "tools.linear.issues.list",
          name: "list issues",
          integration: "linear",
          description: "List Linear issues",
        },
      ];
      const { layer } = yield* jevReturning(`{"answers":{"0":{"noul":0.9}}}`);
      const provider = makeJevToolDiscoveryProvider({
        gateway: { ...GATEWAY },
        httpClientLayer: layer,
        delegate: lexical(emptyPage),
      });

      const result = yield* provider
        .searchTools(input({ executor: executorWith(addressed) }))
        .pipe(Effect.provide(layer));

      expect(result.items[0]?.path).toBe("linear.issues.list");
      expect(result.items[0]?.integration).toBe("linear");
    }));

  it.effect("scopes the rescue to the requested namespace", () =>
    Effect.gen(function* () {
      const { layer } = yield* jevReturning(`{"answers":{"0":{"noul":0.9}}}`);
      const provider = makeJevToolDiscoveryProvider({
        gateway: { ...GATEWAY },
        httpClientLayer: layer,
        delegate: lexical(emptyPage),
      });

      const result = yield* provider
        .searchTools(input({ namespace: "linear" }))
        .pipe(Effect.provide(layer));

      expect(result.items.map((item) => item.path)).toEqual([
        "linear.issues.list",
      ]);
    }));
});
