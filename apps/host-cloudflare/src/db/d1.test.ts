import { describe, expect, it } from "@effect/vitest";
import type { D1Database } from "@cloudflare/workers-types";

import { collectTables, type SqliteDataMigrationClient } from "@executor-js/sdk";
import { createSqliteTestFumaDb } from "@executor-js/sdk/testing";

import { createD1ExecutorDb } from "./d1";
import { cloudflareDataMigrationIds } from "./data-migrations";

const readMarker = async (client: SqliteDataMigrationClient): Promise<string> => {
  const result = await client.execute(
    `SELECT fingerprint FROM private_executor_cloudflare_schema_fingerprint WHERE id = 'runtime-schema'`,
  );
  return String(result.rows[0]?.fingerprint);
};

const makeRecordingD1 = (
  client: SqliteDataMigrationClient,
): {
  readonly db: D1Database;
  readonly statements: string[];
  readonly failWhen: (predicate: ((sql: string) => boolean) | null, message?: string) => void;
} => {
  const statements: string[] = [];
  let failurePredicate: ((sql: string) => boolean) | null = null;
  let failureMessage = "forced D1 failure";
  const record = (sql: string): void => {
    statements.push(sql);
    if (failurePredicate?.(sql)) {
      // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- test boundary: the fake D1 adapter must reject exactly where the real D1 query would reject
      throw new Error(failureMessage);
    }
  };
  const prepare = (sql: string) => {
    const statement = (args: readonly unknown[]): Record<string, unknown> => ({
      bind: (...values: readonly unknown[]) => statement([...args, ...values]),
      all: async () => {
        record(sql);
        const result = await client.execute({ sql, args });
        return { success: true, meta: {}, results: result.rows };
      },
      run: async () => {
        record(sql);
        await client.execute({ sql, args });
        return { success: true, meta: {}, results: [] };
      },
    });
    return statement([]);
  };

  // oxlint-disable-next-line executor/no-double-cast -- test double: only the D1 methods used by schema preparation and migrations are implemented
  const db = {
    prepare,
    withSession: () => ({ prepare }),
  } as unknown as D1Database;
  return {
    db,
    statements,
    failWhen: (predicate, message = "forced D1 failure") => {
      failurePredicate = predicate;
      failureMessage = message;
    },
  };
};

const isRuntimeSchemaStatement = (sql: string): boolean => {
  const normalized = sql.trim().toUpperCase();
  if (normalized.startsWith("CREATE UNIQUE INDEX IF NOT EXISTS")) return true;
  if (normalized.startsWith("ALTER TABLE") && normalized.includes(" ADD COLUMN ")) return true;
  if (!normalized.startsWith("CREATE TABLE IF NOT EXISTS")) return false;
  return !normalized.includes("DATA_MIGRATION");
};

const ranDataMigrations = (statements: readonly string[]): boolean =>
  statements.some((sql) => sql.includes("SELECT name FROM data_migration"));

const setMarker = (client: SqliteDataMigrationClient, fingerprint: string) =>
  client.execute({
    sql: `UPDATE private_executor_cloudflare_schema_fingerprint SET fingerprint = ? WHERE id = 'runtime-schema'`,
    args: [fingerprint],
  });

// Opens the database once so it is current, then opens it again and returns
// only what the second open sent to D1.
const openTwice = async (
  db: D1Database,
  statements: string[],
  between: () => Promise<unknown> = async () => {},
): Promise<string[]> => {
  const first = await createD1ExecutorDb(db, undefined);
  await first.close();
  await between();
  const start = statements.length;
  const second = await createD1ExecutorDb(db, undefined);
  await second.close();
  return statements.slice(start);
};

describe("createD1ExecutorDb", () => {
  it("does not repeat runtime schema DDL after the current schema was prepared", async () => {
    const sqlite = await createSqliteTestFumaDb({ tables: collectTables() });
    const { db, statements } = makeRecordingD1(sqlite.client);

    const secondStatements = await openTwice(db, statements);

    expect(statements.filter(isRuntimeSchemaStatement).length).toBeGreaterThan(0);
    expect(secondStatements.filter(isRuntimeSchemaStatement)).toEqual([]);

    await sqlite.close();
  });

  it("opens a current database with exactly one D1 query", async () => {
    const sqlite = await createSqliteTestFumaDb({ tables: collectTables() });
    const { db, statements } = makeRecordingD1(sqlite.client);

    const secondStatements = await openTwice(db, statements);

    expect(secondStatements).toHaveLength(1);
    expect(secondStatements[0]).toContain("SELECT fingerprint");

    await sqlite.close();
  });

  it("records every known data migration in the ledger", async () => {
    const sqlite = await createSqliteTestFumaDb({ tables: collectTables() });
    const { db } = makeRecordingD1(sqlite.client);

    const handle = await createD1ExecutorDb(db, undefined);
    await handle.close();

    const ledger = await sqlite.client.execute(`SELECT name FROM data_migration`);
    expect(ledger.rows.map((row) => row.name)).toEqual(
      expect.arrayContaining([...cloudflareDataMigrationIds]),
    );

    await sqlite.close();
  });

  it("runs the data migrations again when the stored fingerprint predates the migration list", async () => {
    const sqlite = await createSqliteTestFumaDb({ tables: collectTables() });
    const { db, statements } = makeRecordingD1(sqlite.client);
    const missing = cloudflareDataMigrationIds[cloudflareDataMigrationIds.length - 1];

    const secondStatements = await openTwice(db, statements, async () => {
      await sqlite.client.execute({
        sql: "DELETE FROM data_migration WHERE name = ?",
        args: [missing],
      });
      await setMarker(sqlite.client, "older");
    });

    expect(ranDataMigrations(secondStatements)).toBe(true);
    const ledger = await sqlite.client.execute(`SELECT name FROM data_migration`);
    expect(ledger.rows.map((row) => row.name)).toContain(missing);

    await sqlite.close();
  });

  it("runs the schema ensure again when the generated fingerprint is stale", async () => {
    const sqlite = await createSqliteTestFumaDb({ tables: collectTables() });
    const { db, statements } = makeRecordingD1(sqlite.client);

    const secondStatements = await openTwice(db, statements, () =>
      setMarker(sqlite.client, "stale"),
    );

    expect(
      secondStatements.some((sql) => sql.startsWith('CREATE TABLE IF NOT EXISTS "integration"')),
    ).toBe(true);

    await sqlite.close();
  });

  it("adds the compiled artifact columns to a database that predates them", async () => {
    const sqlite = await createSqliteTestFumaDb({ tables: collectTables() });
    const { db, statements } = makeRecordingD1(sqlite.client);

    await openTwice(db, statements, async () => {
      for (const column of ["compiled_fingerprint", "compiled_js", "compiled_css"]) {
        await sqlite.client.execute(`ALTER TABLE "artifact" DROP COLUMN "${column}"`);
      }
      await setMarker(sqlite.client, "stale");
    });

    const columns = await sqlite.client.execute(`PRAGMA table_info("artifact")`);
    const names = columns.rows.map((row) => String(row.name));
    expect(names).toEqual(
      expect.arrayContaining(["compiled_fingerprint", "compiled_js", "compiled_css"]),
    );

    await sqlite.close();
  });

  it("adds the created_by artifact column to a database that predates it", async () => {
    const sqlite = await createSqliteTestFumaDb({ tables: collectTables() });
    const { db } = makeRecordingD1(sqlite.client);
    const first = await createD1ExecutorDb(db, undefined);
    await first.close();
    await sqlite.client.execute(`ALTER TABLE "artifact" DROP COLUMN "created_by"`);
    await sqlite.client.execute(
      `UPDATE private_executor_cloudflare_schema_fingerprint
       SET fingerprint = 'stale'
       WHERE id = 'runtime-schema'`,
    );

    const second = await createD1ExecutorDb(db, undefined);
    await second.close();

    const columns = await sqlite.client.execute(`PRAGMA table_info("artifact")`);
    const names = columns.rows.map((row) => String(row.name));
    expect(names).toEqual(expect.arrayContaining(["created_by"]));

    await sqlite.close();
  });

  it("converges safely when concurrent opens see the same stale fingerprint", async () => {
    const sqlite = await createSqliteTestFumaDb({ tables: collectTables() });
    const { db } = makeRecordingD1(sqlite.client);
    const prepared = await createD1ExecutorDb(db, undefined);
    await prepared.close();
    await setMarker(sqlite.client, "stale");

    const handles = await Promise.all([
      createD1ExecutorDb(db, undefined),
      createD1ExecutorDb(db, undefined),
    ]);
    await Promise.all(handles.map((handle) => handle.close()));

    const fingerprints = await sqlite.client.execute(
      `SELECT fingerprint
       FROM private_executor_cloudflare_schema_fingerprint
       WHERE id = 'runtime-schema'`,
    );
    expect(fingerprints.rows).toHaveLength(1);
    expect(fingerprints.rows[0]?.fingerprint).not.toBe("stale");

    await sqlite.close();
  });

  it("stamps only after compatibility migrations leave the final schema current", async () => {
    const sqlite = await createSqliteTestFumaDb({ tables: collectTables() });
    await sqlite.client.execute("DROP TABLE connection");
    await sqlite.client.execute(`
      CREATE TABLE connection (
        integration text NOT NULL,
        name text NOT NULL,
        template text NOT NULL,
        provider text NOT NULL,
        item_id text NOT NULL,
        identity_label text,
        description text,
        tools_synced_at integer,
        oauth_client text,
        oauth_client_owner text,
        refresh_item_id text,
        expires_at integer,
        oauth_scope text,
        oauth_token_url text,
        provider_state text,
        created_at integer NOT NULL,
        updated_at integer NOT NULL,
        row_id text PRIMARY KEY NOT NULL,
        tenant text NOT NULL,
        owner text NOT NULL,
        subject text NOT NULL
      )
    `);
    const { db } = makeRecordingD1(sqlite.client);

    const handle = await createD1ExecutorDb(db, undefined);
    await handle.close();

    const columns = await sqlite.client.execute("PRAGMA table_info('connection')");
    const columnNames = columns.rows.map((row) => row.name);
    expect(columnNames).toContain("item_ids");
    expect(columnNames).toContain("last_health");
    expect(columnNames).not.toContain("item_id");
    const indexes = await sqlite.client.execute(
      `SELECT name FROM sqlite_master
       WHERE type = 'index'
         AND name = 'connection_uidx'`,
    );
    expect(indexes.rows).toEqual([{ name: "connection_uidx" }]);

    await sqlite.close();
  });

  it("does not stamp a fingerprint when schema preparation fails", async () => {
    const sqlite = await createSqliteTestFumaDb({ tables: collectTables() });
    const { db, failWhen } = makeRecordingD1(sqlite.client);
    failWhen((sql) => sql.startsWith('CREATE TABLE IF NOT EXISTS "integration"'));

    await expect(createD1ExecutorDb(db, undefined)).rejects.toBeDefined();

    const marker = await sqlite.client.execute(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name = 'private_executor_cloudflare_schema_fingerprint'`,
    );
    expect(marker.rows).toEqual([]);

    failWhen(null);
    const recovered = await createD1ExecutorDb(db, undefined);
    await recovered.close();

    await sqlite.close();
  });

  it("rides out a transient D1 internal error on the schema fingerprint read", async () => {
    const sqlite = await createSqliteTestFumaDb({ tables: collectTables() });
    const { db, statements, failWhen } = makeRecordingD1(sqlite.client);
    const prepared = await createD1ExecutorDb(db, undefined);
    await prepared.close();
    let fingerprintReads = 0;
    failWhen((sql) => {
      if (!sql.startsWith("SELECT fingerprint")) return false;
      fingerprintReads += 1;
      return fingerprintReads === 1;
    }, "D1_ERROR: internal error; reference = 6kq3v9j0mmpdu3qgcsbmz2ib");

    const secondStart = statements.length;
    const handle = await createD1ExecutorDb(db, undefined);
    await handle.close();

    expect(
      statements.slice(secondStart).filter((sql) => sql.startsWith("SELECT fingerprint")),
    ).toHaveLength(2);
    expect(statements.slice(secondStart).filter(isRuntimeSchemaStatement)).toEqual([]);

    await sqlite.close();
  });

  it("rewrites the marker after preparing a database whose marker is out of date", async () => {
    const sqlite = await createSqliteTestFumaDb({ tables: collectTables() });
    const { db, statements } = makeRecordingD1(sqlite.client);
    let currentMarker = "";

    const secondStatements = await openTwice(db, statements, async () => {
      currentMarker = await readMarker(sqlite.client);
      await setMarker(sqlite.client, "older");
    });

    expect(ranDataMigrations(secondStatements)).toBe(true);
    expect(await readMarker(sqlite.client)).toBe(currentMarker);

    await sqlite.close();
  });

  it("keeps the old marker when data preparation fails so the next open retries", async () => {
    const sqlite = await createSqliteTestFumaDb({ tables: collectTables() });
    const { db, statements, failWhen } = makeRecordingD1(sqlite.client);
    let currentMarker = "";
    await openTwice(db, statements, async () => {
      currentMarker = await readMarker(sqlite.client);
      await setMarker(sqlite.client, "older");
      failWhen((sql) => sql.includes("SELECT name FROM data_migration"));
      await expect(createD1ExecutorDb(db, undefined)).rejects.toBeDefined();
      expect(await readMarker(sqlite.client)).toBe("older");
      failWhen(null);
    });

    expect(await readMarker(sqlite.client)).toBe(currentMarker);

    await sqlite.close();
  });
});
