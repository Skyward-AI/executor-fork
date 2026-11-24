import { createHmac } from "node:crypto";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";

import { makeStandardWebhookSender, webhookSigningKey } from "./standard-webhook";

const KEY = Buffer.from("health-webhook-signing-key-bytes");
const SECRET = `whsec_${KEY.toString("base64")}`;
const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);
const WEBHOOK = { url: "https://hooks.test/executor", key: new Uint8Array(KEY) };
const DATA = { connection: { name: "main" }, current: { status: "expired" } };

const capture = (status = 204) => {
  const requests: Request[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    requests.push(new Request(input, init));
    return Promise.resolve(new Response(null, { status }));
  };
  return { requests, fetch };
};

describe("makeStandardWebhookSender", () => {
  it.effect("posts a message any Standard Webhooks verifier accepts", () =>
    Effect.gen(function* () {
      const { requests, fetch } = capture();
      const send = makeStandardWebhookSender(WEBHOOK, { fetch, now: () => NOW });

      yield* send("connection.health", DATA);

      expect(requests).toHaveLength(1);
      const request = requests[0]!;
      expect(request.method).toBe("POST");
      expect(request.url).toBe("https://hooks.test/executor");
      const id = request.headers.get("webhook-id") ?? "";
      const timestamp = request.headers.get("webhook-timestamp") ?? "";
      const body = yield* Effect.promise(() => request.clone().text());
      const payload = yield* Effect.promise(() => request.json());
      expect(id).toMatch(/^msg_/);
      expect(timestamp).toBe(String(NOW / 1000));
      // Recomputed independently of the sender, per the Standard Webhooks spec.
      const expected = createHmac("sha256", KEY)
        .update(`${id}.${timestamp}.${body}`)
        .digest("base64");
      expect(request.headers.get("webhook-signature")).toBe(`v1,${expected}`);
      expect(payload).toEqual({
        type: "connection.health",
        timestamp: new Date(NOW).toISOString(),
        data: DATA,
      });
    }),
  );

  it.effect("logs a delivery the receiver refuses instead of failing", () =>
    Effect.gen(function* () {
      const { requests, fetch } = capture(500);
      const send = makeStandardWebhookSender(WEBHOOK, { fetch, now: () => NOW });

      const exit = yield* Effect.exit(send("connection.health", DATA));

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests).toHaveLength(1);
    }),
  );
});

describe("webhookSigningKey", () => {
  it("decodes a whsec_ secret and rejects anything else", () => {
    expect(webhookSigningKey(SECRET)).toEqual(new Uint8Array(KEY));
    expect(webhookSigningKey(KEY.toString("base64"))).toBeNull();
    expect(webhookSigningKey("whsec_not base64!")).toBeNull();
    expect(webhookSigningKey("whsec_")).toBeNull();
  });
});
