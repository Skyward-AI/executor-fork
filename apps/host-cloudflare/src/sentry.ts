import type { CloudflareEnv } from "./config";

export const sentryOptions = (env: CloudflareEnv) => ({
  dsn: env.SENTRY_DSN,
  tracesSampleRate: 0,
  sendDefaultPii: false,
});
