import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "node:http";

import { createEmulator } from "@executor-js/emulate";
import type { ExecutionEngine } from "@executor-js/execution";
import { createExecutor, AuthTemplateSlug, ConnectionName, ToolAddress } from "@executor-js/sdk";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";
import { openApiPlugin } from "@executor-js/plugin-openapi";
import { slackWebApiAdapter } from "@executor-js/plugin-openapi/providers/slack";

import { createExecutorMcpServer } from "./tool-server";

const BOT_TOKEN = "xoxb-test-token";

const form = (properties: Record<string, unknown>) => ({
  required: true,
  content: { "application/x-www-form-urlencoded": { schema: { type: "object", properties } } },
});

// The published Slack spec types every timestamp input as `number`.
const publishedSlackSpec = (apiUrl: string) => ({
  openapi: "3.0.0",
  info: { title: "Slack Web API", version: "1.7.0" },
  servers: [{ url: apiUrl }],
  paths: {
    "/conversations.history": {
      post: {
        operationId: "conversations_history",
        tags: ["conversations"],
        requestBody: form({
          channel: { type: "string" },
          latest: { type: "number", default: 0 },
          oldest: { type: "number", default: 0 },
          inclusive: { type: "boolean" },
        }),
        responses: { "200": { description: "OK" } },
      },
    },
    "/conversations.replies": {
      post: {
        operationId: "conversations_replies",
        tags: ["conversations"],
        requestBody: form({ channel: { type: "string" }, ts: { type: "number" } }),
        responses: { "200": { description: "OK" } },
      },
    },
  },
});

const serveJson = (body: unknown) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ readonly url: string; readonly close: () => void }>((resolve) => {
          const server = createServer((_request, response) => {
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify(body));
          });
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = typeof address === "object" && address ? address.port : 0;
            resolve({ url: `http://127.0.0.1:${port}/openapi.json`, close: () => server.close() });
          });
        }),
    ),
    (server) => Effect.sync(() => server.close()),
  );

const emulatorFetch = (url: string, body: Record<string, string>) =>
  Effect.promise(async () => {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${BOT_TOKEN}` },
      body: new URLSearchParams(body),
    });
    return (await response.json()) as { readonly ts: string };
  });

it.effect(
  "invoke accepts Slack string timestamps and reads history and threads from the emulator",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const emulator = yield* Effect.acquireRelease(
          Effect.promise(() =>
            createEmulator({
              service: "slack",
              seed: {
                tokens: {
                  [BOT_TOKEN]: { login: "admin", scopes: ["chat:write", "channels:history"] },
                },
                slack: { channels: [{ name: "general" }] },
              },
            }),
          ),
          (running) => Effect.promise(() => running.close()),
        );
        const apiUrl = `${emulator.url}/api`;
        const channel = "C000000001";
        const root = yield* emulatorFetch(`${apiUrl}/chat.postMessage`, { channel, text: "root" });
        const reply = yield* emulatorFetch(`${apiUrl}/chat.postMessage`, {
          channel,
          text: "reply",
          thread_ts: root.ts,
        });

        const spec = yield* serveJson(publishedSlackSpec(apiUrl));
        const executor = yield* createExecutor(
          makeTestConfig({
            plugins: [
              openApiPlugin({
                httpClientLayer: FetchHttpClient.layer,
                specFormats: [slackWebApiAdapter],
              }),
              memoryCredentialsPlugin(),
            ] as const,
          }),
        );
        yield* executor.openapi.addSpec({
          spec: { kind: "url", url: spec.url },
          specFormat: "slack-web-api",
          slug: "slack",
          baseUrl: apiUrl,
          authenticationTemplate: [
            {
              slug: AuthTemplateSlug.make("bearer"),
              type: "apiKey",
              headers: { authorization: ["Bearer ", { type: "variable" as const, name: "token" }] },
            },
          ],
        });
        yield* executor.connections.create({
          owner: "org",
          name: ConnectionName.make("main"),
          integration: "slack" as never,
          template: AuthTemplateSlug.make("bearer"),
          value: BOT_TOKEN,
        });

        const engine: ExecutionEngine = {
          execute: () => Effect.die("invoke never runs code"),
          call: (address, args) =>
            executor.execute(ToolAddress.make(address), args).pipe(
              Effect.map((result) => ({ result })),
              Effect.orDie,
            ),
          executeWithPause: () => Effect.die("invoke never pauses"),
          resume: () => Effect.succeed(null),
          isExecutionSettled: undefined,
          getPausedExecution: () => Effect.succeed(null),
          pausedExecutionCount: () => Effect.succeed(0),
          hasPausedExecutions: () => Effect.succeed(false),
          getDescription: Effect.succeed("slack"),
          shutdown: Effect.void,
        };
        const mcpServer = yield* createExecutorMcpServer({
          engine,
          mode: "passthrough",
          tools: executor.tools,
          connections: { list: () => Effect.succeed([]) },
          integrations: { list: () => Effect.succeed([]) },
        });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
        yield* Effect.promise(() => mcpServer.connect(serverTransport));
        yield* Effect.promise(() => client.connect(clientTransport));

        const invoke = (tool: string, args: Record<string, unknown>) =>
          Effect.promise(() =>
            client.callTool({
              name: "invoke",
              arguments: { tool: `tools.slack.org.main.${tool}`, arguments: args },
            }),
          );

        const history = yield* invoke("conversations.conversationsHistory", {
          body: { channel, latest: reply.ts, oldest: "0", inclusive: true },
        });
        expect(JSON.stringify(history.content)).not.toContain("Invalid arguments");
        expect(history.isError ?? false).toBe(false);
        expect(JSON.stringify(history.content)).toContain(root.ts);

        const replies = yield* invoke("conversations.conversationsReplies", {
          body: { channel, ts: root.ts },
        });
        expect(replies.isError ?? false).toBe(false);
        expect(JSON.stringify(replies.content)).toContain(reply.ts);

        yield* Effect.promise(() => clientTransport.close());
      }),
    ),
  { timeout: 30_000 },
);
