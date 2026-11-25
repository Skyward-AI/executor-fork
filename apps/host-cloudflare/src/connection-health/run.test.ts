import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type { Executor, ExecutorAdmin } from "@executor-js/sdk";

import type { BackgroundJob } from "../background";
import type { CloudflareConfig } from "../config";
import { connectionHealthSweepFor, consoleUrlFor } from "./run";

describe("consoleUrlFor", () => {
  it("links an integration's page under the console's org slug", () => {
    const url = consoleUrlFor({ webBaseUrl: "https://console.test/", organizationSlug: "acme" });
    expect(url("cloudflare_mcp")).toBe("https://console.test/acme/integrations/cloudflare_mcp");
    expect(url("a b")).toBe("https://console.test/acme/integrations/a%20b");
  });

  it("is null when the deployment does not pin its origin", () => {
    expect(consoleUrlFor({ webBaseUrl: undefined, organizationSlug: "acme" })("x")).toBeNull();
  });
});

describe("connectionHealthSweepFor", () => {
  it.effect("checks as the system principal and as each member, never recording a sighting", () =>
    Effect.gen(function* () {
      const calls: { subject: string; options: unknown }[] = [];
      const executor = {} as Executor;
      const frame: Pick<BackgroundJob, "config" | "accountId" | "actingAs"> = {
        config: {
          organizationId: "acme",
          organizationSlug: "acme",
          webBaseUrl: "https://console.test",
        } as CloudflareConfig,
        accountId: "svc",
        actingAs: (subject, options) => {
          calls.push({ subject, options });
          return Effect.succeed(executor as never);
        },
      };

      const sweep = yield* Effect.scoped(connectionHealthSweepFor(frame, {} as ExecutorAdmin));
      yield* Effect.scoped(sweep.asMember("alice"));

      expect(calls).toEqual([
        { subject: "svc", options: { orgWrites: "allowed", recordSighting: false } },
        { subject: "alice", options: { orgWrites: "denied", recordSighting: false } },
      ]);
      expect(sweep.consoleUrl("x")).toBe("https://console.test/acme/integrations/x");
    }),
  );
});
