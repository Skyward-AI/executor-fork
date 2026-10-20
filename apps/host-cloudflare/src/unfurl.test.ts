import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { withQueryContext } from "@executor-js/fumadb/query";

import { collectTables, type SqliteDataMigrationClient } from "@executor-js/sdk";
import { createSqliteTestFumaDb, type SqliteTestFumaDb } from "@executor-js/sdk/testing";

import type { CloudflareEnv } from "./config";
import { artifactSummaryFor } from "./unfurl";

const TENANT = "acme";

const makeCountingD1 = (
  client: SqliteDataMigrationClient,
): { readonly db: D1Database; readonly calls: () => number } => {
  let calls = 0;
  const prepare = (sql: string) => {
    const statement = (args: readonly unknown[]): Record<string, unknown> => ({
      bind: (...values: readonly unknown[]) => statement([...args, ...values]),
      all: async () => {
        calls += 1;
        const result = await client.execute({ sql, args });
        return { success: true, meta: {}, results: result.rows };
      },
      raw: async () => {
        calls += 1;
        const result = await client.execute({ sql, args });
        return result.rows.map((row) => Object.values(row));
      },
      run: async () => {
        calls += 1;
        await client.execute({ sql, args });
        return { success: true, meta: {}, results: [] };
      },
    });
    return statement([]);
  };
  // oxlint-disable-next-line executor/no-double-cast -- test double: only the D1 methods used by schema preparation and reads are implemented
  const db = { prepare, withSession: () => ({ prepare }) } as unknown as D1Database;
  return { db, calls: () => calls };
};

const insertArtifact = (
  sqlite: SqliteTestFumaDb,
  row: {
    readonly tenant: string;
    readonly owner: "org" | "user";
    readonly subject: string;
    readonly id: string;
    readonly title: string;
    readonly description: string | null;
  },
) =>
  withQueryContext(sqlite.db, { tenant: row.tenant, subject: row.subject }).create("artifact", {
    ...row,
    code: "export default function App() { return <div>SECRET-source</div>; }",
    bindings: null,
    preview: "<div>SECRET-preview</div>",
    preview_capture: null,
    compiled_fingerprint: null,
    compiled_js: null,
    compiled_css: null,
    created_by: null,
    created_at: new Date(1_700_000_000_000),
    updated_at: new Date(1_700_000_060_000),
  });

describe("artifactSummaryFor", () => {
  let sqlite: SqliteTestFumaDb;
  let d1Calls: () => number;
  let env: CloudflareEnv;

  beforeAll(async () => {
    sqlite = await createSqliteTestFumaDb({ tables: collectTables() });
    const counting = makeCountingD1(sqlite.client);
    d1Calls = counting.calls;
    // oxlint-disable-next-line executor/no-double-cast -- test double: only the vars and the D1 binding the code under test reads are set
    env = {
      DB: counting.db,
      ENABLE_DEV_AUTH: "true",
      EXECUTOR_SECRET_KEY: "test-secret-key-0123456789abcdef",
      SELF_HOSTED_ORG_ID: TENANT,
    } as unknown as CloudflareEnv;
    // Open once so the schema exists, then seed straight through storage.
    await artifactSummaryFor(env, "art_warmup");
    await insertArtifact(sqlite, {
      tenant: TENANT,
      owner: "user",
      subject: "someone",
      id: "art_personal",
      title: "My scratchpad",
      description: "Only for me",
    });
    await insertArtifact(sqlite, {
      tenant: "other",
      owner: "org",
      subject: "",
      id: "art_foreign",
      title: "Other tenant",
      description: null,
    });
  });

  afterAll(async () => {
    await sqlite.close();
  });

  it("summarises a personal artifact of someone else, and nothing more than its summary", async () => {
    const summary = await artifactSummaryFor(env, "art_personal");

    expect(summary).toEqual({
      title: "My scratchpad",
      description: "Only for me",
      updatedAt: 1_700_000_060_000,
    });
    expect(JSON.stringify(summary)).not.toContain("SECRET");
  });

  it("answers null for an unknown id and for another tenant's artifact", async () => {
    expect(await artifactSummaryFor(env, "art_unknown")).toBe(null);
    expect(await artifactSummaryFor(env, "art_foreign")).toBe(null);
  });

  it("answers null for a malformed id without touching storage", async () => {
    const before = d1Calls();

    for (const id of ["../x", "ART_personal", "art_", `art_${"a".repeat(61)}`, "", "art_a b"]) {
      expect(await artifactSummaryFor(env, id)).toBe(null);
    }

    expect(d1Calls()).toBe(before);
  });
});
