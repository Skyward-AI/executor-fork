import { readFileSync } from "node:fs";

import { describe, expect, it } from "@effect/vitest";
import { parse } from "jsonc-parser";

import { loadConfig } from "./config";

type ConfigEnv = Parameters<typeof loadConfig>[0];

const makeEnv = (overrides: Partial<ConfigEnv> = {}): ConfigEnv => ({
  EXECUTOR_SECRET_KEY: "test-secret-key-0123456789abcdef",
  VITE_PUBLIC_SITE_URL: "https://executor.example.com",
  ...overrides,
});

describe("loadConfig", () => {
  it("rejects missing Cloudflare Access configuration outside local development", () => {
    expect(() => loadConfig(makeEnv())).toThrowError(
      "Cloudflare Access is not configured. Set ACCESS_TEAM_DOMAIN and ACCESS_AUD before serving requests.",
    );
  });

  it("rejects the repository's former team-domain placeholder", () => {
    expect(() =>
      loadConfig(
        makeEnv({
          ACCESS_TEAM_DOMAIN: "your-team.cloudflareaccess.com",
          ACCESS_AUD: "aud-tag",
        }),
      ),
    ).toThrowError(
      "Cloudflare Access is not configured. Set ACCESS_TEAM_DOMAIN before serving requests.",
    );
  });

  it("allows local development to bypass Cloudflare Access", () => {
    expect(loadConfig(makeEnv({ ENABLE_DEV_AUTH: "true" }))).toMatchObject({
      accessTeamDomain: "",
      accessAud: "",
      enableDevAuth: true,
    });
  });

  it("normalises configured Access values without requiring an administrator", () => {
    expect(
      loadConfig(
        makeEnv({
          ACCESS_TEAM_DOMAIN: "https://Team.cloudflareaccess.com/",
          ACCESS_AUD: " aud-tag ",
        }),
      ),
    ).toMatchObject({
      accessTeamDomain: "Team.cloudflareaccess.com",
      accessAud: "aud-tag",
      adminEmails: [],
      enableDevAuth: false,
    });
  });
});

describe("Cloudflare deployment configuration", () => {
  it("preserves operator-managed Access variables across deploys", () => {
    const config = parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")) as {
      readonly keep_vars?: boolean;
      readonly vars?: Readonly<Record<string, unknown>>;
    };

    expect(config.keep_vars).toBe(true);
    expect(config.vars).not.toHaveProperty("ACCESS_TEAM_DOMAIN");
    expect(config.vars).not.toHaveProperty("ACCESS_AUD");
    expect(config.vars).not.toHaveProperty("ADMIN_EMAILS");
    expect(config.vars).toHaveProperty("ENABLE_DEV_AUTH", "false");
  });
});

describe("jevGateway", () => {
  const access = {
    ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
    ACCESS_AUD: "aud-tag",
  };

  it("is configured when both ids are present", async () => {
    const config = loadConfig(
      makeEnv({
        ...access,
        CLOUDFLARE_ACCOUNT_ID: "acct",
        AI_GATEWAY_ID: "staging-gateway",
        AI_GATEWAY_TOKEN: { get: () => Promise.resolve("tok") },
      }),
    );
    expect(config.jevGateway?.accountId).toBe("acct");
    expect(config.jevGateway?.gatewayId).toBe("staging-gateway");
    // The binding is resolved per call, so config carries a resolver and never
    // the secret itself.
    await expect(config.jevGateway?.authToken?.()).resolves.toBe("tok");
  });

  it("is OFF when an id is missing, so search degrades to lexical instead of 404ing", () => {
    // A gateway URL built from a blank id resolves to a 404 that reads like
    // "Jev found nothing" rather than "Jev was never configured".
    expect(
      loadConfig(makeEnv({ ...access, AI_GATEWAY_ID: "staging-gateway" })).jevGateway,
    ).toBeUndefined();
    expect(
      loadConfig(makeEnv({ ...access, CLOUDFLARE_ACCOUNT_ID: "acct" })).jevGateway,
    ).toBeUndefined();
  });

  it("keeps the token optional — an unauthenticated gateway needs none", () => {
    const config = loadConfig(
      makeEnv({ ...access, CLOUDFLARE_ACCOUNT_ID: "acct", AI_GATEWAY_ID: "g" }),
    );
    expect(config.jevGateway?.authToken).toBeUndefined();
  });
});
