import { describe, expect, it } from "@effect/vitest";
import { Effect, Logger } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { ExecutionEngine, ExecutionResult } from "@executor-js/execution";
import {
  ConnectionName,
  IntegrationSlug,
  ToolAddress,
  ToolName,
  type Tool,
  type ToolSchemaView,
} from "@executor-js/sdk";

import { createExecutorMcpServer, type McpToolsPort } from "./tool-server";

interface LogLine {
  readonly level: string;
  readonly message: unknown;
}

const capturingLogger = (lines: LogLine[]) =>
  Logger.make<unknown, void>((options) => {
    lines.push({ level: options.logLevel, message: options.message });
  });

/** The fields of every "executor mcp tool call" line, in order. */
function toolCallFields(lines: readonly LogLine[]): Record<string, unknown>[] {
  return lines.flatMap((line) => {
    const parts = Array.isArray(line.message) ? line.message : [line.message];
    if (parts[0] !== "executor mcp tool call") return [];
    expect(line.level).toBe("Info");
    return [parts[1] as Record<string, unknown>];
  });
}

const githubTool: Tool = {
  address: ToolAddress.make("tools.github.org.main.issues.list"),
  integration: IntegrationSlug.make("github"),
  owner: "org",
  connection: ConnectionName.make("main"),
  name: ToolName.make("issues.list"),
  pluginId: "test",
  description: "List issues",
  inputSchema: { type: "object" },
};

const toolPort: McpToolsPort = {
  list: () => Effect.succeed([githubTool]),
  schema: (address) =>
    Effect.succeed(
      address === githubTool.address
        ? ({
            address,
            name: githubTool.name,
            inputSchema: { type: "object" },
          } satisfies ToolSchemaView)
        : null,
    ),
};

function stubEngine(overrides: Partial<ExecutionEngine>): ExecutionEngine {
  return {
    execute: () => Effect.succeed({ result: null }),
    call: () => Effect.succeed({ result: null }),
    executeWithPause: () => Effect.succeed({ status: "completed", result: { result: null } }),
    resume: () => Effect.succeed(null),
    getPausedExecution: () => Effect.succeed(null),
    pausedExecutionCount: () => Effect.succeed(0),
    hasPausedExecutions: () => Effect.succeed(false),
    getDescription: Effect.succeed("test executor"),
    shutdown: Effect.void,
    ...overrides,
  };
}

async function callTool(
  config: {
    readonly engine: ExecutionEngine;
    readonly mode?: "passthrough";
    readonly elicitationMode?: { readonly mode: "model" };
  },
  calls: ReadonlyArray<{ readonly name: string; readonly arguments: Record<string, unknown> }>,
): Promise<Record<string, unknown>[]> {
  const lines: LogLine[] = [];
  const mcpServer = await Effect.runPromise(
    createExecutorMcpServer({
      ...config,
      codeRuntime: "dynamic-worker",
      tools: toolPort,
      connections: { list: () => Effect.succeed([]) },
      integrations: { list: () => Effect.succeed([]) },
    }).pipe(Effect.provide(Logger.layer([capturingLogger(lines)]))),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "probe-client", version: "2.3.4" }, { capabilities: {} });
  await mcpServer.connect(serverTransport);
  await client.connect(clientTransport);
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: test helper must close MCP transports after async client assertions
  try {
    for (const call of calls) await client.callTool(call);
  } finally {
    await clientTransport.close();
    await serverTransport.close();
  }
  return toolCallFields(lines);
}

const SECRET_CODE = 'return await tools.github.org.main.issues.list({ token: "sk-secret" })';

describe("one log line per MCP tool call", () => {
  it("logs a passthrough invoke as a direct call, without arguments or results", async () => {
    const engine = stubEngine({
      call: () =>
        Effect.succeed({
          result: { ok: true, data: { secretResult: "do-not-log" } },
          toolPaths: ["github.org.main.issues.list"],
        }),
    });
    const fields = await callTool({ engine, mode: "passthrough" }, [
      {
        name: "invoke",
        arguments: { tool: "tools.github.org.main.issues.list", arguments: { q: "sk-secret" } },
      },
    ]);
    expect(fields).toEqual([
      {
        tool: "invoke",
        runtime: "direct",
        mode: "passthrough",
        client: "probe-client/2.3.4",
        toolCalls: 1,
        discoveryOnly: false,
        durationMs: expect.any(Number),
        outcome: "ok",
      },
    ]);
    expect(JSON.stringify(fields)).not.toContain("sk-secret");
    expect(JSON.stringify(fields)).not.toContain("do-not-log");
  });

  it("logs a failed passthrough tool result as a tool_error", async () => {
    const engine = stubEngine({
      call: () =>
        Effect.succeed({ result: { ok: false, error: { code: "tool_blocked", message: "x" } } }),
    });
    const fields = await callTool({ engine, mode: "passthrough" }, [
      { name: "invoke", arguments: { tool: "tools.github.org.main.issues.list", arguments: {} } },
    ]);
    expect(fields).toMatchObject([{ tool: "invoke", toolCalls: 0, outcome: "tool_error" }]);
  });

  it("logs an execute that called no connected tool as discovery only", async () => {
    const code = 'return await tools.search({ query: "issues" })';
    const engine = stubEngine({
      executeWithPause: () =>
        Effect.succeed({ status: "completed", result: { result: { items: [] } } }),
    });
    const fields = await callTool({ engine }, [{ name: "execute", arguments: { code } }]);
    expect(fields).toEqual([
      {
        tool: "execute",
        runtime: "dynamic-worker",
        mode: "code",
        client: "probe-client/2.3.4",
        toolCalls: 0,
        discoveryOnly: true,
        codeLength: code.length,
        durationMs: expect.any(Number),
        outcome: "ok",
      },
    ]);
  });

  it("counts the connected tool calls of an execute and never logs its code", async () => {
    const engine = stubEngine({
      executeWithPause: () =>
        Effect.succeed({
          status: "completed",
          result: {
            result: null,
            toolPaths: ["github.org.main.issues.list", "github.org.main.issues.list"],
          },
        }),
    });
    const fields = await callTool({ engine }, [
      { name: "execute", arguments: { code: SECRET_CODE } },
    ]);
    expect(fields).toMatchObject([
      { tool: "execute", toolCalls: 2, discoveryOnly: false, outcome: "ok" },
    ]);
    expect(JSON.stringify(fields)).not.toContain("sk-secret");
  });

  it("logs the outcome of a failed, a thrown, and a paused execute", async () => {
    const paused: ExecutionResult = {
      status: "paused",
      execution: {
        id: "exec_1",
        elicitationContext: {
          address: githubTool.address,
          args: {},
          request: { _tag: "FormElicitation", message: "Approve?", requestedSchema: {} },
        },
      },
    };
    const outcomes: ExecutionResult[] = [
      {
        status: "completed",
        result: { result: null, error: "declined", errorKind: "tool_error" },
      },
      { status: "completed", result: { result: null, error: "boom", errorKind: "thrown" } },
      paused,
    ];
    const engine = stubEngine({
      executeWithPause: () => Effect.sync(() => outcomes.shift()!),
    });
    const fields = await callTool({ engine, elicitationMode: { mode: "model" } }, [
      { name: "execute", arguments: { code: "return 1" } },
      { name: "execute", arguments: { code: "return 2" } },
      { name: "execute", arguments: { code: "return 3" } },
    ]);
    expect(fields.map((field) => [field.outcome, field.discoveryOnly])).toEqual([
      ["tool_error", false],
      ["error", false],
      ["paused", false],
    ]);
  });

  it("logs a resume with the runtime that continued the execution", async () => {
    const engine = stubEngine({
      resume: () =>
        Effect.succeed({
          status: "completed",
          result: { result: null, toolPaths: ["github.org.main.issues.list"] },
        }),
    });
    const fields = await callTool({ engine, elicitationMode: { mode: "model" } }, [
      { name: "resume", arguments: { executionId: "exec_1", action: "accept" } },
    ]);
    expect(fields).toEqual([
      {
        tool: "resume",
        runtime: "dynamic-worker",
        mode: "code",
        client: "probe-client/2.3.4",
        toolCalls: 1,
        discoveryOnly: false,
        durationMs: expect.any(Number),
        outcome: "ok",
      },
    ]);
  });

  it("logs an engine failure as an error", async () => {
    const engine = stubEngine({ executeWithPause: () => Effect.die("sandbox down") });
    const fields = await callTool({ engine }, [{ name: "execute", arguments: { code: "x" } }]);
    expect(fields).toMatchObject([
      { tool: "execute", runtime: "dynamic-worker", discoveryOnly: false, outcome: "error" },
    ]);
  });
});
