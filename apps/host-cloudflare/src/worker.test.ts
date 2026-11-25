import { readFileSync } from "node:fs";

import { describe, expect, it } from "@effect/vitest";
import { parse } from "jsonc-parser";
// oxlint-disable-next-line executor/no-vitest-import -- vi.mock hoisting needs the vitest import
import { vi } from "vitest";

import type { CloudflareEnv } from "./config";

const { makeCloudflareApp, reconcileInternalIntegrationsOnce, sweepConnectionHealthOnce } =
  vi.hoisted(() => ({
    makeCloudflareApp: vi.fn(() =>
      Promise.resolve({
        toWebHandler: () => ({ handler: () => Promise.resolve(new Response("ok")) }),
        mcpAgentHandler: () => Promise.resolve(new Response("mcp")),
      }),
    ),
    reconcileInternalIntegrationsOnce: vi.fn(() => Promise.resolve()),
    sweepConnectionHealthOnce: vi.fn(() => Promise.resolve()),
  }));

vi.mock("./mcp", () => ({ McpExecutionOwnerDirectoryDO: class {}, McpSessionDO: class {} }));
vi.mock("./app", () => ({ makeCloudflareApp, reconcileInternalIntegrationsOnce }));
vi.mock("./connection-health/run", () => ({ sweepConnectionHealthOnce }));

const { default: worker } = await import("./worker");
const { CONNECTION_HEALTH_CRON, JOBS } = await import("./scheduled");

const makeEnv = (vars: Partial<CloudflareEnv>): CloudflareEnv =>
  // oxlint-disable-next-line executor/no-double-cast -- test double: only the vars the code under test reads are set
  vars as unknown as CloudflareEnv;

const controller = (cron: string): ScheduledController => {
  const value = { cron };
  // oxlint-disable-next-line executor/no-double-cast -- test double: the handler reads only `cron`
  return value as unknown as ScheduledController;
};

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

  it("the every-minute trigger runs one reconcile pass inside waitUntil", async () => {
    const env = makeEnv({});
    const waited: Promise<unknown>[] = [];

    worker.scheduled(controller("* * * * *"), env, ctx(waited));

    expect(reconcileInternalIntegrationsOnce).toHaveBeenCalledTimes(1);
    expect(reconcileInternalIntegrationsOnce).toHaveBeenCalledWith(env);
    expect(sweepConnectionHealthOnce).not.toHaveBeenCalled();
    expect(waited).toHaveLength(1);
    await Promise.all(waited);
  });

  it("the hourly trigger runs one connection health sweep instead", async () => {
    reconcileInternalIntegrationsOnce.mockClear();
    const env = makeEnv({});
    const waited: Promise<unknown>[] = [];

    worker.scheduled(controller(CONNECTION_HEALTH_CRON), env, ctx(waited));

    expect(sweepConnectionHealthOnce).toHaveBeenCalledTimes(1);
    expect(sweepConnectionHealthOnce).toHaveBeenCalledWith(env);
    expect(reconcileInternalIntegrationsOnce).not.toHaveBeenCalled();
    expect(waited).toHaveLength(1);
    await Promise.all(waited);
  });

  it("an unknown trigger runs no job", async () => {
    reconcileInternalIntegrationsOnce.mockClear();
    sweepConnectionHealthOnce.mockClear();
    const waited: Promise<unknown>[] = [];

    worker.scheduled(controller("*/5 * * * *"), makeEnv({}), ctx(waited));
    await Promise.all(waited);

    expect(reconcileInternalIntegrationsOnce).not.toHaveBeenCalled();
    expect(sweepConnectionHealthOnce).not.toHaveBeenCalled();
  });

  it("declares in wrangler.jsonc exactly the crons that have a job", () => {
    const config = parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")) as {
      readonly triggers?: { readonly crons?: readonly string[] };
    };

    expect([...(config.triggers?.crons ?? [])].sort()).toEqual([...JOBS.keys()].sort());
  });

  it("runs no job for a cron named like an object property", async () => {
    const waited: Promise<unknown>[] = [];
    worker.scheduled(controller("constructor"), makeEnv({}), ctx(waited));
    await Promise.all(waited);

    expect(reconcileInternalIntegrationsOnce).not.toHaveBeenCalled();
    expect(sweepConnectionHealthOnce).not.toHaveBeenCalled();
  });
});
