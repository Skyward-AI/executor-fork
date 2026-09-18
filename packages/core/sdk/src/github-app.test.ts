import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { createPrivateKey } from "node:crypto";

import { mintGithubAppToken, signGithubAppJwt } from "./github-app";

// A throwaway PKCS#1 key, generated for this test only.
const { privateKey, publicKey } = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
);
const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", privateKey));
const pem = (label: string, bytes: Uint8Array) =>
  `-----BEGIN ${label}-----\n${btoa(String.fromCharCode(...bytes)).replace(/(.{64})/g, "$1\n")}\n-----END ${label}-----\n`;
const PKCS8_PEM = pem("PRIVATE KEY", pkcs8);

// The SAME key re-encoded as PKCS#1 — the form GitHub actually hands out
// (`BEGIN RSA PRIVATE KEY`). Produced by node:crypto rather than by our own
// `pkcs1ToPkcs8`, so the round-trip test below is independent of the code it
// exercises. Without this fixture the DER-wrapping path is never executed.
const PKCS1_PEM = createPrivateKey({ key: Buffer.from(pkcs8), format: "der", type: "pkcs8" })
  .export({ type: "pkcs1", format: "pem" })
  .toString();

const decode = (segment: string) =>
  // oxlint-disable-next-line executor/no-json-parse -- boundary: decoding a JWT segment this test just produced, to assert its claims
  JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(atob(segment.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
    ),
  );

describe("signGithubAppJwt", () => {
  it("accepts a PKCS#1 key, the form GitHub hands out", async () => {
    expect(PKCS1_PEM).toContain("BEGIN RSA PRIVATE KEY");
    const jwt = await signGithubAppJwt({ appId: "3602580", privateKeyPem: PKCS1_PEM });
    const [head, payload, signature] = jwt.split(".");
    // Verifying against the public key proves the DER re-wrap produced a key
    // WebCrypto could import and sign with — not merely that it did not throw.
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      Uint8Array.from(atob(signature!.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
        c.charCodeAt(0),
      ),
      new TextEncoder().encode(`${head}.${payload}`),
    );
    expect(ok).toBe(true);
  });

  it("signs a verifiable RS256 JWT with the app id as issuer", async () => {
    const now = 1_700_000_000_000;
    const jwt = await signGithubAppJwt({ appId: "3602580", privateKeyPem: PKCS8_PEM, now });
    const [head, payload, signature] = jwt.split(".");

    expect(decode(head!)).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = decode(payload!);
    expect(claims.iss).toBe("3602580");
    // Backdated against clock skew, and inside GitHub's 10-minute ceiling.
    expect(claims.iat).toBeLessThan(now / 1000);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);

    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      Uint8Array.from(atob(signature!.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
        c.charCodeAt(0),
      ),
      new TextEncoder().encode(`${head}.${payload}`),
    );
    expect(ok).toBe(true);
  });
});

const mint = (fetchImpl: typeof globalThis.fetch, now = 1_700_000_000_000) =>
  mintGithubAppToken({
    appId: "3602580",
    privateKeyPem: PKCS8_PEM,
    tokenUrl: "https://api.github.com/app/installations/130473318/access_tokens",
    fetch: fetchImpl,
    now,
  });

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("mintGithubAppToken", () => {
  it("normalizes GitHub's { token, expires_at } into an OAuth token response", async () => {
    const now = Date.parse("2026-09-18T08:22:49Z");
    const token = await Effect.runPromise(
      mint(async () => jsonResponse({ token: "ghs_abc", expires_at: "2026-09-18T09:22:49Z" }), now),
    );
    expect(token.access_token).toBe("ghs_abc");
    expect(token.token_type).toBe("bearer");
    expect(token.expires_in).toBe(3600);
  });

  it("accepts a standard { access_token, expires_in } response too", async () => {
    const token = await Effect.runPromise(
      mint(async () => jsonResponse({ access_token: "tok", expires_in: 900 })),
    );
    expect(token.access_token).toBe("tok");
    expect(token.expires_in).toBe(900);
  });

  it("sends the signed JWT as a bearer to the configured token url", async () => {
    let seenUrl: string | undefined;
    let seenAuth: string | null = null;
    await Effect.runPromise(
      mint(async (url, init) => {
        seenUrl = String(url);
        seenAuth = new Headers(init?.headers).get("authorization");
        return jsonResponse({ token: "t" });
      }),
    );
    expect(seenUrl).toBe("https://api.github.com/app/installations/130473318/access_tokens");
    expect(seenAuth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("surfaces the endpoint's message on failure", async () => {
    await expect(
      Effect.runPromise(mint(async () => jsonResponse({ message: "Bad credentials" }, 401))),
    ).rejects.toThrow(/Bad credentials/);
  });

  it("fails when the endpoint returns no token", async () => {
    await expect(Effect.runPromise(mint(async () => jsonResponse({})))).rejects.toThrow(/no token/);
  });
});
