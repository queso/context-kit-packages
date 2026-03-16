import { describe, expect, test } from "bun:test";
import type { PrismaCustomer, PrismaSubscription } from "../prisma";
import type { FreeTierConfig, PlanDefinition } from "../types";
import { BillingError } from "../types";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const USER_ID = "user_abc123";
const CUSTOMER_ID = "local_cust_1";
const STRIPE_CUSTOMER_ID = "cus_stripe123";

const PRO_PLAN: PlanDefinition = {
  id: "pro",
  name: "Pro",
  stripePriceId: "price_pro_monthly",
};

const FREE_PLAN: PlanDefinition = {
  id: "free",
  name: "Free",
  isFree: true,
  usageCaps: { messages: 100 },
};

const FREE_TIER_CONFIG: FreeTierConfig = {
  planId: "free",
  name: "Free",
  usageCaps: { messages: 100 },
};

const MOCK_CUSTOMER: PrismaCustomer = {
  id: CUSTOMER_ID,
  userId: USER_ID,
  stripeCustomerId: STRIPE_CUSTOMER_ID,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
};

const PERIOD_START = new Date("2024-06-01T00:00:00.000Z");
const PERIOD_END = new Date("2024-07-01T00:00:00.000Z");

const ACTIVE_SUBSCRIPTION: PrismaSubscription = {
  id: "sub_local_1",
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

const CANCELED_SUBSCRIPTION: PrismaSubscription = {
  ...ACTIVE_SUBSCRIPTION,
  id: "sub_local_canceled",
  status: "canceled",
};

// ─── Mock factories ───────────────────────────────────────────────────────────

function makePlansMap(
  plans: PlanDefinition[] = [PRO_PLAN]
): Map<string, PlanDefinition> {
  const map = new Map<string, PlanDefinition>();
  for (const plan of plans) {
    map.set(plan.id, plan);
  }
  return map;
}

// biome-ignore lint/suspicious/noExplicitAny: test mock
function makeMockPrisma(overrides?: {
  customerFindUnique?: (args: any) => Promise<PrismaCustomer | null>;
  subscriptionFindMany?: (args: any) => Promise<PrismaSubscription[]>;
}): any {
  return {
    customer: {
      findUnique:
        overrides?.customerFindUnique ??
        ((_args: any) => Promise.resolve(null)),
    },
    subscription: {
      findMany:
        overrides?.subscriptionFindMany ??
        ((_args: any) => Promise.resolve([])),
    },
  };
}

// ─── Import target ────────────────────────────────────────────────────────────

// @ts-expect-error: module created by B.A. during implementation phase
const { getSubscription, getPlan } = await import("../subscription");

// ─── getSubscription ──────────────────────────────────────────────────────────

describe("getSubscription", () => {
  test("returns SubscriptionData enriched with PlanDefinition for an active subscription", async () => {
    const prisma = makeMockPrisma({
      customerFindUnique: (_args: any) => Promise.resolve(MOCK_CUSTOMER),
      subscriptionFindMany: (_args: any) =>
        Promise.resolve([ACTIVE_SUBSCRIPTION]),
    });
    const plans = makePlansMap();

    const result = await getSubscription(USER_ID, { prisma, plans });

    expect(result).not.toBeNull();
    expect(result?.id).toBe(ACTIVE_SUBSCRIPTION.id);
    expect(result?.customerId).toBe(CUSTOMER_ID);
    expect(result?.stripeSubscriptionId).toBe("sub_stripe_1");
    expect(result?.stripePriceId).toBe("price_pro_monthly");
    expect(result?.planId).toBe("pro");
    expect(result?.plan).toEqual(PRO_PLAN);
    expect(result?.status).toBe("active");
    expect(result?.interval).toBe("monthly");
    expect(result?.currentPeriodStart).toEqual(PERIOD_START);
    expect(result?.currentPeriodEnd).toEqual(PERIOD_END);
    expect(result?.cancelAtPeriodEnd).toBe(false);
  });

  test("returns null when customer has only a canceled subscription", async () => {
    const prisma = makeMockPrisma({
      customerFindUnique: (_args: any) => Promise.resolve(MOCK_CUSTOMER),
      // findMany with active status filter returns empty (canceled excluded by query)
      subscriptionFindMany: (_args: any) => Promise.resolve([]),
    });
    const plans = makePlansMap();

    const result = await getSubscription(USER_ID, { prisma, plans });

    expect(result).toBeNull();
  });

  test("returns null when user has no Customer record", async () => {
    const prisma = makeMockPrisma({
      customerFindUnique: (_args: any) => Promise.resolve(null),
    });
    const plans = makePlansMap();

    const result = await getSubscription(USER_ID, { prisma, plans });

    expect(result).toBeNull();
  });

  test("returns most recently created when multiple active subscriptions exist", async () => {
    const olderSub: PrismaSubscription = {
      ...ACTIVE_SUBSCRIPTION,
      id: "sub_local_old",
      stripeSubscriptionId: "sub_stripe_old",
      createdAt: new Date("2024-01-01"),
    };
    const newerSub: PrismaSubscription = {
      ...ACTIVE_SUBSCRIPTION,
      id: "sub_local_new",
      stripeSubscriptionId: "sub_stripe_new",
      createdAt: new Date("2024-06-01"),
    };

    const prisma = makeMockPrisma({
      customerFindUnique: (_args: any) => Promise.resolve(MOCK_CUSTOMER),
      // Return older first to confirm the implementation sorts, not relies on order
      subscriptionFindMany: (_args: any) =>
        Promise.resolve([olderSub, newerSub]),
    });
    const plans = makePlansMap();

    const result = await getSubscription(USER_ID, { prisma, plans });

    expect(result?.id).toBe("sub_local_new");
  });

  test("throws BillingError when active subscription has a planId not present in the plans Map", async () => {
    // The DB has a valid active subscription, but its planId ("unknown-plan") is not
    // registered in the plans Map. Silently returning null would hide data corruption;
    // the implementation should throw so the caller can surface the misconfiguration.
    const unknownPlanSub: PrismaSubscription = {
      ...ACTIVE_SUBSCRIPTION,
      id: "sub_unknown_plan",
      planId: "unknown-plan",
    };

    const prisma = makeMockPrisma({
      customerFindUnique: (_args: any) => Promise.resolve(MOCK_CUSTOMER),
      subscriptionFindMany: (_args: any) => Promise.resolve([unknownPlanSub]),
    });
    const plans = makePlansMap(); // only contains "pro", not "unknown-plan"

    await expect(
      getSubscription(USER_ID, { prisma, plans })
    ).rejects.toBeInstanceOf(BillingError);
  });

  test("queries subscriptions with active status filter", async () => {
    let capturedArgs: any = null;
    const prisma = makeMockPrisma({
      customerFindUnique: (_args: any) => Promise.resolve(MOCK_CUSTOMER),
      subscriptionFindMany: (args: any) => {
        capturedArgs = args;
        return Promise.resolve([ACTIVE_SUBSCRIPTION]);
      },
    });
    const plans = makePlansMap();

    await getSubscription(USER_ID, { prisma, plans });

    // The query should filter to active statuses only
    expect(capturedArgs).not.toBeNull();
    const statusFilter =
      capturedArgs?.where?.status?.in ?? capturedArgs?.where?.status;
    const activeStatuses = ["active", "trialing", "past_due"];
    for (const s of activeStatuses) {
      expect(statusFilter).toContain(s);
    }
  });
});

// ─── getPlan ──────────────────────────────────────────────────────────────────

describe("getPlan", () => {
  test("returns PlanDefinition for user with an active subscription", async () => {
    const prisma = makeMockPrisma({
      customerFindUnique: (_args: any) => Promise.resolve(MOCK_CUSTOMER),
      subscriptionFindMany: (_args: any) =>
        Promise.resolve([ACTIVE_SUBSCRIPTION]),
    });
    const plans = makePlansMap();

    const result = await getPlan(USER_ID, { prisma, plans });

    expect(result).toEqual(PRO_PLAN);
  });

  test("returns free plan with synthetic period boundaries when no subscription and freeTier configured", async () => {
    const prisma = makeMockPrisma({
      customerFindUnique: (_args: any) => Promise.resolve(MOCK_CUSTOMER),
      subscriptionFindMany: (_args: any) => Promise.resolve([]),
    });
    const plans = makePlansMap([PRO_PLAN, FREE_PLAN]);

    const result = await getPlan(USER_ID, {
      prisma,
      plans,
      freeTier: FREE_TIER_CONFIG,
    });

    expect(result).not.toBeNull();
    expect(result?.id).toBe("free");
    expect(result?.isFree).toBe(true);

    // Verify synthetic period boundaries: 1st of current month UTC to 1st of next month UTC
    const now = new Date();
    const expectedStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    );
    const expectedEnd = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
    );

    expect(result?.currentPeriodStart).toEqual(expectedStart);
    expect(result?.currentPeriodEnd).toEqual(expectedEnd);
  });

  test("returns null when no subscription and no freeTier configured", async () => {
    const prisma = makeMockPrisma({
      customerFindUnique: (_args: any) => Promise.resolve(null),
      subscriptionFindMany: (_args: any) => Promise.resolve([]),
    });
    const plans = makePlansMap();

    const result = await getPlan(USER_ID, { prisma, plans });

    expect(result).toBeNull();
  });

  test("returns null when no subscription and no Customer record exists (no freeTier)", async () => {
    const prisma = makeMockPrisma({
      customerFindUnique: (_args: any) => Promise.resolve(null),
    });
    const plans = makePlansMap();

    const result = await getPlan(USER_ID, { prisma, plans });

    expect(result).toBeNull();
  });
});
