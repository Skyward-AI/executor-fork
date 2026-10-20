import type { ExecutorDbHandle } from "@executor-js/api/server";

import type { CloudflareEnv } from "../config";
import { createD1ExecutorDb } from "./d1";

// One D1 handle per isolate, shared by the request path, the cron and the
// unfurl door. A failed open is dropped so the next caller retries.
let dbHandle: Promise<ExecutorDbHandle> | null = null;

export const openDb = (env: CloudflareEnv): Promise<ExecutorDbHandle> => {
  if (dbHandle === null) {
    const opening = createD1ExecutorDb(env.DB, env.BLOBS);
    dbHandle = opening;
    void opening.then(undefined, () => {
      if (dbHandle === opening) dbHandle = null;
    });
  }
  return dbHandle;
};
