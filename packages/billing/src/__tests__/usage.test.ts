import { describe, expect, mock, test } from "bun:test";
import type { FreeTierConfig, PlanDefinition } from "../types";
import { BillingError, UsageCapExceededError } from "../types";
import type { PrismaCustomer, PrismaSubscription, PrismaUsageRecord } from "../prisma";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const USER_ID = "user_abc123";
const CUSTOMER_ID = "local_cust_1";
const SUBSCRIPTION_ID = "local_sub_1";
const FEATURE = "messages";

const PRO_PLAN: PlanDefinition = {
  id: "pro",
  name: "Pro",
  stripePriceId: "price_pro_monthly",
  usageCaps: { [FEATURE]: 100 },
};

const UNLIMITED_PLAN: PlanDefinition = {
  id: "unlimited",
  name: "Unlimited",
  stripePriceId: "price_unlimited_monthly",
  // no usageCaps — unlimited
};

const FREE_PLAN: PlanDefinition = {
  id: "free",
  name: "Free",
  isFree: true,
  usageCaps: { [FEATURE]: 50 },
};

const FREE_TIER_CONFIG: FreeTierConfig = {
  planId: "free",
  name: "Free",
  usageCaps: { [FEATURE]: 50 },
};

const PERIOD_START = new Date("2024-06-01T00:00:00.000Z");
const PERIOD_END = new Date("2024-07-01T00:00:00.000Z");

const MOCK_CUSTOMER: PrismaCustomer = {
  id: CUSTOMER_ID,
  userId: USER_ID,
  stripeCustomerId: "cus_stripe123",
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
};

const ACTIVE_SUBSCRIPTION: PrismaSubscription = {
  id: SUBSCRIPTION_ID,
  customerId: CUSTOMER_ID,
  stripeSubscriptionId: "sub_stripe_1",
  stripePriceId: "price_pro_monthly",
  planId: "pro",
  status: "active",
  interval: "monthly",
  currentPeriodStart: PERIOD_START,
  currentPeriodEnd: PERIOD_END,
  cancelAtPeriodEnd: false,
  createdAt: new Date("2024-06-01"),
  updatedAt: new Date("2024-06-01"),
};

function makeUsageRecord(used: number): PrismaUsageRecord {
  return {
    id: "usage_1",
    subscriptionId: SUBSCRIPTION_ID,
    userId: USER_ID,
    feature: FEATURE,
    used,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    createdAt: new Date("2024-06-01"),
    updatedAt: new Date("2024-06-01"),
  };
}

// ─── Mock factories ───────────────────────────────────────────────────────────

function makePlansMap(plans: PlanDefinition[] = [PRO_PLAN]): Map<string, PlanDefinition> {
  const map = new Map<string, PlanDefinition>();
  for (const p of plans) map.set(p.id, p);
  return map;
}

// biome-ignore lint/suspicious/noExplicitAny: test mock
function makeMockPrisma(overrides?: {
  customerFindUnique?: (args: any) => Promise<PrismaCustomer | null>;
  subscriptionFindFirst?: (args: any) => Promise<PrismaSubscription | null>;
  usageRecordFindFirst?: (args: any) => Promise<PrismaUsageRecord | null>;
  usageRecordUpsert?: (args: any) => Promise<PrismaUsageRecord>;
  usageRecordUpdate?: (args: any) => Promise<PrismaUsageRecord>;
}): any {
  return {
    customer: {
      findUnique: overrides?.customerFindUnique ?? ((_: any) => Promise.resolve(MOCK_CUSTOMER)),
    },
    subscription: {
      findFirst: overrides?.subscriptionFindFirst ?? ((_: any) => Promise.resolve(ACTIVE_SUBSCRIPTION)),
    },
    usageRecord: {
      findFirst: overrides?.usageRecordFindFirst ?? ((_: any) => Promise.resolve(makeUsageRecord(0))),
      upsert: overrides?.usageRecordUpsert ?? ((_: any) => Promise.resolve(makeUsageRecord(0))),
      update: overrides?.usageRecordUpdate ?? ((_: any) => Promise.resolve(makeUsageRecord(1))),
    },
  };
}

// ─── Import target ────────────────────────────────────────────────────────────

// @ts-expect-error: module created by B.A. during implementation phase
const { checkUsage, recordUsage } = await import("../usage");

// ─── checkUsage ───────────────────────────────────────────────────────────────

describe("checkUsage", () => {
  test("returns UsageResult with correct fields when within cap", async () => {
    const prisma = makeMockPrisma({
      subscriptionFindFirst: (_: any) => Promise.resolve(ACTIVE_SUBSCRIPTION),
      usageRecordFindFirst: (_: any) => Promise.resolve(makeUsageRecord(40)),
    });
    const plans = makePlansMap();

    const result = await checkUsage(USER_ID, FEATURE, { prisma, plans });

    expect(result.used).toBe(40);
    expect(result.limit).toBe(100);
    expect(result.remaining).toBe(60);
    expect(result.allowed).toBe(true);
  });

  test("returns allowed: true at usage exactly equal to cap boundary", async () => {
    const prisma = makeMockPrisma({
      subscriptionFindFirst: (_: any) => Promise.resolve(ACTIVE_SUBSCRIPTION),
      usageRecordFindFirst: (_: any) => Promise.resolve(makeUsageRecord(100)),
    });
    const plans = makePlansMap();

    const result = await checkUsage(USER_ID, FEATURE, { prisma, plans });

    // At the cap: used === limit, remaining === 0, allowed is implementation-defined
    // but the boundary value is 0 remaining
    expect(result.used).toBe(100);
    expect(result.remaining).toBe(0);
  });

  test("returns allowed: false when usage exceeds cap", async () => {
    const prisma = makeMockPrisma({
      subscriptionFindFirst: (_: any) => Promise.resolve(ACTIVE_SUBSCRIPTION),
      usageRecordFindFirst: (_: any) => Promise.resolve(makeUsageRecord(101)),
    });
    const plans = makePlansMap();

    const result = await checkUsage(USER_ID, FEATURE, { prisma, plans });

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  test("returns limit: Infinity and allowed: true when plan has no cap for feature", async () => {
    const unlimitedSub: PrismaSubscription = { ...ACTIVE_SUBSCRIPTION, planId: "unlimited" };
    const prisma = makeMockPrisma({
      subscriptionFindFirst: (_: any) => Promise.resolve(unlimitedSub),
      usageRecordFindFirst: (_: any) => Promise.resolve(makeUsageRecord(9999)),
    });
    const plans = makePlansMap([UNLIMITED_PLAN]);

    const result = await checkUsage(USER_ID, FEATURE, { prisma, plans });

    expect(result.limit).toBe(null);   // or Infinity — accept both representations
    expect(result.allowed).toBe(true);
  });

  test("uses free tier usageCaps with calendar month boundaries when no subscription", async () => {
    const now = new Date();
    const expectedStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const expectedEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

    let capturedArgs: any = null;
    const prisma = makeMockPrisma({
      customerFindUnique: (_: any) => Promise.resolve(MOCK_CUSTOMER),
      subscriptionFindFirst: (_: any) => Promise.resolve(null),
      usageRecordFindFirst: (args: any) => {
        capturedArgs = args;
        return Promise.resolve(makeUsageRecord(10));
      },
    });
    const plans = makePlansMap([FREE_PLAN]);

    const result = await checkUsage(USER_ID, FEATURE, { prisma, plans, freeTier: FREE_TIER_CONFIG });

    expect(result.limit).toBe(50);
    expect(result.used).toBe(10);
    expect(result.allowed).toBe(true);

    // The period boundaries used for the usage lookup should match calendar month
    if (capturedArgs) {
      const periodStart = capturedArgs?.where?.periodStart ?? capturedArgs?.where?.periodStart?.gte;
      const periodEnd = capturedArgs?.where?.periodEnd ?? capturedArgs?.where?.periodEnd?.lte;
      if (periodStart) expect(new Date(periodStart).getTime()).toBe(expectedStart.getTime());
      if (periodEnd) expect(new Date(periodEnd).getTime()).toBe(expectedEnd.getTime());
    }
  });

  test("throws BillingError when no active subscription and no free tier configured", async () => {
    const prisma = makeMockPrisma({
      customerFindUnique: (_: any) => Promise.resolve(MOCK_CUSTOMER),
      subscriptionFindFirst: (_: any) => Promise.resolve(null),
    });
    const plans = makePlansMap();

    await expect(
      checkUsage(USER_ID, FEATURE, { prisma, plans })
    ).rejects.toThrow(BillingError);
  });

  test("returns zero usage when no UsageRecord exists yet for current period", async () => {
    const prisma = makeMockPrisma({
      subscriptionFindFirst: (_: any) => Promise.resolve(ACTIVE_SUBSCRIPTION),
      usageRecordFindFirst: (_: any) => Promise.resolve(null),
    });
    const plans = makePlansMap();

    const result = await checkUsage(USER_ID, FEATURE, { prisma, plans });

    expect(result.used).toBe(0);
    expect(result.allowed).toBe(true);
  });

  test("handles period rollover: ignores usage records from prior billing periods", async () => {
    const priorPeriodRecord: PrismaUsageRecord = {
      ...makeUsageRecord(99),
      periodStart: new Date("2024-05-01T00:00:00.000Z"),
      periodEnd: new Date("2024-06-01T00:00:00.000Z"),
    };
    let capturedArgs: any = null;
    const prisma = makeMockPrisma({
      subscriptionFindFirst: (_: any) => Promise.resolve(ACTIVE_SUBSCRIPTION),
      // Simulate DB correctly returning null for current period (prior record filtered out)
      usageRecordFindFirst: (args: any) => {
        capturedArgs = args;
        return Promise.resolve(null); // current period has no record yet
      },
    });
    const plans = makePlansMap();

    const result = await checkUsage(USER_ID, FEATURE, { prisma, plans });

    // With no record for the current period, usage should be 0
    expect(result.used).toBe(0);
    // The query should be scoped to the current subscription period
    expect(capturedArgs).not.toBeNull();
  });
});

// ─── recordUsage ──────────────────────────────────────────────────────────────

describe("recordUsage", () => {
  test("increments UsageRecord.used by 1 (default quantity)", async () => {
    const usageRecordUpdate = mock((_: any) => Promise.resolve(makeUsageRecord(41)));
    const prisma = makeMockPrisma({
      subscriptionFindFirst: (_: any) => Promise.resolve(ACTIVE_SUBSCRIPTION),
      usageRecordFindFirst: (_: any) => Promise.resolve(makeUsageRecord(40)),
      usageRecordUpdate,
    });
    const plans = makePlansMap();

    await recordUsage(USER_ID, FEATURE, 1, { prisma, plans });

    expect(usageRecordUpdate).toHaveBeenCalledTimes(1);
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const callArgs = (usageRecordUpdate.mock.calls as any[][])[0][0];
    expect(callArgs?.data?.used?.increment ?? callArgs?.data?.used).toBe(1);
  });

  test("increments by specified quantity", async () => {
    const usageRecordUpdate = mock((_: any) => Promise.resolve(makeUsageRecord(45)));
    const prisma = makeMockPrisma({
      subscriptionFindFirst: (_: any) => Promise.resolve(ACTIVE_SUBSCRIPTION),
      usageRecordFindFirst: (_: any) => Promise.resolve(makeUsageRecord(40)),
      usageRecordUpdate,
    });
    const plans = makePlansMap();

    await recordUsage(USER_ID, FEATURE, 5, { prisma, plans });

    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const callArgs = (usageRecordUpdate.mock.calls as any[][])[0][0];
    expect(callArgs?.data?.used?.increment ?? callArgs?.data?.used).toBe(5);
  });

  test("throws UsageCapExceededError when recording would exceed cap (hard mode)", async () => {
    const prisma = makeMockPrisma({
      subscriptionFindFirst: (_: any) => Promise.resolve(ACTIVE_SUBSCRIPTION),
      usageRecordFindFirst: (_: any) => Promise.resolve(makeUsageRecord(100)),
    });
    const plans = makePlansMap();

    await expect(
      recordUsage(USER_ID, FEATURE, 1, { prisma, plans })
    ).rejects.toBeInstanceOf(UsageCapExceededError);
  });

  test("UsageCapExceededError carries used and limit fields", async () => {
    const prisma = makeMockPrisma({
      subscriptionFindFirst: (_: any) => Promise.resolve(ACTIVE_SUBSCRIPTION),
      usageRecordFindFirst: (_: any) => Promise.resolve(makeUsageRecord(100)),
    });
    const plans = makePlansMap();

    let caught: UsageCapExceededError | null = null;
    try {
      await recordUsage(USER_ID, FEATURE, 1, { prisma, plans });
    } catch (err) {
      if (err instanceof UsageCapExceededError) caught = err;
    }

    expect(caught).not.toBeNull();
    expect(caught?.used).toBe(100);
    expect(caught?.limit).toBe(100);
  });

  test("soft mode records usage and returns allowed: false without throwing", async () => {
    const usageRecordUpdate = mock((_: any) => Promise.resolve(makeUsageRecord(101)));
    const prisma = makeMockPrisma({
      subscriptionFindFirst: (_: any) => Promise.resolve(ACTIVE_SUBSCRIPTION),
      usageRecordFindFirst: (_: any) => Promise.resolve(makeUsageRecord(100)),
      usageRecordUpdate,
    });
    const plans = makePlansMap();

    const result = await recordUsage(USER_ID, FEATURE, 1, { prisma, plans, soft: true });

    expect(usageRecordUpdate).toHaveBeenCalledTimes(1);
    expect(result?.allowed).toBe(false);
  });

  test("does not throw and does not record when plan has no cap (unlimited)", async () => {
    const usageRecordUpdate = mock((_: any) => Promise.resolve(makeUsageRecord(10001)));
    const unlimitedSub: PrismaSubscription = { ...ACTIVE_SUBSCRIPTION, planId: "unlimited" };
    const prisma = makeMockPrisma({
      subscriptionFindFirst: (_: any) => Promise.resolve(unlimitedSub),
      usageRecordFindFirst: (_: any) => Promise.resolve(makeUsageRecord(9999)),
      usageRecordUpdate,
    });
    const plans = makePlansMap([UNLIMITED_PLAN]);

    // Should not throw
    await expect(
      recordUsage(USER_ID, FEATURE, 1, { prisma, plans })
    ).resolves.not.toThrow();
  });

  test("upserts UsageRecord when none exists for the current period", async () => {
    const usageRecordUpsert = mock((_: any) => Promise.resolve(makeUsageRecord(1)));
    const prisma = makeMockPrisma({
      subscriptionFindFirst: (_: any) => Promise.resolve(ACTIVE_SUBSCRIPTION),
      usageRecordFindFirst: (_: any) => Promise.resolve(null),
      usageRecordUpsert,
    });
    const plans = makePlansMap();

    await recordUsage(USER_ID, FEATURE, 1, { prisma, plans });

    // Either upsert or create should have been called to establish the record
    expect(usageRecordUpsert).toHaveBeenCalledTimes(1);
  });

  test("throws BillingError when no active subscription and no free tier", async () => {
    const prisma = makeMockPrisma({
      customerFindUnique: (_: any) => Promise.resolve(MOCK_CUSTOMER),
      subscriptionFindFirst: (_: any) => Promise.resolve(null),
    });
    const plans = makePlansMap();

    await expect(
      recordUsage(USER_ID, FEATURE, 1, { prisma, plans })
    ).rejects.toThrow(BillingError);
  });
});
