import { describe, expect, it } from "@effect/vitest";
// oxlint-disable-next-line executor/no-vitest-import -- vi.mock hoisting needs the vitest import
import { beforeEach, vi } from "vitest";

const { newQuickJSWASMModuleFromVariant, setQuickJSModule } = vi.hoisted(() => ({
  newQuickJSWASMModuleFromVariant: vi.fn(),
  setQuickJSModule: vi.fn(),
}));

vi.mock("quickjs-emscripten-core", () => ({
  newQuickJSWASMModuleFromVariant,
  newVariant: (base: unknown) => base,
}));
vi.mock("@jitl/quickjs-wasmfile-release-sync", () => ({ default: {} }));
vi.mock("./quickjs-engine.wasm", () => ({ default: {} }));
vi.mock("@executor-js/runtime-quickjs", () => ({ setQuickJSModule }));

describe("preloadQuickJs", () => {
  beforeEach(() => {
    vi.resetModules();
    newQuickJSWASMModuleFromVariant.mockReset();
    setQuickJSModule.mockReset();
  });

  it("builds the module once and shares it across calls", async () => {
    newQuickJSWASMModuleFromVariant.mockResolvedValue({ id: "module" });
    const { preloadQuickJs } = await import("./quickjs");

    await preloadQuickJs();
    await preloadQuickJs();

    expect(newQuickJSWASMModuleFromVariant).toHaveBeenCalledTimes(1);
    expect(setQuickJSModule).toHaveBeenCalledTimes(1);
    expect(setQuickJSModule).toHaveBeenCalledWith({ id: "module" });
  });

  // Documents current behavior: the rejected promise is memoized, so a failed
  // load is never retried within the isolate.
  it("keeps returning the same rejection after a failed load", async () => {
    newQuickJSWASMModuleFromVariant.mockRejectedValue("wasm load failed");
    const { preloadQuickJs } = await import("./quickjs");

    await expect(preloadQuickJs()).rejects.toBe("wasm load failed");
    newQuickJSWASMModuleFromVariant.mockResolvedValue({ id: "module" });
    await expect(preloadQuickJs()).rejects.toBe("wasm load failed");

    expect(newQuickJSWASMModuleFromVariant).toHaveBeenCalledTimes(1);
    expect(setQuickJSModule).not.toHaveBeenCalled();
  });
});
