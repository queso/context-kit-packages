import { describe, expect, test } from "bun:test";
import { getTableColumns, getTableName, is, Table } from "drizzle-orm";
import {
  getTableConfig as getPgTableConfig,
  PgTable,
} from "drizzle-orm/pg-core";
import {
  getTableConfig as getSqliteTableConfig,
  SQLiteTable,
} from "drizzle-orm/sqlite-core";
import * as postgresSchema from "../schema/postgres";
import * as sqliteSchema from "../schema/sqlite";

const EXPECTED_TABLES = ["clientError"];

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

/**
 * Dialect-neutral view of the constraints drizzle-kit would emit for a table:
 * primary key, unique columns and indexes. Both `getTableConfig` variants
 * expose the same shape for these.
 */
function constraintsOf(schema: Record<string, unknown>, key: string) {
  const table = tableOf(schema, key);
  const config = is(table, PgTable)
    ? getPgTableConfig(table)
    : is(table, SQLiteTable)
      ? getSqliteTableConfig(table)
      : undefined;
  if (!config) {
    throw new Error(`Expected "${key}" to be a pg or sqlite table`);
  }
  return {
    primaryKey: config.columns.filter((c) => c.primary).map((c) => c.name),
    unique: config.columns
      .filter((c) => c.isUnique)
      .map((c) => c.name)
      .sort(),
    indexes: config.indexes
      .map((idx) => ({
        name: idx.config.name ?? "",
        columns: idx.config.columns.map((c) =>
          "name" in c ? c.name : String(c)
        ),
        unique: idx.config.unique,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
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

    test(`"${key}" has the same keys, unique columns and indexes in both dialects`, () => {
      const postgres = constraintsOf(postgresSchema, key);
      expect(postgres).toEqual(constraintsOf(sqliteSchema, key));
      expect(postgres.primaryKey).toEqual(["id"]);
    });
  }

  test("the table maps camelCase properties onto snake_case columns", () => {
    // The query handler returns rows keyed by property name and consumers read
    // `lastSeenAt`, so a rename on either side of this mapping is a breaking
    // change the parity checks above would not notice (they only compare the
    // two dialects against each other).
    for (const schema of [sqliteSchema, postgresSchema]) {
      const columns = getTableColumns(schema.clientError);
      expect(
        Object.fromEntries(
          Object.entries(columns).map(([key, col]) => [key, col.name])
        )
      ).toEqual({
        id: "id",
        message: "message",
        stack: "stack",
        componentStack: "component_stack",
        resolvedStack: "resolved_stack",
        fingerprint: "fingerprint",
        occurrences: "occurrences",
        environment: "environment",
        url: "url",
        userAgent: "user_agent",
        resolvedAt: "resolved_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
        lastSeenAt: "last_seen_at",
      });
      expect(getTableName(schema.clientError)).toBe("client_error");
    }
  });

  test("fingerprint is unique in both dialects so one row can hold every occurrence", () => {
    // The ingestion upsert conflicts on `fingerprint`; without the unique
    // constraint the upsert has nothing to conflict on and every report
    // inserts a new row.
    for (const schema of [sqliteSchema, postgresSchema]) {
      expect(constraintsOf(schema, "clientError").unique).toEqual([
        "fingerprint",
      ]);
    }
  });

  test("both dialects index the columns the query handler filters and sorts on", () => {
    for (const schema of [sqliteSchema, postgresSchema]) {
      expect(constraintsOf(schema, "clientError").indexes).toEqual([
        {
          name: "client_error_environment_idx",
          columns: ["environment"],
          unique: false,
        },
        {
          name: "client_error_last_seen_at_idx",
          columns: ["last_seen_at"],
          unique: false,
        },
      ]);
    }
  });

  test("resolvedAt is the only timestamp that may be null in both dialects", () => {
    // `resolvedAt: null` is what "unresolved" means to the query handler and
    // the CLI, so it must stay nullable while the other timestamps stay not-null.
    for (const schema of [sqliteSchema, postgresSchema]) {
      const columns = getTableColumns(schema.clientError);
      expect(columns.resolvedAt.notNull).toBe(false);
      expect(columns.lastSeenAt.notNull).toBe(true);
      expect(columns.createdAt.notNull).toBe(true);
      expect(columns.updatedAt.notNull).toBe(true);
    }
  });

  test("occurrences, createdAt and updatedAt have insert-time defaults in both dialects", () => {
    // `.$onUpdate(...)` alone sets `hasDefault: true` on the column config (it
    // covers the value drizzle-orm's own query builder falls back to), but it
    // does NOT add a database-level DEFAULT clause, so a raw/adapter-issued
    // INSERT that omits the column still hits a NOT NULL violation. A real
    // insert-time default requires `.default(...)`/`.defaultNow()`, which is
    // reflected in `col.default`/`col.defaultFn` being set.
    for (const schema of [sqliteSchema, postgresSchema]) {
      const columns = getTableColumns(schema.clientError);
      for (const key of ["occurrences", "createdAt", "updatedAt"] as const) {
        expect(columns[key].default).not.toBeUndefined();
      }
      // `id` defaults through a JS function rather than a SQL clause.
      expect(columns.id.defaultFn).toBeInstanceOf(Function);
    }
  });
});
