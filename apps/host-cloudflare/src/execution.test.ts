import { describe, expect, it } from "@effect/vitest";
// oxlint-disable-next-line executor/no-vitest-import -- vi.mock hoisting needs the vitest import
import { beforeEach, vi } from "vitest";
import { Effect, Exit } from "effect";

import { CodeExecutorProvider } from "@executor-js/api/server";
import { env } from "cloudflare:workers";

const { preloadQuickJs } = vi.hoisted(() => ({
  preloadQuickJs: vi.fn((): Promise<void> => Promise.resolve()),
}));

// oxlint-disable-next-line executor/no-promise-reject -- test boundary: a rejected dynamic import is a Promise rejection
const failLoad = (): Promise<void> => Promise.reject("wasm load failed");

const workerEnv = env as Record<string, unknown>;

vi.mock("./quickjs", () => ({ preloadQuickJs }));

const { CloudflareCodeExecutorProvider, withLazyPreload } = await import("./execution");

const makeInner = (calls: string[]) => ({
  execute: (code: string) => {
    calls.push(`execute:${code}`);
    return Effect.succeed({ result: code });
  },
});

describe("withLazyPreload", () => {
  it.effect("loads nothing until the first execute, then runs the code", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const preload = () => {
        calls.push("preload");
        return Promise.resolve();
      };
      const executor = withLazyPreload(
        // oxlint-disable-next-line executor/no-double-cast -- test double: only execute is used
        makeInner(calls) as unknown as Parameters<typeof withLazyPreload>[0],
        preload,
      );

      expect(calls).toEqual([]);

      // oxlint-disable-next-line executor/no-double-cast -- test double: the invoker is never called
      const invoker = {} as unknown as Parameters<typeof executor.execute>[1];
      const outcome = yield* executor.execute("1 + 1", invoker);

      expect(calls).toEqual(["preload", "execute:1 + 1"]);
      expect(outcome).toEqual({ result: "1 + 1" });
    }),
  );
});

const makeInvoker = () =>
  // oxlint-disable-next-line executor/no-double-cast -- test double: the code under test never calls a tool
  ({}) as unknown as Parameters<Effect.Success<typeof CodeExecutorProvider.asEffect>["execute"]>[1];

const buildProvider = CodeExecutorProvider.asEffect().pipe(
  Effect.provide(CloudflareCodeExecutorProvider),
);

describe("CloudflareCodeExecutorProvider", () => {
  beforeEach(() => {
    preloadQuickJs.mockReset();
    preloadQuickJs.mockImplementation(() => Promise.resolve());
    delete workerEnv.LOADER;
  });

  it.effect("does not load QuickJS when the provider is built", () =>
    Effect.gen(function* () {
      yield* buildProvider;

      expect(preloadQuickJs).not.toHaveBeenCalled();
    }),
  );

  it.effect("asks for the QuickJS load on the first execute and again on each later one", () =>
    Effect.gen(function* () {
      const executor = yield* buildProvider;
      expect(preloadQuickJs).toHaveBeenCalledTimes(0);

      yield* executor.execute("1 + 1", makeInvoker());
      expect(preloadQuickJs).toHaveBeenCalledTimes(1);

      yield* executor.execute("2 + 2", makeInvoker());
      expect(preloadQuickJs).toHaveBeenCalledTimes(2);
    }),
  );

  it.effect("fails execute without running code when the QuickJS load rejects", () =>
    Effect.gen(function* () {
      preloadQuickJs.mockImplementation(failLoad);
      const executor = yield* buildProvider;

      const exit = yield* Effect.exit(executor.execute("1 + 1", makeInvoker()));

      expect(Exit.isFailure(exit)).toBe(true);
      expect(preloadQuickJs).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("asks for the load again on the next execute after a failed load", () =>
    Effect.gen(function* () {
      preloadQuickJs.mockImplementationOnce(failLoad);
      const executor = yield* buildProvider;

      yield* Effect.exit(executor.execute("1 + 1", makeInvoker()));
      const retry = yield* Effect.exit(executor.execute("1 + 1", makeInvoker()));

      expect(preloadQuickJs).toHaveBeenCalledTimes(2);
      expect(Exit.isSuccess(retry)).toBe(true);
    }),
  );

  it.effect("never loads QuickJS when a LOADER binding is present", () =>
    Effect.gen(function* () {
      workerEnv.LOADER = {};
      const executor = yield* buildProvider;

      yield* Effect.exit(executor.execute("1 + 1", makeInvoker()));

      expect(preloadQuickJs).not.toHaveBeenCalled();
    }),
  );
});
