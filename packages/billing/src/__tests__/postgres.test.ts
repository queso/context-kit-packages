import { describe, test, expect, afterAll } from "bun:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "../schema/postgres";
import { enqueueUsage, reportPendingUsage } from "../usage";
import { processEvent } from "../webhooks";
import { syncSubscription } from "../subscriptions";
import { FakeStripe } from "./helpers/fake-stripe";
import { testConfig } from "./helpers/config";
import eventFixture from "./fixtures/stripe/event.json";
import type { BillingContext, BillingDb } from "../types";

/**
 * Concurrency checks that need a real Postgres server: PGlite runs one
 * transaction at a time, so FOR UPDATE SKIP LOCKED is only exercised here.
 * setup() drops and recreates the billing tables, so the suite runs only when
 * BILLING_TEST_DATABASE_URL is a postgres URL (a dedicated variable, separate
 * from an application's DATABASE_URL) AND BILLING_TEST_ALLOW_DROP=1 (an explicit
 * destructive opt-in). Otherwise it skips; CI sets REQUIRE_POSTGRES so a missing
 * variable fails the job.
 */

const url = process.env.BILLING_TEST_DATABASE_URL ?? "";
const hasUrl = /^postgres(ql)?:/.test(url);
const allowDrop = process.env.BILLING_TEST_ALLOW_DROP === "1";
const hasPostgres = hasUrl && allowDrop;

const missing: string[] = [];
if (!hasUrl) missing.push("BILLING_TEST_DATABASE_URL (a postgres:// or postgresql:// URL)");
if (!allowDrop) missing.push("BILLING_TEST_ALLOW_DROP=1");

if (process.env.REQUIRE_POSTGRES && !hasPostgres) {
  // The URL is never printed: it may carry credentials and this ends up in CI logs.
  throw new Error(`REQUIRE_POSTGRES is set but the billing Postgres tests are missing: ${missing.join(", ")}`);
}

if (!hasPostgres) {
  console.warn(
    `Skipping billing Postgres tests (the suite drops and recreates the billing tables). Missing: ${missing.join(", ")}`
  );
}

const clients: ReturnType<typeof postgres>[] = [];
afterAll(async () => {
  await Promise.all(clients.map((c) => c.end({ timeout: 5 })));
});

/** Polls until some backend is blocked on a lock, so a test knows a call is waiting instead of guessing with a sleep. */
async function waitForLockWaiter(db: BillingDb, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = (await (db as unknown as ReturnType<typeof drizzle>).execute(
      sql`select 1 from pg_stat_activity where wait_event_type = 'Lock' and pid <> pg_backend_pid()`
    )) as unknown as unknown[];
    if (rows.length > 0) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no backend started waiting on a lock within ${timeoutMs} ms`);
}

async function setup(): Promise<BillingDb> {
  const client = postgres(url, { max: 6, onnotice: () => {} });
  clients.push(client);
  const db = drizzle(client, { schema });
  await db.execute(
    sql`drop table if exists billing_customer, billing_subscription, billing_webhook_event, billing_usage_report`
  );
  const { pushSchema } = await import("drizzle-kit/api");
  // drizzle-kit's pushSchema reads `result.rows` off every execute(), but
  // postgres-js returns the rows array directly.
  const pushTarget = { execute: async (q: unknown) => ({ rows: await db.execute(q as never) }) };
  // Only billing tables. CI runs the other packages' Postgres tests against the
  // same database first; without the filter drizzle-kit sees their tables, asks
  // interactively whether one was renamed to a billing table, and fails with
  // "Interactive prompts require a TTY terminal".
  const { apply } = await pushSchema(schema, pushTarget as never, ["public"], ["billing_*"]);
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
      billingInterval: "month",
      billingIntervalCount: 1,
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

  test("two concurrent syncs of one subscription leave Stripe's newer state, not the older one", async () => {
    const db = await setup();
    const fake = new FakeStripe();
    fake.addPrice({ id: "price_pro", lookupKey: "test_pro_monthly" });
    fake.addPrice({ id: "price_team", lookupKey: "test_team_monthly" });
    fake.putSubscription({ id: "sub_1", customer: "cus_1", status: "active", priceIds: ["price_pro"], metadata: { subject_id: "1" } });

    // The first retrieve sees Pro, and Stripe's state moves to Team right after
    // it is read; its response is slow. The second retrieve sees Team and
    // answers at once. Unserialized, the slow Pro write lands last.
    let retrieves = 0;
    let firstInFlight!: () => void;
    const firstRetrieveStarted = new Promise<void>((r) => (firstInFlight = r));
    let releaseFirst!: () => void;
    const firstHold = new Promise<void>((r) => (releaseFirst = r));
    const realFetch = fake.fetch;
    const slowFirst = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.includes("/v1/subscriptions/sub_1")) return realFetch(input, init);
      const n = ++retrieves;
      const res = await realFetch(input, init);
      if (n === 1) {
        fake.putSubscription({ id: "sub_1", customer: "cus_1", status: "active", priceIds: ["price_team"], metadata: { subject_id: "1" } });
        firstInFlight();
        await firstHold;
      }
      return res;
    };
    const Stripe = (await import("stripe")).default;
    const stripe = (await import("../stripe-client")).createStripeClient("sk_test_fake", {
      httpClient: Stripe.createFetchHttpClient(slowFirst as typeof fetch),
      maxNetworkRetries: 0,
    });
    const ctx: BillingContext = { db, stripe, config: testConfig };

    const first = syncSubscription(ctx, "sub_1");
    await firstRetrieveStarted;
    const second = syncSubscription(ctx, "sub_1");
    // The second sync must be blocked on the advisory lock before the first
    // is allowed to finish.
    await waitForLockWaiter(db);
    expect(retrieves).toBe(1);
    releaseFirst();
    await Promise.all([first, second]);

    const [row] = await db.select().from(schema.billingSubscription);
    expect(row?.planKey).toBe("team");
    expect(retrieves).toBe(2);
  });
  // INSERT ... ON CONFLICT DO NOTHING waits for a conflicting uncommitted
  // insert, so the follow-up SELECT sees a committed row and never reports a
  // false "conflict".
  describe("enqueueUsage against an uncommitted insert of the same sourceId", () => {
    async function race(finish: "commit" | "rollback") {
      const db = await setup();
      const ctx: BillingContext = { db, stripe: {} as never, config: testConfig };
      const record = { sourceId: "race_1", subjectId: "1", value: 3, occurredAt: new Date() };
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let inserted!: () => void;
      const firstInserted = new Promise<void>((r) => (inserted = r));
      let committedAt = 0;

      const first = (db as unknown as { transaction: (fn: (tx: BillingDb) => Promise<void>) => Promise<void> })
        .transaction(async (tx) => {
          expect(await enqueueUsage({ ...ctx, db: tx }, record)).toBe("enqueued");
          inserted();
          await gate;
          committedAt = Date.now();
          if (finish === "rollback") throw new Error("rollback");
        })
        .catch((err) => {
          if (finish !== "rollback") throw err;
        });
      await firstInserted;

      let resolvedAt = 0;
      const second = enqueueUsage(ctx, record).then((r) => {
        resolvedAt = Date.now();
        return r;
      });
      await waitForLockWaiter(db);
      release();
      await first;
      const result = await second;
      return { result, resolvedAt, committedAt };
    }

    test("resolves to duplicate, and only after the first transaction commits", async () => {
      const { result, resolvedAt, committedAt } = await race("commit");
      expect(result).toBe("duplicate");
      expect(resolvedAt).toBeGreaterThanOrEqual(committedAt);
    });

    test("resolves to enqueued when the first transaction rolls back", async () => {
      const { result, resolvedAt, committedAt } = await race("rollback");
      expect(result).toBe("enqueued");
      expect(resolvedAt).toBeGreaterThanOrEqual(committedAt);
    });
  });
});
