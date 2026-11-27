import { describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import * as postgresSchema from "../schema/postgres";
import * as sqliteSchema from "../schema/sqlite";
import * as postgres010 from "./fixtures/schema-0.1.0-postgres";
import * as sqlite010 from "./fixtures/schema-0.1.0-sqlite";

/**
 * What a consumer's `bun run db:generate` produces when they upgrade from
 * 0.1.0: drizzle-kit's diff from the 0.1.0 table to the current one.
 */
async function upgradeStatements(dialect: "sqlite" | "postgres") {
  const api = await import("drizzle-kit/api");
  if (dialect === "sqlite") {
    return api.generateSQLiteMigration(
      await api.generateSQLiteDrizzleJson(sqlite010),
      await api.generateSQLiteDrizzleJson(sqliteSchema)
    );
  }
  return api.generateMigration(
    api.generateDrizzleJson(postgres010),
    api.generateDrizzleJson(postgresSchema)
  );
}

/** Statements that only add: no drop, rename, retype or table rebuild. */
const ADDITIVE = /^(ALTER TABLE [`"]client_error[`"] ADD (COLUMN )?|CREATE INDEX )/;

describe("upgrade migration from 0.1.0", () => {
  for (const dialect of ["sqlite", "postgres"] as const) {
    test(`${dialect}: every statement only adds a column or an index`, async () => {
      const statements = await upgradeStatements(dialect);
      expect(statements.length).toBe(5);
      for (const statement of statements) {
        expect(statement).toMatch(ADDITIVE);
      }
      const source = statements.find((s) => s.includes("source"));
      expect(source).toContain("DEFAULT 'client' NOT NULL");
    });
  }

  test("sqlite: an existing 0.1.0 row reads as client after the upgrade", async () => {
    const db = drizzle(createClient({ url: ":memory:" }));
    const api = await import("drizzle-kit/api");
    const create = await api.generateSQLiteMigration(
      await api.generateSQLiteDrizzleJson({}),
      await api.generateSQLiteDrizzleJson(sqlite010)
    );
    for (const statement of create) await db.run(sql.raw(statement));

    await db.insert(sqlite010.clientError).values({
      message: "written by 0.1.0",
      fingerprint: "fp-old",
      environment: "production",
      lastSeenAt: new Date(),
    });

    for (const statement of await upgradeStatements("sqlite")) {
      await db.run(sql.raw(statement));
    }

    const [row] = await db.select().from(sqliteSchema.clientError);
    expect(row?.message).toBe("written by 0.1.0");
    expect(row?.source).toBe("client");
    expect(row?.route).toBeNull();
    expect(row?.method).toBeNull();
    expect(row?.tag).toBeNull();
  });
});
