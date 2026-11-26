import { Effect } from "effect";

import type { AdminArtifactSummary } from "@executor-js/sdk";

import type { CloudflareEnv } from "./config";
import { platformExecutor } from "./platform-executor";

// ---------------------------------------------------------------------------
// The read behind `ExecutorUnfurl`: link previews for internal services, over
// the isolate's shared platform executor (see `./platform-executor`). It sees
// every artifact in the tenant whoever owns it, and selects only title,
// description and last edit.
// ---------------------------------------------------------------------------

const ARTIFACT_ID = /^art_[a-z0-9]{1,60}$/;

export const artifactSummaryFor = async (
  env: CloudflareEnv,
  id: string,
): Promise<AdminArtifactSummary | null> => {
  if (!ARTIFACT_ID.test(id)) return null;
  const admin = (await platformExecutor(env)).admin;
  if (admin === undefined) return null;
  return Effect.runPromise(admin.artifactSummary(id));
};
