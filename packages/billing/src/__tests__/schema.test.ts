import { describe, test, expect } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "../schema/postgres";

function columns(table: Parameters<typeof getTableConfig>[0]) {
  return Object.fromEntries(
    getTableConfig(table).columns.map((c) => [
      c.name,
      { type: c.getSQLType(), notNull: c.notNull, primary: c.primary },
    ])
  );
}

describe("postgres schema", () => {
  test("exports exactly the four billing tables", () => {
    const names = Object.values(schema)
      .filter((v) => typeof v === "object" && v !== null && Symbol.for("drizzle:IsDrizzleTable") in v)
      .map((t) => getTableConfig(t as never).name)
      .sort();
    expect(names).toEqual([
      "billing_customer",
      "billing_subscription",
      "billing_usage_report",
      "billing_webhook_event",
    ]);
  });

  test("billing_customer maps one subject to one Stripe customer", () => {
    const cols = columns(schema.billingCustomer);
    expect(cols.subject_id).toEqual({ type: "text", notNull: true, primary: true });
    expect(cols.stripe_customer_id?.notNull).toBe(true);
    const unique = getTableConfig(schema.billingCustomer).columns.find(
      (c) => c.name === "stripe_customer_id"
    );
    expect(unique?.isUnique).toBe(true);
  });

  test("times are timestamptz so period math has no time-zone ambiguity", () => {
    for (const table of [
      schema.billingCustomer,
      schema.billingSubscription,
      schema.billingWebhookEvent,
      schema.billingUsageReport,
    ]) {
      for (const col of getTableConfig(table).columns) {
        if (col.columnType === "PgTimestamp" || col.columnType === "PgTimestampString") {
          expect(`${col.name}: ${col.getSQLType()}`).toBe(
            `${col.name}: timestamp with time zone`
          );
        }
      }
    }
  });

  test("usage report value is an integer column and source_id is the primary key", () => {
    const cols = columns(schema.billingUsageReport);
    expect(cols.source_id).toEqual({ type: "text", notNull: true, primary: true });
    expect(cols.value?.type).toBe("bigint");
    expect(cols.status?.notNull).toBe(true);
  });

  test("webhook events are keyed by the Stripe event id", () => {
    const cols = columns(schema.billingWebhookEvent);
    expect(cols.stripe_event_id).toEqual({ type: "text", notNull: true, primary: true });
    expect(cols.processed_at?.notNull).toBe(false);
  });
});
