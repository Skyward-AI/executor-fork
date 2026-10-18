import { describe, expect, it } from "@effect/vitest";
// oxlint-disable-next-line executor/no-vitest-import -- vi.mock hoisting needs the vitest import
import { vi } from "vitest";
import { Effect } from "effect";

import { CodeExecutorProvider } from "@executor-js/api/server";

const { loadQuickJs } = vi.hoisted(() => ({ loadQuickJs: vi.fn() }));

vi.mock("./quickjs", () => ({ loadQuickJs }));
vi.mock("./mcp", () => ({ McpExecutionOwnerDirectoryDO: class {}, McpSessionDO: class {} }));
vi.mock("./app", () => ({
  makeCloudflareApp: vi.fn(),
  reconcileInternalIntegrationsOnce: vi.fn(),
}));

await import("./worker");
const { CloudflareCodeExecutorProvider } = await import("./execution");

describe("CloudflareCodeExecutorProvider", () => {
  it.effect("does not load QuickJS when the worker starts or the provider is built", () =>
    Effect.gen(function* () {
      yield* CodeExecutorProvider.asEffect().pipe(Effect.provide(CloudflareCodeExecutorProvider));

      expect(loadQuickJs).not.toHaveBeenCalled();
    }),
  );
});
