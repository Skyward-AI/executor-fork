import { Context, Effect, Exit } from "effect";

import type { ExecutionResult } from "@executor-js/execution";
import { isToolResult } from "@executor-js/sdk";

type ExecuteResult = Extract<ExecutionResult, { status: "completed" }>["result"];

/** The code runtime the engine's code executor uses. `sandbox` when the host
 *  did not say which one. */
export type McpCodeRuntime = "dynamic-worker" | "quickjs" | "sandbox";

export type McpToolCallRuntime = McpCodeRuntime | "direct" | "none";

export type McpLoggedTool = "execute" | "invoke" | "execute_action" | "search_namespace" | "resume";

type McpToolCallOutcome = "ok" | "tool_error" | "error" | "paused";

/** What the engine did for one MCP tool call. Written by `trackEngineRun`,
 *  read once when the call ends. */
interface EngineRun {
  runtime: McpToolCallRuntime;
  result?: ExecutionResult;
}

const CurrentEngineRun = Context.Reference<EngineRun | null>("executor/mcp/CurrentEngineRun", {
  defaultValue: () => null,
});

/** Record that `engine` ran on `runtime`, and what it returned. */
export const trackEngineRun = <A extends ExecutionResult | ExecuteResult | null, E>(
  runtime: McpToolCallRuntime,
  engine: Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    const run = yield* CurrentEngineRun;
    if (run) run.runtime = runtime;
    const result = yield* engine;
    if (run && result) {
      run.result = "status" in result ? result : { status: "completed", result };
    } else if (run) {
      run.runtime = "none";
    }
    return result;
  });

const outcomeOf = (run: EngineRun, exit: Exit.Exit<{ readonly isError?: boolean }, unknown>) => {
  if (Exit.isFailure(exit)) return "error" satisfies McpToolCallOutcome;
  if (run.result?.status === "paused") return "paused" satisfies McpToolCallOutcome;
  const result = run.result?.result;
  if (!result) return exit.value.isError ? "error" : "ok";
  if (result.error) return result.errorKind === "tool_error" ? "tool_error" : "error";
  if (run.runtime === "direct" && isToolResult(result.result) && !result.result.ok) {
    return "tool_error";
  }
  return "ok";
};

/**
 * Run one MCP tool call and then emit exactly one `executor mcp tool call`
 * info line: which tool, where it ran, how many connected tools it called,
 * and how it ended. It never carries arguments, code, results, or secrets.
 */
export const logToolCall = <A extends { readonly isError?: boolean }, E>(
  input: {
    readonly tool: McpLoggedTool;
    readonly client: () => string | undefined;
    readonly codeLength?: number;
  },
  effect: Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.suspend(() => {
    const startedAt = Date.now();
    const run: EngineRun = { runtime: "none" };
    return effect.pipe(
      Effect.provideService(CurrentEngineRun, run),
      Effect.onExit((exit) => {
        const outcome = outcomeOf(run, exit);
        const toolCalls =
          run.result?.status === "completed" ? (run.result.result.toolPaths?.length ?? 0) : 0;
        const ranCode = run.runtime !== "direct" && run.runtime !== "none";
        const client = input.client();
        return Effect.logInfo("executor mcp tool call", {
          tool: input.tool,
          runtime: run.runtime,
          mode: input.tool === "invoke" ? "passthrough" : "code",
          ...(client === undefined ? {} : { client }),
          toolCalls,
          discoveryOnly: ranCode && outcome === "ok" && toolCalls === 0,
          ...(input.codeLength === undefined ? {} : { codeLength: input.codeLength }),
          durationMs: Date.now() - startedAt,
          outcome,
        });
      }),
    );
  });
