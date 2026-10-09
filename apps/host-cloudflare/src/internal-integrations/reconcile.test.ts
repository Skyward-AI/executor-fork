import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { createExecutor, IntegrationSlug } from "@executor-js/sdk";
import { makeHostedFetch, makeHostedHttpClientLayer } from "@executor-js/sdk/host-internal";
import { makeTestConfig } from "@executor-js/sdk/testing";
import { makeAnnotationsMcpServer } from "@executor-js/plugin-mcp/testing";

import type { InternalIntegration } from "../config";
import { makeCloudflarePlugins } from "../plugins";
import { reconcileInternalIntegrations } from "./reconcile";

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const FIXTURE: InternalIntegration = {
  slug: "fixture",
  name: "Fixture",
  description: "A fixture tool server",
  endpoint: "https://tools.internal/mcp/fixture",
};

const makeBinding = () => {
  const methods: string[] = [];
  return {
    methods,
    fetch: async (request: Request) => {
      const body = decodeJson(await request.clone().text());
      if (Option.isSome(body) && typeof body.value === "object" && body.value !== null) {
        if ("method" in body.value) {
          methods.push(`${new URL(request.url).pathname} ${String(body.value.method)}`);
        }
      }
      const server = makeAnnotationsMcpServer();
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await server.connect(transport);
      return transport.handleRequest(request);
    },
  };
};

const makeExecutor = (binding: ReturnType<typeof makeBinding>) =>
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
});
