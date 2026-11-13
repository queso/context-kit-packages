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
  shared ??= open();
  const db = await shared;
  await db.execute(
    sql`truncate billing_customer, billing_subscription, billing_webhook_event, billing_usage_report`
  );
  return { db, close: async () => {} };
}
