import { describe, expect, it } from "@effect/vitest";
import { Result } from "effect";

import { resolveConnectionHealthWebhook } from "./webhook-config";

const SECRET = `whsec_${btoa("health-webhook-signing-key")}`;

describe("resolveConnectionHealthWebhook", () => {
  it("is configured when the URL and a whsec_ secret are both set", () => {
    expect(
      resolveConnectionHealthWebhook({
        CONNECTION_HEALTH_WEBHOOK_URL: " https://hooks.example.com/executor ",
        CONNECTION_HEALTH_WEBHOOK_SECRET: SECRET,
      }),
    ).toEqual(
      Result.succeed({
        url: "https://hooks.example.com/executor",
        key: new TextEncoder().encode("health-webhook-signing-key"),
      }),
    );
  });

  it("is off when neither is set", () => {
    expect(resolveConnectionHealthWebhook({})).toEqual(Result.succeed(undefined));
  });

  it("refuses half a configuration", () => {
    const halfSet = Result.fail(
      "CONNECTION_HEALTH_WEBHOOK_URL and CONNECTION_HEALTH_WEBHOOK_SECRET must be set together",
    );
    expect(
      resolveConnectionHealthWebhook({
        CONNECTION_HEALTH_WEBHOOK_URL: "https://hooks.example.com",
      }),
    ).toEqual(halfSet);
    expect(resolveConnectionHealthWebhook({ CONNECTION_HEALTH_WEBHOOK_SECRET: SECRET })).toEqual(
      halfSet,
    );
  });

  it("refuses a secret that cannot sign", () => {
    expect(
      resolveConnectionHealthWebhook({
        CONNECTION_HEALTH_WEBHOOK_URL: "https://hooks.example.com",
        CONNECTION_HEALTH_WEBHOOK_SECRET: "plain-secret",
      }),
    ).toEqual(
      Result.fail("CONNECTION_HEALTH_WEBHOOK_SECRET must be a whsec_ base64 signing secret"),
    );
  });
});
