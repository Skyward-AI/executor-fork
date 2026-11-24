import { reconcileInternalIntegrationsOnce } from "./app";
import type { CloudflareEnv } from "./config";
import { sweepConnectionHealthOnce } from "./connection-health/run";

// ---------------------------------------------------------------------------
// The Worker's cron triggers (wrangler.jsonc `triggers.crons`), one job each.
// Kept out of worker.ts, whose exports the runtime reads as entrypoints.
// ---------------------------------------------------------------------------

/** Hourly: the connection health sweep. */
export const CONNECTION_HEALTH_CRON = "7 * * * *";

/** Run the job for `cron`; every other trigger (each minute) runs the
 *  internal-integration reconcile. */
export const runScheduled = (env: CloudflareEnv, cron: string): Promise<void> =>
  cron === CONNECTION_HEALTH_CRON
    ? sweepConnectionHealthOnce(env)
    : reconcileInternalIntegrationsOnce(env);
