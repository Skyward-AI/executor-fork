import { Data, Effect, Encoding, Result } from "effect";

// ---------------------------------------------------------------------------
// An outbound Standard Webhook (https://www.standardwebhooks.com): a JSON body
// `{ type, timestamp, data }` signed with HMAC-SHA256 over
// `${id}.${timestamp}.${body}`, keyed by the base64 half of a `whsec_` secret.
// Any receiver that verifies Standard Webhooks can consume it.
// ---------------------------------------------------------------------------

export interface StandardWebhook {
  readonly url: string;
  /** The decoded signing key (the base64 half of a `whsec_` secret). */
  readonly key: Uint8Array<ArrayBuffer>;
}

class StandardWebhookDeliveryError extends Data.TaggedError("StandardWebhookDeliveryError")<{
  readonly status?: number;
  readonly cause?: unknown;
}> {}

const SECRET_PREFIX = "whsec_";
/** A receiver that does not answer in time must not hold up the sender. */
const DELIVERY_TIMEOUT_MS = 10_000;

/** The signing key of a `whsec_` secret, or null when it is not one. */
export const webhookSigningKey = (secret: string): Uint8Array<ArrayBuffer> | null => {
  if (!secret.startsWith(SECRET_PREFIX)) return null;
  const key = Result.getOrNull(Encoding.decodeBase64(secret.slice(SECRET_PREFIX.length)));
  return key === null || key.length === 0 ? null : new Uint8Array(key);
};

const sign = async (key: Uint8Array<ArrayBuffer>, message: string): Promise<string> => {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
  return Encoding.encodeBase64(new Uint8Array(signature));
};

/** Send one message. A failed delivery is logged, never raised. */
export const makeStandardWebhookSender =
  (
    webhook: StandardWebhook,
    options: {
      readonly fetch?: typeof globalThis.fetch;
      readonly now?: () => number;
    } = {},
  ) =>
  (type: string, data: unknown): Effect.Effect<void> =>
    Effect.gen(function* () {
      const now = (options.now ?? Date.now)();
      const id = `msg_${crypto.randomUUID()}`;
      const timestamp = String(Math.floor(now / 1000));
      const body = JSON.stringify({ type, timestamp: new Date(now).toISOString(), data });
      const signature = yield* Effect.promise(() =>
        sign(webhook.key, `${id}.${timestamp}.${body}`),
      );
      // Called through a wrapper: a bare `fetch` reference loses its receiver
      // on Workers.
      const send = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
      const response = yield* Effect.tryPromise({
        try: () =>
          send(webhook.url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "webhook-id": id,
              "webhook-timestamp": timestamp,
              "webhook-signature": `v1,${signature}`,
            },
            body,
            signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
          }),
        catch: (cause) => new StandardWebhookDeliveryError({ cause }),
      });
      if (!response.ok) {
        return yield* new StandardWebhookDeliveryError({ status: response.status });
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("webhook not delivered", error).pipe(
          Effect.annotateLogs({ webhookType: type }),
        ),
      ),
    );
