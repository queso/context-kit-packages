/** The `client_error` table exactly as 0.1.0 shipped it, for migration tests. Do not edit. */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const clientError = sqliteTable(
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
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("client_error_last_seen_at_idx").on(table.lastSeenAt),
    index("client_error_environment_idx").on(table.environment),
  ]
);

export type ClientError = typeof clientError.$inferSelect;
export type NewClientError = typeof clientError.$inferInsert;
