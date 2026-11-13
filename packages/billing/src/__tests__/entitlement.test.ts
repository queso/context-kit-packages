import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { getEntitlement, resolveEntitlement, type SubscriptionRow } from "../entitlement";
import { billingSubscription } from "../schema/postgres";
import { createTestDb } from "./helpers/db";
import { FakeStripe } from "./helpers/fake-stripe";
import { testConfig } from "./helpers/config";
import type { BillingContext } from "../types";

const NOW = new Date("2026-01-20T00:00:00Z");
const DAY = 86_400_000;

function row(overrides: Partial<SubscriptionRow>): SubscriptionRow {
  return {
    stripeSubscriptionId: "sub_1",
    subjectId: "1",
    stripeCustomerId: "cus_1",
    status: "active",
    planKey: "pro",
    basePriceId: "price_pro",
    overagePriceId: "price_over",
    billingInterval: "month",
    billingIntervalCount: 1,
    currentPeriodStart: new Date("2026-01-01T00:00:00Z"),
    currentPeriodEnd: new Date("2026-02-01T00:00:00Z"),
    cancelAt: null,
    trialEnd: null,
    pastDueSince: null,
    livemode: false,
    syncedAt: NOW,
    ...overrides,
  };
}

describe("resolveEntitlement", () => {
  test("a subject with no subscription is on the free plan", () => {
    expect(resolveEntitlement(testConfig, "1", [], NOW)).toEqual({
      subjectId: "1",
      plan: "free",
      includedUnits: 50,
      paid: false,
      reason: "no_subscription",
      subscription: null,
    });
  });

  test.each(["active", "trialing"])("%s gives the paid plan", (status) => {
    const e = resolveEntitlement(testConfig, "1", [row({ status })], NOW);
    expect(e).toMatchObject({ plan: "pro", includedUnits: 250, paid: true, reason: "subscription" });
    expect(e.subscription).toMatchObject({
      id: "sub_1",
      status,
      currentPeriodStart: new Date("2026-01-01T00:00:00Z"),
      currentPeriodEnd: new Date("2026-02-01T00:00:00Z"),
    });
  });

  test("past_due keeps the paid plan inside the grace period and says when it ends", () => {
    const since = new Date(NOW.getTime() - 3 * DAY);
    const e = resolveEntitlement(testConfig, "1", [row({ status: "past_due", pastDueSince: since })], NOW);
    expect(e).toMatchObject({ plan: "pro", paid: true, reason: "grace" });
    expect(e.subscription?.graceEndsAt).toEqual(new Date(since.getTime() + 7 * DAY));
  });

  test("past_due drops to the free plan once the grace period has passed", () => {
    const since = new Date(NOW.getTime() - 7 * DAY);
    const e = resolveEntitlement(testConfig, "1", [row({ status: "past_due", pastDueSince: since })], NOW);
    expect(e).toMatchObject({ plan: "free", includedUnits: 50, paid: false, reason: "grace_expired" });
    expect(e.subscription?.status).toBe("past_due");
  });

  test("past_due with no recorded start uses syncedAt as the grace start", () => {
    const syncedAt = new Date(NOW.getTime() - 2 * DAY);
    const e = resolveEntitlement(testConfig, "1", [row({ status: "past_due", pastDueSince: null, syncedAt })], NOW);
    expect(e).toMatchObject({ plan: "pro", reason: "grace" });
    expect(e.subscription?.graceEndsAt).toEqual(new Date(syncedAt.getTime() + 7 * DAY));
  });

  test("past_due with no recorded start expires when syncedAt is older than the grace period", () => {
    const syncedAt = new Date(NOW.getTime() - 8 * DAY);
    const e = resolveEntitlement(testConfig, "1", [row({ status: "past_due", pastDueSince: null, syncedAt })], NOW);
    expect(e).toMatchObject({ plan: "free", paid: false, reason: "grace_expired" });
    expect(e.subscription?.graceEndsAt).not.toBeNull();
  });

  test.each(["unpaid", "canceled", "incomplete", "incomplete_expired", "paused"])(
    "%s is on the free plan",
    (status) => {
      const e = resolveEntitlement(testConfig, "1", [row({ status })], NOW);
      expect(e).toMatchObject({ plan: "free", paid: false, reason: "inactive" });
      expect(e.subscription?.status).toBe(status);
    }
  );

  test("an active subscription on an unknown price gives the free plan", () => {
    const e = resolveEntitlement(testConfig, "1", [row({ planKey: null })], NOW);
    expect(e).toMatchObject({ plan: "free", paid: false, reason: "unknown_plan" });
  });

  test("a plan key no longer in the config gives the free plan", () => {
    const e = resolveEntitlement(testConfig, "1", [row({ planKey: "retired" })], NOW);
    expect(e).toMatchObject({ plan: "free", reason: "unknown_plan" });
  });

  test("with several subscriptions, the one with the largest allowance wins", () => {
    const e = resolveEntitlement(
      testConfig,
      "1",
      [
        row({ stripeSubscriptionId: "sub_old", status: "canceled", planKey: "fleet" }),
        row({ stripeSubscriptionId: "sub_pro", status: "active", planKey: "pro" }),
        row({ stripeSubscriptionId: "sub_team", status: "active", planKey: "team" }),
      ],
      NOW
    );
    expect(e).toMatchObject({ plan: "team", includedUnits: 750 });
    expect(e.subscription?.id).toBe("sub_team");
  });

  test("a grace period of 0 drops past_due immediately", () => {
    const e = resolveEntitlement(
      { ...testConfig, gracePeriodDays: 0 },
      "1",
      [row({ status: "past_due", pastDueSince: new Date(NOW.getTime() - 1) })],
      NOW
    );
    expect(e.reason).toBe("grace_expired");
  });
});

describe("getEntitlement", () => {
  let ctx: BillingContext;
  let fake: FakeStripe;
  let close: () => Promise<void>;
  beforeEach(async () => {
    const t = await createTestDb();
    close = t.close;
    fake = new FakeStripe();
    ctx = { db: t.db, stripe: fake.client(), config: testConfig, now: () => NOW };
  });
  afterEach(() => close());

  test("reads the subject's stored subscriptions and never calls Stripe", async () => {
    await ctx.db.insert(billingSubscription).values([
      row({ subjectId: "55", stripeSubscriptionId: "sub_55", planKey: "fleet" }),
      row({ subjectId: "66", stripeSubscriptionId: "sub_66", planKey: "team" }),
    ]);
    const e = await getEntitlement(ctx, "55");
    expect(e).toMatchObject({ subjectId: "55", plan: "fleet", includedUnits: 2000, paid: true });
    expect(fake.requests).toHaveLength(0);
  });

  test("a subject with no rows is free", async () => {
    expect((await getEntitlement(ctx, "nobody")).plan).toBe("free");
  });
});
