import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { computeOverage, enqueueUsage, reportPendingUsage } from "../usage";
import { billingCustomer, billingSubscription, billingUsageReport } from "../schema/postgres";
import { createTestDb } from "./helpers/db";
import { FakeStripe } from "./helpers/fake-stripe";
import { testConfig } from "./helpers/config";
import type { BillingContext } from "../types";

describe("computeOverage", () => {
  test.each([
    // included, usedBefore, units, expected
    [250, 0, 1, 0],
    [250, 249, 1, 0],
    [250, 249, 3, 2],
    [250, 250, 7, 7],
    [250, 400, 3, 3],
    [0, 0, 5, 5],
    [250, 100, 0, 0],
  ])("included %i, used %i before, run of %i units: %i over", (included, before, units, expected) => {
    expect(computeOverage({ includedUnits: included, usedBefore: before, units })).toBe(expected);
  });

  test("the overage of consecutive runs adds up to the period's overage", () => {
    const runs = [100, 100, 40, 15, 1, 7, 3];
    let before = 0;
    let total = 0;
    for (const units of runs) {
      total += computeOverage({ includedUnits: 250, usedBefore: before, units });
      before += units;
    }
    expect(total).toBe(before - 250);
  });

  test.each([
    { includedUnits: -1, usedBefore: 0, units: 1 },
    { includedUnits: 1.5, usedBefore: 0, units: 1 },
    { includedUnits: 1, usedBefore: -2, units: 1 },
    { includedUnits: 1, usedBefore: 0, units: 0.5 },
    { includedUnits: 1, usedBefore: 0, units: -1 },
  ])("rejects non-integer or negative input %p", (input) => {
    expect(() => computeOverage(input)).toThrow();
  });
});

const NOW = new Date("2026-01-20T12:00:00Z");
const PERIOD_START = new Date("2026-01-01T00:00:00Z");

describe("usage outbox", () => {
  let fake: FakeStripe;
  let ctx: BillingContext;
  let close: () => Promise<void>;
  let clock: Date;

  beforeEach(async () => {
    fake = new FakeStripe();
    const t = await createTestDb();
    close = t.close;
    clock = NOW;
    ctx = { db: t.db, stripe: fake.client(), config: testConfig, now: () => clock };
    await ctx.db.insert(billingCustomer).values({ subjectId: "100", stripeCustomerId: "cus_100", livemode: false });
    await ctx.db.insert(billingSubscription).values({
      stripeSubscriptionId: "sub_100",
      subjectId: "100",
      stripeCustomerId: "cus_100",
      status: "active",
      planKey: "pro",
      basePriceId: "price_pro",
      overagePriceId: "price_over",
      currentPeriodStart: PERIOD_START,
      currentPeriodEnd: new Date("2026-02-01T00:00:00Z"),
      cancelAt: null,
      trialEnd: null,
      pastDueSince: null,
      livemode: false,
      syncedAt: NOW,
    });
  });
  afterEach(() => close());

  const rowFor = async (sourceId: string) =>
    (await ctx.db.select().from(billingUsageReport).where(eq(billingUsageReport.sourceId, sourceId)))[0];
  const meterCalls = () => fake.requests.filter((r) => r.path === "/v1/billing/meter_events");

  describe("enqueueUsage", () => {
    test("stores a pending row for the meter in the config", async () => {
      const r = await enqueueUsage(ctx, { sourceId: "run_1", subjectId: "100", value: 3, occurredAt: new Date("2026-01-20T11:00:00Z") });
      expect(r).toBe("enqueued");
      expect(await rowFor("run_1")).toMatchObject({
        subjectId: "100",
        eventName: "test_credits",
        value: 3,
        status: "pending",
        attempts: 0,
      });
    });

    test("a zero value is stored as skipped, so every run still has one row", async () => {
      expect(await enqueueUsage(ctx, { sourceId: "run_0", subjectId: "100", value: 0, occurredAt: NOW })).toBe("skipped");
      expect((await rowFor("run_0"))?.status).toBe("skipped");
    });

    test("the same source twice with the same value is a duplicate", async () => {
      await enqueueUsage(ctx, { sourceId: "run_1", subjectId: "100", value: 3, occurredAt: NOW });
      expect(await enqueueUsage(ctx, { sourceId: "run_1", subjectId: "100", value: 3, occurredAt: NOW })).toBe("duplicate");
      expect(await ctx.db.select().from(billingUsageReport)).toHaveLength(1);
    });

    test("the same source with a different value is a conflict and the first row stands", async () => {
      await enqueueUsage(ctx, { sourceId: "run_1", subjectId: "100", value: 3, occurredAt: NOW });
      expect(await enqueueUsage(ctx, { sourceId: "run_1", subjectId: "100", value: 9, occurredAt: NOW })).toBe("conflict");
      expect((await rowFor("run_1"))?.value).toBe(3);
    });

    test("runs inside the caller's transaction and rolls back with it", async () => {
      await expect(
        ctx.db.transaction(async (tx) => {
          await enqueueUsage({ ...ctx, db: tx }, { sourceId: "run_tx", subjectId: "100", value: 2, occurredAt: NOW });
          throw new Error("ledger insert failed");
        })
      ).rejects.toThrow("ledger insert failed");
      expect(await rowFor("run_tx")).toBeUndefined();
    });

    test.each([
      { sourceId: "", value: 1 },
      { sourceId: "x".repeat(101), value: 1 },
      { sourceId: "ok", value: 1.5 },
      { sourceId: "ok", value: -1 },
    ])("rejects %p", async ({ sourceId, value }) => {
      await expect(enqueueUsage(ctx, { sourceId, subjectId: "100", value, occurredAt: NOW })).rejects.toThrow();
    });
  });

  describe("reportPendingUsage", () => {
    test("sends one meter event per row, keyed by the source id, and marks it sent", async () => {
      const occurredAt = new Date("2026-01-20T11:00:00Z");
      await enqueueUsage(ctx, { sourceId: "run_1", subjectId: "100", value: 3, occurredAt });

      const summary = await reportPendingUsage(ctx);

      expect(summary).toEqual({ sent: 1, retry: 0, failed: 0, late: 0, needsReview: 0 });
      const [call] = meterCalls();
      expect(call?.params).toEqual({
        event_name: "test_credits",
        identifier: "run_1",
        timestamp: String(occurredAt.getTime() / 1000),
        payload: { stripe_customer_id: "cus_100", value: "3" },
      });
      expect(call?.idempotencyKey).toBe("context-kit-billing:meter:run_1:1");
      expect(await rowFor("run_1")).toMatchObject({ status: "sent", attempts: 1, sentAt: NOW, firstAttemptAt: NOW });
    });

    test("a second run sends nothing more", async () => {
      await enqueueUsage(ctx, { sourceId: "run_1", subjectId: "100", value: 3, occurredAt: NOW });
      await reportPendingUsage(ctx);
      await reportPendingUsage(ctx);
      expect(meterCalls()).toHaveLength(1);
    });

    test("skipped rows are never sent", async () => {
      await enqueueUsage(ctx, { sourceId: "run_0", subjectId: "100", value: 0, occurredAt: NOW });
      await reportPendingUsage(ctx);
      expect(meterCalls()).toHaveLength(0);
    });

    test("a transient Stripe error leaves the row pending for the next run", async () => {
      await enqueueUsage(ctx, { sourceId: "run_1", subjectId: "100", value: 3, occurredAt: NOW });
      fake.failNext((r) => r.path === "/v1/billing/meter_events", 503);

      expect((await reportPendingUsage(ctx)).retry).toBe(1);
      expect(await rowFor("run_1")).toMatchObject({ status: "pending", attempts: 1 });
      expect((await rowFor("run_1"))?.lastError).toBeTruthy();

      expect((await reportPendingUsage(ctx)).sent).toBe(1);
      expect(fake.meterEvents).toHaveLength(1);
    });

    test("when Stripe accepted the event but the response was lost, the retry does not double-bill", async () => {
      await enqueueUsage(ctx, { sourceId: "run_1", subjectId: "100", value: 3, occurredAt: NOW });
      fake.loseNextResponse((r) => r.path === "/v1/billing/meter_events");

      await reportPendingUsage(ctx);
      expect((await rowFor("run_1"))?.status).toBe("pending");
      await reportPendingUsage(ctx);

      expect(meterCalls()).toHaveLength(2);
      expect(new Set(meterCalls().map((c) => c.params.identifier))).toEqual(new Set(["run_1"]));
      expect(fake.meterEvents).toHaveLength(1);
      expect((await rowFor("run_1"))?.status).toBe("sent");
    });

    test("a request Stripe rejects is marked failed and not retried", async () => {
      await enqueueUsage(ctx, { sourceId: "run_1", subjectId: "100", value: 3, occurredAt: NOW });
      fake.failNext((r) => r.path === "/v1/billing/meter_events", 400, 1, {
        error: { type: "invalid_request_error", message: "No such meter event name" },
      });

      expect((await reportPendingUsage(ctx)).failed).toBe(1);
      expect(await rowFor("run_1")).toMatchObject({ status: "failed", lastError: "No such meter event name" });
      await reportPendingUsage(ctx);
      expect(meterCalls()).toHaveLength(1);
    });

    test("a subject with no Stripe customer is marked failed", async () => {
      await enqueueUsage(ctx, { sourceId: "run_x", subjectId: "nobody", value: 3, occurredAt: NOW });
      expect((await reportPendingUsage(ctx)).failed).toBe(1);
      expect(await rowFor("run_x")).toMatchObject({ status: "failed", lastError: "no_customer" });
      expect(meterCalls()).toHaveLength(0);
    });

    test("usage from before the current period's invoice grace window is marked late, not sent", async () => {
      // Default invoiceGraceHours is 1: the previous period's invoice closed at 01:00 on the 1st.
      await enqueueUsage(ctx, { sourceId: "run_old", subjectId: "100", value: 3, occurredAt: new Date("2025-12-31T22:59:59Z") });
      expect((await reportPendingUsage(ctx)).late).toBe(1);
      expect((await rowFor("run_old"))?.status).toBe("late");
      expect(meterCalls()).toHaveLength(0);
    });

    test("usage from the previous period is still sent while its invoice is in the grace window", async () => {
      clock = new Date("2026-01-01T00:30:00Z");
      await enqueueUsage(ctx, { sourceId: "run_edge", subjectId: "100", value: 3, occurredAt: new Date("2025-12-31T23:59:00Z") });
      expect((await reportPendingUsage(ctx)).sent).toBe(1);
    });

    test("a longer invoiceGraceHours keeps late usage billable for longer", async () => {
      ctx = { ...ctx, config: { ...testConfig, invoiceGraceHours: 24 } };
      clock = new Date("2026-01-01T20:00:00Z");
      await enqueueUsage(ctx, { sourceId: "run_24", subjectId: "100", value: 3, occurredAt: new Date("2025-12-31T23:00:00Z") });
      expect((await reportPendingUsage(ctx)).sent).toBe(1);
    });

    test("usage older than Stripe's 35-day window is marked late", async () => {
      // A long period, so only the 35-day rule can make this row late.
      clock = new Date("2026-03-01T00:00:00Z");
      await ctx.db
        .update(billingSubscription)
        .set({ currentPeriodStart: new Date("2026-01-01T00:00:00Z"), currentPeriodEnd: new Date("2026-04-01T00:00:00Z") });
      await enqueueUsage(ctx, { sourceId: "run_ancient", subjectId: "100", value: 3, occurredAt: new Date("2026-01-20T00:00:00Z") });
      expect((await reportPendingUsage(ctx)).late).toBe(1);
    });

    test("a row still unsent 20 hours after its first attempt goes to needs_review instead of being resent", async () => {
      await enqueueUsage(ctx, { sourceId: "run_1", subjectId: "100", value: 3, occurredAt: NOW });
      fake.failNext((r) => r.path === "/v1/billing/meter_events", 503);
      await reportPendingUsage(ctx);

      clock = new Date(NOW.getTime() + 20 * 3_600_000 + 1);
      expect((await reportPendingUsage(ctx)).needsReview).toBe(1);
      expect((await rowFor("run_1"))?.status).toBe("needs_review");
      expect(meterCalls()).toHaveLength(1);
    });

    test("usage from two periods back is late even while the previous invoice is still open", async () => {
      clock = new Date("2026-01-01T00:30:00Z");
      await enqueueUsage(ctx, { sourceId: "run_2back", subjectId: "100", value: 3, occurredAt: new Date("2025-11-28T00:00:00Z") });
      expect((await reportPendingUsage(ctx)).late).toBe(1);
    });

    test("each attempt has its own idempotency key; the identifier stays the source id", async () => {
      // Stripe replays a key's saved result, including a 500, so reusing one key
      // would turn a single 500 into a permanent failure.
      await enqueueUsage(ctx, { sourceId: "run_1", subjectId: "100", value: 3, occurredAt: NOW });
      fake.failNext((r) => r.path === "/v1/billing/meter_events", 500);
      await reportPendingUsage(ctx);
      await reportPendingUsage(ctx);
      expect(meterCalls().map((c) => c.idempotencyKey)).toEqual([
        "context-kit-billing:meter:run_1:1",
        "context-kit-billing:meter:run_1:2",
      ]);
      expect(meterCalls().map((c) => c.params.identifier)).toEqual(["run_1", "run_1"]);
    });

    test("usage written before the subscription has synced waits instead of failing", async () => {
      await ctx.db.delete(billingSubscription);
      await enqueueUsage(ctx, { sourceId: "run_early", subjectId: "100", value: 3, occurredAt: NOW });
      expect((await reportPendingUsage(ctx)).retry).toBe(1);
      expect(await rowFor("run_early")).toMatchObject({ status: "pending", lastError: "no_subscription" });
      expect(meterCalls()).toHaveLength(0);

      await ctx.db.insert(billingSubscription).values({
        stripeSubscriptionId: "sub_100",
        subjectId: "100",
        stripeCustomerId: "cus_100",
        status: "active",
        planKey: "pro",
        overagePriceId: "price_over",
        currentPeriodStart: PERIOD_START,
        currentPeriodEnd: new Date("2026-02-01T00:00:00Z"),
        livemode: false,
        syncedAt: NOW,
      });
      expect((await reportPendingUsage(ctx)).sent).toBe(1);
    });

    test("usage after a canceled subscription's last period is not sent", async () => {
      await ctx.db
        .update(billingSubscription)
        .set({ status: "canceled", currentPeriodStart: new Date("2025-12-01T00:00:00Z"), currentPeriodEnd: PERIOD_START });
      await enqueueUsage(ctx, { sourceId: "run_after", subjectId: "100", value: 3, occurredAt: new Date("2026-01-05T00:00:00Z") });
      expect((await reportPendingUsage(ctx)).failed).toBe(1);
      expect(await rowFor("run_after")).toMatchObject({ status: "failed", lastError: "no_active_subscription" });
      expect(meterCalls()).toHaveLength(0);
    });

    test("usage from a canceled subscription's last period is still sent inside the final invoice's grace window", async () => {
      clock = new Date("2026-01-01T00:20:00Z");
      await ctx.db
        .update(billingSubscription)
        .set({ status: "canceled", currentPeriodStart: new Date("2025-12-01T00:00:00Z"), currentPeriodEnd: PERIOD_START });
      await enqueueUsage(ctx, { sourceId: "run_last", subjectId: "100", value: 3, occurredAt: new Date("2025-12-31T23:50:00Z") });
      expect((await reportPendingUsage(ctx)).sent).toBe(1);
    });

    test("a subscription without the overage price is not sent to", async () => {
      await ctx.db.update(billingSubscription).set({ overagePriceId: null });
      await enqueueUsage(ctx, { sourceId: "run_np", subjectId: "100", value: 3, occurredAt: NOW });
      expect((await reportPendingUsage(ctx)).failed).toBe(1);
      expect((await rowFor("run_np"))?.lastError).toBe("no_overage_price");
    });

    test("respects the batch limit", async () => {
      for (let i = 0; i < 5; i++) {
        await enqueueUsage(ctx, { sourceId: `run_${i}`, subjectId: "100", value: 1, occurredAt: NOW });
      }
      expect((await reportPendingUsage(ctx, { limit: 2 })).sent).toBe(2);
      expect((await reportPendingUsage(ctx, { limit: 10 })).sent).toBe(3);
    });
  });
});
