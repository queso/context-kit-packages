import { describe, test, expect } from "bun:test";
import { getTableColumns, getTableName, is, Table } from "drizzle-orm";
import * as sqliteSchema from "../schema/sqlite";
import * as postgresSchema from "../schema/postgres";

const EXPECTED_TABLES = ["account", "session", "user", "verification"];

function tableKeys(schema: Record<string, unknown>): string[] {
  return Object.keys(schema)
    .filter((key) => is(schema[key], Table))
    .sort();
}

function tableOf(schema: Record<string, unknown>, key: string): Table {
  const table = schema[key];
  if (!is(table, Table)) {
    throw new Error(`Expected "${key}" to be a Drizzle table`);
  }
  return table;
}

describe("schema parity between dialects", () => {
  test("both dialects export the same set of tables", () => {
    expect(tableKeys(sqliteSchema)).toEqual(EXPECTED_TABLES);
    expect(tableKeys(postgresSchema)).toEqual(EXPECTED_TABLES);
  });

  for (const key of EXPECTED_TABLES) {
    test(`"${key}" has the same table name in both dialects`, () => {
      expect(getTableName(tableOf(postgresSchema, key))).toBe(
        getTableName(tableOf(sqliteSchema, key))
      );
    });

    test(`"${key}" has the same column property keys in both dialects`, () => {
      const sqliteCols = Object.keys(
        getTableColumns(tableOf(sqliteSchema, key))
      ).sort();
      const postgresCols = Object.keys(
        getTableColumns(tableOf(postgresSchema, key))
      ).sort();
      expect(postgresCols).toEqual(sqliteCols);
      // Guard against both sides being empty and the comparison passing trivially.
      expect(sqliteCols.length).toBeGreaterThan(0);
    });

    test(`"${key}" has the same column database names in both dialects`, () => {
      const dbNames = (schema: Record<string, unknown>) =>
        Object.values(getTableColumns(tableOf(schema, key)))
          .map((col) => col.name)
          .sort();
      expect(dbNames(postgresSchema)).toEqual(dbNames(sqliteSchema));
    });

    test(`"${key}" has the same nullability and defaults in both dialects`, () => {
      const columnFlags = (schema: Record<string, unknown>) => {
        const columns = getTableColumns(tableOf(schema, key));
        return Object.fromEntries(
          Object.entries(columns).map(([propertyKey, col]) => [
            propertyKey,
            { notNull: col.notNull, hasDefault: col.hasDefault },
          ])
        );
      };
      expect(columnFlags(postgresSchema)).toEqual(columnFlags(sqliteSchema));
    });
  }

  test("every updatedAt column has an insert-time default in both dialects", () => {
    // `.$onUpdate(...)` alone sets `hasDefault: true` on the column config (it
    // covers the value drizzle-orm's own query builder falls back to), but it
    // does NOT add a database-level DEFAULT clause, so a raw/adapter-issued
    // INSERT that omits `updatedAt` still hits a NOT NULL violation. A real
    // insert-time default requires `.default(...)`/`.defaultNow()`, which is
    // reflected in `col.default` being set.
    for (const key of EXPECTED_TABLES) {
      for (const schema of [sqliteSchema, postgresSchema]) {
        const columns = getTableColumns(tableOf(schema, key));
        const updatedAt = columns.updatedAt;
        expect(updatedAt).toBeDefined();
        expect(updatedAt!.default).not.toBeUndefined();
      }
    }
  });

  test("both dialects export the relation helpers", () => {
    for (const schema of [sqliteSchema, postgresSchema]) {
      expect(schema.userRelations).toBeDefined();
      expect(schema.sessionRelations).toBeDefined();
      expect(schema.accountRelations).toBeDefined();
    }
  });
});
