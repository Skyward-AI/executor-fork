import { describe, expect, it } from "@effect/vitest";
// oxlint-disable-next-line executor/no-vitest-import -- vi.mock hoisting needs the vitest import
import { vi } from "vitest";

import type { CloudflareEnv } from "./config";

const { makeCloudflareApp, reconcileInternalIntegrationsOnce } = vi.hoisted(() => ({
  makeCloudflareApp: vi.fn(() =>
    Promise.resolve({
      toWebHandler: () => ({ handler: () => Promise.resolve(new Response("ok")) }),
      mcpAgentHandler: () => Promise.resolve(new Response("mcp")),
    }),
  ),
  reconcileInternalIntegrationsOnce: vi.fn(() => Promise.resolve()),
}));

vi.mock("./mcp", () => ({ McpExecutionOwnerDirectoryDO: class {}, McpSessionDO: class {} }));
vi.mock("./app", () => ({ makeCloudflareApp, reconcileInternalIntegrationsOnce }));

const { default: worker } = await import("./worker");

const makeEnv = (vars: Partial<CloudflareEnv>): CloudflareEnv =>
  // oxlint-disable-next-line executor/no-double-cast -- test double: only the vars the code under test reads are set
  vars as unknown as CloudflareEnv;

const ctx = (waited: Promise<unknown>[]): ExecutionContext => {
  const context = { waitUntil: (promise: Promise<unknown>) => waited.push(promise) };
  // oxlint-disable-next-line executor/no-double-cast -- test double: only waitUntil is used
  return context as unknown as ExecutionContext;
};

describe("worker", () => {
  it("serves a fetch without running a reconcile pass", async () => {
    const env = makeEnv({
      ENABLE_DEV_AUTH: "true",
      EXECUTOR_SECRET_KEY: "test-secret-key-0123456789abcdef",
    });

    const response = await worker.fetch(
      new Request("https://executor.test/api/scopes"),
      env,
      ctx([]),
    );

    expect(await response.text()).toBe("ok");
    expect(makeCloudflareApp).toHaveBeenCalledTimes(1);
    expect(reconcileInternalIntegrationsOnce).not.toHaveBeenCalled();
  });

  it("scheduled runs one reconcile pass inside waitUntil", async () => {
    const env = makeEnv({});
    const waited: Promise<unknown>[] = [];

    // oxlint-disable-next-line executor/no-double-cast -- test double: the handler ignores the controller
    worker.scheduled({} as unknown as ScheduledController, env, ctx(waited));

    expect(reconcileInternalIntegrationsOnce).toHaveBeenCalledTimes(1);
    expect(reconcileInternalIntegrationsOnce).toHaveBeenCalledWith(env);
    expect(waited).toHaveLength(1);
    await Promise.all(waited);
  });
});
