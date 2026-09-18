import { Effect, Encoding } from "effect";

import { OAUTH2_DEFAULT_TIMEOUT_MS, OAuth2Error, type OAuth2TokenResponse } from "./oauth-helpers";

// ---------------------------------------------------------------------------
// GitHub App installation tokens — the `github_app` grant.
//
// A GitHub App has no static credential. You sign a short-lived JWT with the
// App's private key, POST it to the installation's token endpoint, and get back
// a token that expires in ONE HOUR (fixed by GitHub, not configurable). That is
// why this is a grant rather than a pasted API key: the executor's existing
// credential lifecycle already re-mints on `expires_at` and retries once on a
// 401, so wiring the mint in here makes the expiry invisible.
//
// It reuses the `oauth_client` row as-is — no new columns, no migration:
//   client_id  → the App ID, signed as the JWT `iss`
//   secret     → the App's PEM private key (resolved from the credential store)
//   token_url  → the full mint endpoint, which is what carries the installation
//                id (`/app/installations/<id>/access_tokens`)
//
// The endpoint is just `token_url`, so the broad shape — sign a JWT with a
// private key, POST it, get a bearer — would suit other providers. It is NOT
// generic as written, though: the vendor `Accept` header, the PKCS#1 unwrap and
// GitHub's `{token, expires_at}` envelope are all specific. Hence the specific
// name. The neutral RFC 7523 grant already exists separately as `id_jag`.
//
// One cost of piggybacking on `oauth_client`: the row IS the installation, so an
// app installed on N organizations needs N rows, each holding a copy of the same
// RSA private key.
// ---------------------------------------------------------------------------

/** How far ahead of NOW the JWT expires. With the 60s backdate below this puts
 *  `exp - iat` at exactly 600s, GitHub's documented ceiling and its own example. */
const JWT_LIFETIME_SECONDS = 540;
/** Backdate `iat` against clock skew between us and GitHub, per their guidance. */
const JWT_BACKDATE_SECONDS = 60;

const encodeJson = (value: unknown): string => Encoding.encodeBase64Url(JSON.stringify(value));

/** DER length bytes for a definite-length item. */
const derLength = (length: number): readonly number[] => {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let n = length; n > 0; n >>= 8) bytes.unshift(n & 0xff);
  return [0x80 | bytes.length, ...bytes];
};

/** ASN.1 AlgorithmIdentifier for rsaEncryption, plus the version INTEGER that
 *  precedes it inside a PKCS#8 PrivateKeyInfo. */
const PKCS8_RSA_PREAMBLE = [
  0x02, 0x01, 0x00, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
  0x05, 0x00,
] as const;

/**
 * Wrap a PKCS#1 RSAPrivateKey in a PKCS#8 PrivateKeyInfo.
 *
 * Needed because GitHub hands out `BEGIN RSA PRIVATE KEY` (PKCS#1) while
 * WebCrypto's `importKey` only accepts `pkcs8`. The wrap is a fixed ASN.1
 * envelope around the original bytes, so it is a re-encoding, not a conversion.
 */
const pkcs1ToPkcs8 = (pkcs1: Uint8Array): Uint8Array => {
  const body = [...PKCS8_RSA_PREAMBLE, 0x04, ...derLength(pkcs1.length), ...pkcs1];
  return new Uint8Array([0x30, ...derLength(body.length), ...body]);
};

/** Decode a PEM body to DER, wrapping PKCS#1 keys so WebCrypto accepts them. */
const derFromPem = (pem: string): Uint8Array => {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return /BEGIN RSA PRIVATE KEY/.test(pem) ? pkcs1ToPkcs8(der) : der;
};

/** Sign the app JWT GitHub expects: RS256, `iss` = app id, ≤10 minute lifetime. */
export const signGithubAppJwt = async (input: {
  readonly appId: string;
  readonly privateKeyPem: string;
  readonly now?: number;
}): Promise<string> => {
  const nowSeconds = Math.floor((input.now ?? Date.now()) / 1000);
  const header = encodeJson({ alg: "RS256", typ: "JWT" });
  const payload = encodeJson({
    iat: nowSeconds - JWT_BACKDATE_SECONDS,
    exp: nowSeconds + JWT_LIFETIME_SECONDS,
    iss: input.appId,
  });
  const key = await crypto.subtle.importKey(
    "pkcs8",
    derFromPem(input.privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${Encoding.encodeBase64Url(new Uint8Array(signature))}`;
};

/** Seconds until `expires_at`, floored at 0 — GitHub reports an absolute
 *  timestamp where the executor's lifecycle wants a relative `expires_in`. */
const expiresInFrom = (expiresAt: unknown, now: number): number | undefined => {
  if (typeof expiresAt !== "string") return undefined;
  const at = Date.parse(expiresAt);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.floor((at - now) / 1000));
};

/** Probe an untrusted token-endpoint body. Mirrors the same helpers in
 *  ./oauth-helpers: the value is only read for a token and an expiry, never
 *  decoded into a domain type, so a parse failure just means "no JSON body". */
const jsonBody = (text: string): Record<string, unknown> | null => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: probing an untrusted token-endpoint body; unparseable means "no envelope"
  try {
    // oxlint-disable-next-line executor/no-json-parse -- boundary: same untrusted-body probe; only a token string and an expiry are read back out
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const endpointMessage = (body: Record<string, unknown> | null, status: number): string =>
  typeof body?.message === "string" ? body.message : `HTTP ${status}`;

/**
 * Mint an installation access token.
 *
 * Returns the standard `OAuth2TokenResponse` so every caller downstream — the
 * connect path, the re-mint path, `persistRefreshedToken` — treats it exactly
 * like any other grant's token. GitHub answers `{ token, expires_at }` rather
 * than `{ access_token, expires_in }`, so both shapes are accepted: the standard
 * one first, GitHub's as the fallback.
 */
export const mintGithubAppToken = (input: {
  readonly appId: string;
  readonly privateKeyPem: string;
  readonly tokenUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: number;
}): Effect.Effect<OAuth2TokenResponse, OAuth2Error> =>
  Effect.gen(function* () {
    const now = input.now ?? Date.now();

    const jwt = yield* Effect.tryPromise({
      try: () => signGithubAppJwt({ appId: input.appId, privateKeyPem: input.privateKeyPem, now }),
      catch: () =>
        new OAuth2Error({
          message:
            "GitHub App token mint failed: could not sign the app JWT. Check that the credential is the app's RSA private key in PEM form.",
        }),
    });

    const result = yield* Effect.tryPromise({
      try: async () => {
        // oxlint-disable-next-line executor/no-raw-fetch -- boundary: provider token exchange is the SDK's HTTP boundary and preserves its injected fetch seam
        const response = await (input.fetch ?? globalThis.fetch)(input.tokenUrl, {
          method: "POST",
          // Every other grant reaches the wire with a timeout; without one a hung
          // endpoint hangs the invoke that triggered the re-mint.
          signal: AbortSignal.timeout(OAUTH2_DEFAULT_TIMEOUT_MS),
          headers: {
            authorization: `Bearer ${jwt}`,
            accept: "application/vnd.github+json",
            "user-agent": "executor",
          },
        });
        return { ok: response.ok, status: response.status, text: await response.text() };
      },
      catch: () =>
        new OAuth2Error({
          message: `GitHub App token mint failed: could not reach ${input.tokenUrl}`,
        }),
    });

    const body = jsonBody(result.text);
    if (!result.ok) {
      return yield* new OAuth2Error({
        message: `GitHub App token mint failed: ${endpointMessage(body, result.status)}`,
      });
    }

    const token = body?.access_token ?? body?.token;
    if (typeof token !== "string" || token.length === 0) {
      return yield* new OAuth2Error({
        message: "GitHub App token mint failed: endpoint returned no token",
      });
    }

    const expiresIn =
      typeof body?.expires_in === "number" ? body.expires_in : expiresInFrom(body?.expires_at, now);
    return {
      access_token: token,
      token_type: "bearer",
      ...(expiresIn === undefined ? {} : { expires_in: expiresIn }),
    } satisfies OAuth2TokenResponse;
  });
