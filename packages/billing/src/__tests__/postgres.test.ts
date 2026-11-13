import { describe, test, expect, afterAll } from "bun:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "../schema/postgres";
import { enqueueUsage, reportPendingUsage } from "../usage";
import { processEvent } from "../webhooks";
import { FakeStripe } from "./helpers/fake-stripe";
import { testConfig } from "./helpers/config";
import eventFixture from "./fixtures/stripe/event.json";
import type { BillingContext, BillingDb } from "../types";

/**
 * Concurrency checks that need a real Postgres server: PGlite runs one
 * transaction at a time, so FOR UPDATE SKIP LOCKED is only exercised here.
 * Locally the suite skips without DATABASE_URL; CI sets REQUIRE_POSTGRES so a
 * missing server fails the job.
 */

const url = process.env.DATABASE_URL ?? "";
const hasPostgres = /^postgres(ql)?:/.test(url);

if (process.env.REQUIRE_POSTGRES && !hasPostgres) {
  // The URL is not printed: it may carry credentials and this ends up in CI logs.
  throw new Error("REQUIRE_POSTGRES is set but DATABASE_URL is missing or is not a postgres:// or postgresql:// URL");
}

let client: ReturnType<typeof postgres> | undefined;
afterAll(async () => {
  await client?.end({ timeout: 5 });
});

async function setup(): Promise<BillingDb> {
  client = postgres(url, { max: 6, onnotice: () => {} });
  const db = drizzle(client, { schema });
  await db.execute(
    sql`drop table if exists billing_customer, billing_subscription, billing_webhook_event, billing_usage_report`
  );
  const { pushSchema } = await import("drizzle-kit/api");
  // drizzle-kit's pushSchema reads `result.rows` off every execute(), but
  // postgres-js returns the rows array directly.
  const pushTarget = { execute: async (q: unknown) => ({ rows: await db.execute(q as never) }) };
  const { apply } = await pushSchema(schema, pushTarget as never);
  await apply();
  return db as unknown as BillingDb;
}

describe.skipIf(!hasPostgres)("against a real Postgres server", () => {
  test("concurrent reporters send every pending row exactly once", async () => {
    const db = await setup();
    const fake = new FakeStripe();
    // Slow Stripe down so the reporters overlap.
    const realFetch = fake.fetch;
    const slow = async (input: string | URL | Request, init?: RequestInit) => {
      await new Promise((r) => setTimeout(r, 15));
      return realFetch(input, init);
    };
    const stripe = (await import("../stripe-client")).createStripeClient("sk_test_fake", {
      httpClient: (await import("stripe")).default.createFetchHttpClient(slow as typeof fetch),
      maxNetworkRetries: 0,
    });
    const ctx: BillingContext = { db, stripe, config: testConfig };

    await db.insert(schema.billingCustomer).values({ subjectId: "1", stripeCustomerId: "cus_1", livemode: false });
    await db.insert(schema.billingSubscription).values({
      stripeSubscriptionId: "sub_1",
      subjectId: "1",
      stripeCustomerId: "cus_1",
      status: "active",
      planKey: "pro",
      overagePriceId: "price_over",
      currentPeriodStart: new Date(Date.now() - 86_400_000),
      currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
      livemode: false,
      syncedAt: new Date(),
    });
    const ids = Array.from({ length: 30 }, (_, i) => `run_${i}`);
    for (const id of ids) await enqueueUsage(ctx, { sourceId: id, subjectId: "1", value: 2, occurredAt: new Date() });

    const summaries = await Promise.all([1, 2, 3, 4].map(() => reportPendingUsage(ctx, { limit: 30 })));

    const sentCalls = fake.requests.filter((r) => r.path === "/v1/billing/meter_events").map((r) => r.params.identifier);
    expect(sentCalls.sort()).toEqual([...ids].sort());
    expect(summaries.reduce((n, s) => n + s.sent, 0)).toBe(30);
    const statuses = await db.select({ status: schema.billingUsageReport.status }).from(schema.billingUsageReport);
    expect(statuses.every((s) => s.status === "sent")).toBe(true);
  });

  test("the same event delivered twice at once leaves one event row and one subscription row", async () => {
    const db = await setup();
    const fake = new FakeStripe();
    fake.addPrice({ id: "price_pro", lookupKey: "test_pro_monthly" });
    fake.putSubscription({ id: "sub_1", customer: "cus_1", status: "active", priceIds: ["price_pro"], metadata: { subject_id: "1" } });
    const ctx: BillingContext = { db, stripe: fake.client(), config: testConfig };
    const event = {
      ...structuredClone(eventFixture),
      id: "evt_concurrent",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_1", object: "subscription" } },
    } as never;

    const outcomes = await Promise.all([processEvent(ctx, event), processEvent(ctx, event)]);

    expect(outcomes.filter((o) => o === "processed").length).toBeGreaterThanOrEqual(1);
    expect(await db.select().from(schema.billingWebhookEvent)).toHaveLength(1);
    expect(await db.select().from(schema.billingSubscription)).toHaveLength(1);
  });
});
