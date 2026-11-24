import { Result } from "effect";

import type { CloudflareEnv } from "../config";
import { webhookSigningKey, type StandardWebhook } from "../standard-webhook";

/** Where the sweep reports, if anywhere. Read only by the sweep, so a bad value
 *  disables reporting instead of failing the Worker's requests. */
export const resolveConnectionHealthWebhook = (
  env: Pick<CloudflareEnv, "CONNECTION_HEALTH_WEBHOOK_URL" | "CONNECTION_HEALTH_WEBHOOK_SECRET">,
): Result.Result<StandardWebhook | undefined, string> => {
  const url = env.CONNECTION_HEALTH_WEBHOOK_URL?.trim() ?? "";
  const secret = env.CONNECTION_HEALTH_WEBHOOK_SECRET?.trim() ?? "";
  if (url.length === 0 && secret.length === 0) return Result.succeed(undefined);
  if (url.length === 0 || secret.length === 0) {
    return Result.fail(
      "CONNECTION_HEALTH_WEBHOOK_URL and CONNECTION_HEALTH_WEBHOOK_SECRET must be set together",
    );
  }
  const key = webhookSigningKey(secret);
  return key === null
    ? Result.fail("CONNECTION_HEALTH_WEBHOOK_SECRET must be a whsec_ base64 signing secret")
    : Result.succeed({ url, key });
};
