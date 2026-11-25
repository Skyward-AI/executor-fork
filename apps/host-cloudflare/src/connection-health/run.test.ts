import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { consoleUrlFor, reportTo } from "./run";
import type { ConnectionHealthSnapshot } from "./snapshot";

const SNAPSHOT: ConnectionHealthSnapshot = {
  tenant: "acme",
  observedAt: 1,
  verdicts: [
    {
      owner: "org",
      subject: null,
      integration: "probe",
      integrationName: "Probe",
      name: "main",
      url: null,
      evidence: "failing",
      status: "expired",
      reason: "credential_refresh_rejected",
      httpStatus: 400,
      checkedAt: 1,
    },
  ],
};

describe("reportTo", () => {
  it.effect("hands the whole snapshot to the receiver in one call", () =>
    Effect.gen(function* () {
      const received: unknown[] = [];
      yield* reportTo({
        report: (snapshot) => {
          received.push(snapshot);
          return Promise.resolve({ received: 1 });
        },
      })(SNAPSHOT);

      expect(received).toEqual([SNAPSHOT]);
    }),
  );

  it.effect("a receiver that rejects does not fail the sweep", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        // oxlint-disable-next-line executor/no-promise-reject -- boundary: stand-in for a failing RPC binding
        reportTo({ report: () => Promise.reject("no such method") })(SNAPSHOT),
      );

      expect(Exit.isSuccess(exit)).toBe(true);
    }),
  );

  it.effect("a receiver that never answers is given up on after 30 seconds", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        reportTo({ report: () => new Promise(() => undefined) })(SNAPSHOT),
      );
      yield* TestClock.adjust("30 seconds");
      const exit = yield* Fiber.await(fiber);

      expect(Exit.isSuccess(exit)).toBe(true);
    }),
  );

  it.effect("without a receiver nothing is sent", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(reportTo(undefined)(SNAPSHOT));

      expect(Exit.isSuccess(exit)).toBe(true);
    }),
  );
});

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
