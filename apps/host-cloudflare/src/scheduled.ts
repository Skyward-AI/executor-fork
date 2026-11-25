import { Effect } from "effect";

import { reconcileInternalIntegrationsOnce } from "./app";
import type { CloudflareEnv } from "./config";
import { sweepConnectionHealthOnce } from "./connection-health/run";

// ---------------------------------------------------------------------------
// The Worker's cron triggers (wrangler.jsonc `triggers.crons`), one job each.
// Kept out of worker.ts, whose exports the runtime reads as entrypoints.
// ---------------------------------------------------------------------------

/** Every minute: the internal-integration reconcile. */
export const RECONCILE_CRON = "* * * * *";
/** Hourly: the connection health sweep. */
export const CONNECTION_HEALTH_CRON = "7 * * * *";

/** Every job, by its cron expression. Each must also be declared in
 *  wrangler.jsonc, and nothing else may be: `worker.test.ts` holds both. */
export const JOBS: ReadonlyMap<string, (env: CloudflareEnv) => Promise<void>> = new Map([
  [RECONCILE_CRON, reconcileInternalIntegrationsOnce],
  [CONNECTION_HEALTH_CRON, sweepConnectionHealthOnce],
]);

export const runScheduled = (env: CloudflareEnv, cron: string): Promise<void> =>
  JOBS.get(cron)?.(env) ??
  Effect.runPromise(Effect.logWarning("no job for cron trigger", { cron }));
