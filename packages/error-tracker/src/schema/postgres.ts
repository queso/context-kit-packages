/**
 * Drizzle schema for PostgreSQL.
 *
 * Consumers re-export this from their own schema so Drizzle Kit picks it up:
 *
 * ```ts
 * // db/schema/postgres.ts
 * export * from "@context-kit/error-tracker/schema/postgres";
 * ```
 *
 * Then run `bun run db:generate` to emit the migration.
 *
 * This file and `./sqlite` must stay column-for-column in sync — same table
 * name, same TS property keys, same column names, nullability and indexes. A
 * parity test enforces it.
 */

import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const clientError = pgTable(
  "client_error",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => /* @__PURE__ */ crypto.randomUUID()),
    message: text("message").notNull(),
    stack: text("stack"),
    componentStack: text("component_stack"),
    resolvedStack: text("resolved_stack"),
    /** SHA-256 of message + top frames; one row per fingerprint. */
    fingerprint: text("fingerprint").notNull().unique(),
    occurrences: integer("occurrences").default(1).notNull(),
    environment: text("environment").notNull(),
    url: text("url"),
    userAgent: text("user_agent"),
    /** Null while the error is open; cleared again when it recurs. */
    resolvedAt: timestamp("resolved_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    lastSeenAt: timestamp("last_seen_at").notNull(),
  },
  (table) => [
    index("client_error_last_seen_at_idx").on(table.lastSeenAt),
    index("client_error_environment_idx").on(table.environment),
  ]
);

export type ClientError = typeof clientError.$inferSelect;
export type NewClientError = typeof clientError.$inferInsert;
