/**
 * The package's only database access point.
 *
 * The consumer's Drizzle instance arrives typed as `object` (it is generic over
 * their schema, and it may be a Proxy over a lazily created instance), so it is
 * narrowed here by dialect and only ever used through method calls. Two small
 * per-dialect implementations behind one interface beat a single generic one
 * fighting the SQLite/Postgres union types.
 */

import { and, count, desc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { clientError as postgresClientError } from "../schema/postgres.js";
import {
  type ClientError,
  clientError as sqliteClientError,
} from "../schema/sqlite.js";
import type { DatabaseConfig } from "../types.js";

/**
 * A `client_error` row. The SQLite and Postgres schemas are column-for-column
 * identical, so one row type describes both.
 */
export type ClientErrorRecord = ClientError;

/** The fields an incoming report contributes to the `client_error` row. */
export interface OccurrenceValues {
  message: string;
  stack: string | null;
  componentStack: string | null;
  resolvedStack: string | null;
  fingerprint: string;
  environment: string;
  url: string | null;
  userAgent: string | null;
  /** Timestamp applied to `lastSeenAt`/`createdAt`/`updatedAt`. */
  now: Date;
}

export interface ListFilters {
  environment?: string;
  since?: Date;
  fingerprint?: string;
  /** `true` matches resolved rows, `false` unresolved ones. */
  resolved?: boolean;
}

export interface ListOptions {
  filters?: ListFilters;
  limit: number;
  offset?: number;
}

export interface ListResult {
  errors: ClientErrorRecord[];
  total: number;
}

export interface ErrorStore {
  /** Inserts the row, or increments and reopens the existing fingerprint. */
  recordOccurrence(values: OccurrenceValues): Promise<void>;
  list(options: ListOptions): Promise<ListResult>;
  /** Resolves an open error; returns how many rows changed (0 or 1). */
  resolve(fingerprint: string): Promise<number>;
}

type ClientErrorTable = typeof sqliteClientError | typeof postgresClientError;

// Drizzle databases are generic over the consumer's schema, which this package
// never sees. `any` in these positions is what lets a store accept any
// consumer instance; every value read back out is typed by the table above.
type SQLiteDatabase = BaseSQLiteDatabase<"async" | "sync", any, any>;
type PostgresDatabase = PgDatabase<any, any, any>;

function insertValues(values: OccurrenceValues) {
  return {
    message: values.message,
    stack: values.stack,
    componentStack: values.componentStack,
    resolvedStack: values.resolvedStack,
    fingerprint: values.fingerprint,
    occurrences: 1,
    environment: values.environment,
    url: values.url,
    userAgent: values.userAgent,
    lastSeenAt: values.now,
    createdAt: values.now,
    updatedAt: values.now,
  };
}

/**
 * The conflict branch of the upsert. Message, stack, url and friends are left
 * alone so a recurrence never rewrites the first report's details; a recurrence
 * of a resolved error reopens it by clearing `resolvedAt`. `excluded` is the
 * incoming row in both SQLite and Postgres.
 */
function conflictSet(table: ClientErrorTable, now: Date) {
  return {
    occurrences: sql`${table.occurrences} + 1`,
    lastSeenAt: now,
    updatedAt: now,
    resolvedAt: null,
    resolvedStack: sql`coalesce(excluded.resolved_stack, ${table.resolvedStack})`,
  };
}

function buildWhere(table: ClientErrorTable, filters: ListFilters = {}) {
  const conditions = [];

  if (filters.environment) {
    conditions.push(eq(table.environment, filters.environment));
  }
  if (filters.since) {
    conditions.push(gte(table.lastSeenAt, filters.since));
  }
  if (filters.fingerprint) {
    conditions.push(eq(table.fingerprint, filters.fingerprint));
  }
  if (filters.resolved === true) {
    conditions.push(isNotNull(table.resolvedAt));
  } else if (filters.resolved === false) {
    conditions.push(isNull(table.resolvedAt));
  }

  return conditions.length > 0 ? and(...conditions) : undefined;
}

function createSQLiteStore(db: SQLiteDatabase): ErrorStore {
  const table = sqliteClientError;

  return {
    async recordOccurrence(values) {
      await db
        .insert(table)
        .values(insertValues(values))
        .onConflictDoUpdate({
          target: table.fingerprint,
          set: conflictSet(table, values.now),
        })
        .run();
    },

    async list({ filters, limit, offset = 0 }) {
      const where = buildWhere(table, filters);
      const [errors, totals] = await Promise.all([
        db
          .select()
          .from(table)
          .where(where)
          .orderBy(desc(table.lastSeenAt))
          .limit(limit)
          .offset(offset)
          .all(),
        db.select({ value: count() }).from(table).where(where).all(),
      ]);
      return { errors, total: totals[0]?.value ?? 0 };
    },

    async resolve(fingerprint) {
      const now = new Date();
      const updated = await db
        .update(table)
        .set({ resolvedAt: now, updatedAt: now })
        .where(
          and(eq(table.fingerprint, fingerprint), isNull(table.resolvedAt))
        )
        .returning({ id: table.id });
      return updated.length;
    },
  };
}

function createPostgresStore(db: PostgresDatabase): ErrorStore {
  const table = postgresClientError;

  return {
    async recordOccurrence(values) {
      await db
        .insert(table)
        .values(insertValues(values))
        .onConflictDoUpdate({
          target: table.fingerprint,
          set: conflictSet(table, values.now),
        });
    },

    async list({ filters, limit, offset = 0 }) {
      const where = buildWhere(table, filters);
      const [errors, totals] = await Promise.all([
        db
          .select()
          .from(table)
          .where(where)
          .orderBy(desc(table.lastSeenAt))
          .limit(limit)
          .offset(offset),
        db.select({ value: count() }).from(table).where(where),
      ]);
      return { errors, total: totals[0]?.value ?? 0 };
    },

    async resolve(fingerprint) {
      const now = new Date();
      const updated = await db
        .update(table)
        .set({ resolvedAt: now, updatedAt: now })
        .where(
          and(eq(table.fingerprint, fingerprint), isNull(table.resolvedAt))
        )
        .returning({ id: table.id });
      return updated.length;
    },
  };
}

/**
 * Validates the database configuration and returns the store for its dialect.
 * Throws synchronously so a misconfigured route fails at module load rather
 * than on the first request.
 */
export function createStore(config: DatabaseConfig): ErrorStore {
  if (!config.db) {
    throw new Error(
      'A Drizzle database instance is required. Pass your Drizzle db as the `db` option (e.g. `import { db } from "@/db"`).'
    );
  }

  if (config.dialect === "sqlite") {
    return createSQLiteStore(config.db as SQLiteDatabase);
  }

  if (config.dialect === "postgres") {
    return createPostgresStore(config.db as PostgresDatabase);
  }

  throw new Error(
    `Unsupported dialect "${config.dialect}". Expected "sqlite" or "postgres".`
  );
}
