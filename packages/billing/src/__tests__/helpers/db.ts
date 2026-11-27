import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../../schema/postgres";
import type { BillingDb } from "../../types";

/**
 * One in-process Postgres (PGlite) per test process, with the billing tables
 * pushed once. Pushing the schema is the slow part, so each test gets the same
 * database with every billing table truncated instead of a new instance.
 */
let shared: Promise<BillingDb> | undefined;

async function open(): Promise<BillingDb> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  const { pushSchema } = await import("drizzle-kit/api");
  const { apply } = await pushSchema(schema, db as never);
  await apply();
  return db as unknown as BillingDb;
}

export async function createTestDb(): Promise<{ db: BillingDb; close: () => Promise<void> }> {
  // A failed open is not cached, so a one-off failure does not poison every later test.
  shared ??= open().catch((err) => {
    shared = undefined;
    throw err;
  });
  const db = await shared;
  await db.execute(
    sql`truncate billing_customer, billing_subscription, billing_webhook_event, billing_usage_report`
  );
  // close is a no-op on purpose: the PGlite instance is shared by every test in
  // the process, so closing it per test would break the next one. Process exit
  // releases it.
  return { db, close: async () => {} };
}
