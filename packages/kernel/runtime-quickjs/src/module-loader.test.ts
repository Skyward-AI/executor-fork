import { describe, expect, it } from "@effect/vitest";
// oxlint-disable-next-line executor/no-vitest-import -- vi.resetModules gives each test fresh module-level loader state
import { beforeEach, vi } from "vitest";
import * as Effect from "effect/Effect";
import { getQuickJS } from "quickjs-emscripten";

// The loader seam is module-level state, so every test imports a fresh copy.
const freshRuntime = () => import("./index");

const run = (runtime: Awaited<ReturnType<typeof freshRuntime>>) =>
  Effect.runPromise(runtime.executeSealedBundle({ bundle: "globalThis.value = 1;", call: "'ok'" }));

describe("setQuickJSModuleLoader", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("does not call the loader until the first resolve", async () => {
    const runtime = await freshRuntime();
    let calls = 0;
    runtime.setQuickJSModuleLoader(() => {
      calls += 1;
      return getQuickJS();
    });

    expect(calls).toBe(0);
    await run(runtime);
    expect(calls).toBe(1);
  });

  it("calls the loader once across many resolves", async () => {
    const runtime = await freshRuntime();
    let calls = 0;
    runtime.setQuickJSModuleLoader(() => {
      calls += 1;
      return getQuickJS();
    });

    await Promise.all([run(runtime), run(runtime), run(runtime)]);
    await run(runtime);

    expect(calls).toBe(1);
  });

  it("prefers a preloaded module over the loader", async () => {
    const runtime = await freshRuntime();
    let calls = 0;
    runtime.setQuickJSModuleLoader(() => {
      calls += 1;
      return getQuickJS();
    });
    runtime.setQuickJSModule(await getQuickJS());

    await run(runtime);

    expect(calls).toBe(0);
  });

  it("retries the loader on the next resolve after a rejected load", async () => {
    const runtime = await freshRuntime();
    let calls = 0;
    runtime.setQuickJSModuleLoader(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error("wasm load failed")) : getQuickJS();
    });

    await expect(run(runtime)).rejects.toThrow("wasm load failed");
    await expect(run(runtime)).resolves.toBe("ok");

    expect(calls).toBe(2);
  });

  it("serves the sealed bundle runner and the executor from the same loader", async () => {
    const runtime = await freshRuntime();
    let calls = 0;
    runtime.setQuickJSModuleLoader(() => {
      calls += 1;
      return getQuickJS();
    });

    await run(runtime);
    const executed = await Effect.runPromise(
      runtime.makeQuickJsExecutor().execute("return 1 + 2", { invoke: () => Effect.void }),
    );

    expect(executed.result).toBe(3);
    expect(calls).toBe(1);
  });
});
