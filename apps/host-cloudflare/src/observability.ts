// Cloudflare host `ErrorCapture`: the shared console implementation (a
// `cloudflare-` trace id, grep-able in Workers logs) plus a Sentry report
// tagged with that trace id. Sentry stays a no-op while SENTRY_DSN is unset.

import * as Sentry from "@sentry/cloudflare";
import { Cause, Effect, Layer } from "effect";
import { ErrorCapture } from "@executor-js/api";
import { consoleErrorCapture } from "@executor-js/api/server";

export const ErrorCaptureLive: Layer.Layer<ErrorCapture> = Layer.effect(
  ErrorCapture,
  Effect.gen(function* () {
    const consoleCapture = yield* ErrorCapture;
    return ErrorCapture.of({
      captureException: (cause) =>
        consoleCapture.captureException(cause).pipe(
          Effect.tap((traceId) =>
            Effect.sync(() => {
              const [error] = Cause.prettyErrors(cause);
              Sentry.captureException(error ?? Cause.squash(cause), { tags: { traceId } });
            }),
          ),
        ),
    });
  }),
).pipe(Layer.provide(consoleErrorCapture("cloudflare")));

/**
 * A call the client was waiting on that will never get a real answer: its
 * session Durable Object died (memory or CPU limit, deploy) or nothing came
 * back before the deadline. The dying isolate cannot report itself, so the
 * front worker, which answers the client for it, reports it instead.
 */
export const reportLostCall = (detail: Readonly<Record<string, unknown>>): void => {
  Sentry.captureMessage(`MCP call lost: ${String(detail.reason ?? "unknown")}`, {
    level: "error",
    tags: { reason: String(detail.reason ?? "unknown") },
    extra: detail,
  });
};
