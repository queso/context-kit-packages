import { describe, expect, mock, test } from "bun:test";
import type { PrismaCustomer, PrismaSubscription } from "../prisma";
import type { PlanDefinition } from "../types";
import { BillingError, SubscriptionStateError } from "../types";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const USER_ID = "user_abc123";
const CUSTOMER_ID = "local_cust_1";
const STRIPE_CUSTOMER_ID = "cus_stripe123";
const STRIPE_SUB_ID = "sub_stripe_1";

const PRO_PLAN: PlanDefinition = {
  id: "pro",
  name: "Pro",
  stripePriceId: "price_pro_monthly",
};

const ENTERPRISE_PLAN: PlanDefinition = {
  id: "enterprise",
  name: "Enterprise",
  stripePriceIds: {
    monthly: "price_enterprise_monthly",
    yearly: "price_enterprise_yearly",
  },
};

const FREE_PLAN: PlanDefinition = {
  id: "free",
  name: "Free",
  isFree: true,
};

const PERIOD_START = new Date("2024-06-01T00:00:00.000Z");
const PERIOD_END = new Date("2024-07-01T00:00:00.000Z");

const MOCK_CUSTOMER: PrismaCustomer = {
  id: CUSTOMER_ID,
  userId: USER_ID,
  stripeCustomerId: STRIPE_CUSTOMER_ID,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
};

const ACTIVE_SUBSCRIPTION: PrismaSubscription = {
  id: "local_sub_1",
  customerId: CUSTOMER_ID,
  stripeSubscriptionId: STRIPE_SUB_ID,
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

const PENDING_CANCEL_SUBSCRIPTION: PrismaSubscription = {
  ...ACTIVE_SUBSCRIPTION,
  cancelAtPeriodEnd: true,
};

const ALREADY_CANCELED_SUBSCRIPTION: PrismaSubscription = {
  ...ACTIVE_SUBSCRIPTION,
  status: "canceled",
  cancelAtPeriodEnd: false,
};

const PAST_DUE_SUBSCRIPTION: PrismaSubscription = {
  ...ACTIVE_SUBSCRIPTION,
  status: "past_due",
};

// ─── Mock factories ───────────────────────────────────────────────────────────

function makePlansMap(
  plans: PlanDefinition[] = [PRO_PLAN, ENTERPRISE_PLAN]
): Map<string, PlanDefinition> {
  const map = new Map<string, PlanDefinition>();
  for (const p of plans) map.set(p.id, p);
  return map;
}

// biome-ignore lint/suspicious/noExplicitAny: test mock
function makeMockPrisma(overrides?: {
  customerFindUnique?: (args: any) => Promise<PrismaCustomer | null>;
  subscriptionFindFirst?: (args: any) => Promise<PrismaSubscription | null>;
  subscriptionUpdate?: (args: any) => Promise<PrismaSubscription>;
}): any {
  return {
    customer: {
      findUnique:
        overrides?.customerFindUnique ??
        ((_: any) => Promise.resolve(MOCK_CUSTOMER)),
    },
    subscription: {
      findFirst:
        overrides?.subscriptionFindFirst ??
        ((_: any) => Promise.resolve(ACTIVE_SUBSCRIPTION)),
      update:
        overrides?.subscriptionUpdate ??
        ((_: any) => Promise.resolve(ACTIVE_SUBSCRIPTION)),
    },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: test mock
function makeMockStripe(overrides?: {
  subscriptionsUpdate?: ReturnType<typeof mock>;
  subscriptionsCancel?: ReturnType<typeof mock>;
}): any {
  return {
    subscriptions: {
      update:
        overrides?.subscriptionsUpdate ??
        mock((_id: string, _params: any) =>
          Promise.resolve({ id: STRIPE_SUB_ID, status: "active" })
        ),
      cancel:
        overrides?.subscriptionsCancel ??
        mock((_id: string) =>
          Promise.resolve({ id: STRIPE_SUB_ID, status: "canceled" })
        ),
    },
  };
}

// ─── Import target ────────────────────────────────────────────────────────────

// @ts-expect-error: module created by B.A. during implementation phase
const { changePlan, cancelSubscription, reactivateSubscription } = await import(
  "../manage"
);

// ─── changePlan ───────────────────────────────────────────────────────────────

describe("changePlan", () => {
  test("updates Stripe subscription and local record on successful plan change", async () => {
    const subscriptionsUpdate = mock((_id: string, _params: any) =>
      Promise.resolve({ id: STRIPE_SUB_ID, status: "active" })
    );
    const subscriptionUpdate = mock((_: any) =>
      Promise.resolve({
        ...ACTIVE_SUBSCRIPTION,
        planId: "enterprise",
        stripePriceId: "price_enterprise_monthly",
      })
    );

    const prisma = makeMockPrisma({ subscriptionUpdate });
    const stripe = makeMockStripe({ subscriptionsUpdate });
    const plans = makePlansMap();

    await changePlan(
      USER_ID,
      { planId: "enterprise", interval: "monthly" },
      { prisma, stripe, plans }
    );

    expect(subscriptionsUpdate).toHaveBeenCalledTimes(1);
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const [stripeSubId, stripeParams] = (
      subscriptionsUpdate.mock.calls as any[][]
    )[0];
    expect(stripeSubId).toBe(STRIPE_SUB_ID);
    expect(
      stripeParams?.items?.[0]?.price ?? stripeParams?.items?.[0]?.id
    ).toBe("price_enterprise_monthly");

    expect(subscriptionUpdate).toHaveBeenCalledTimes(1);
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const localArgs = (subscriptionUpdate.mock.calls as any[][])[0][0];
    expect(localArgs?.data?.planId).toBe("enterprise");
  });

  test("applies proration by default when changing plan", async () => {
    const subscriptionsUpdate = mock((_id: string, _params: any) =>
      Promise.resolve({ id: STRIPE_SUB_ID, status: "active" })
    );

    const prisma = makeMockPrisma();
    const stripe = makeMockStripe({ subscriptionsUpdate });
    const plans = makePlansMap();

    await changePlan(
      USER_ID,
      { planId: "enterprise", interval: "monthly" },
      { prisma, stripe, plans }
    );

    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const [, stripeParams] = (subscriptionsUpdate.mock.calls as any[][])[0];
    // proration_behavior should be set (create_prorations or always_invoice, not none)
    const proration = stripeParams?.proration_behavior;
    if (proration !== undefined) {
      expect(proration).not.toBe("none");
    }
  });

  test("throws SubscriptionStateError when user has no active subscription", async () => {
    const prisma = makeMockPrisma({
      subscriptionFindFirst: (_: any) => Promise.resolve(null),
    });
    const stripe = makeMockStripe();
    const plans = makePlansMap();

    await expect(
      changePlan(USER_ID, { planId: "enterprise" }, { prisma, stripe, plans })
    ).rejects.toBeInstanceOf(SubscriptionStateError);
  });

  test("throws SubscriptionStateError when subscription is past_due", async () => {
    const prisma = makeMockPrisma({
      subscriptionFindFirst: (_: any) => Promise.resolve(PAST_DUE_SUBSCRIPTION),
    });
    const stripe = makeMockStripe();
    const plans = makePlansMap();

    await expect(
      changePlan(USER_ID, { planId: "enterprise" }, { prisma, stripe, plans })
    ).rejects.toBeInstanceOf(SubscriptionStateError);
  });

  test("throws BillingError when target planId is not in plans Map", async () => {
    const prisma = makeMockPrisma();
    const stripe = makeMockStripe();
    const plans = makePlansMap();

    await expect(
      changePlan(USER_ID, { planId: "nonexistent" }, { prisma, stripe, plans })
    ).rejects.toBeInstanceOf(BillingError);
  });

  test("throws BillingError when target plan is free (cannot change to free via changePlan)", async () => {
    const prisma = makeMockPrisma();
    const stripe = makeMockStripe();
    const plans = makePlansMap([PRO_PLAN, FREE_PLAN]);

    await expect(
      changePlan(USER_ID, { planId: "free" }, { prisma, stripe, plans })
    ).rejects.toBeInstanceOf(BillingError);
  });
});

// ─── cancelSubscription ───────────────────────────────────────────────────────

describe("cancelSubscription", () => {
  test("sets cancel_at_period_end=true on Stripe and updates local record (default behavior)", async () => {
    const subscriptionsUpdate = mock((_id: string, _params: any) =>
      Promise.resolve({ id: STRIPE_SUB_ID, cancel_at_period_end: true })
    );
    const subscriptionUpdate = mock((_: any) =>
      Promise.resolve({ ...ACTIVE_SUBSCRIPTION, cancelAtPeriodEnd: true })
    );

    const prisma = makeMockPrisma({ subscriptionUpdate });
    const stripe = makeMockStripe({ subscriptionsUpdate });
    const plans = makePlansMap();

    await cancelSubscription(USER_ID, {}, { prisma, stripe, plans });

    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const [stripeSubId, stripeParams] = (
      subscriptionsUpdate.mock.calls as any[][]
    )[0];
    expect(stripeSubId).toBe(STRIPE_SUB_ID);
    expect(stripeParams?.cancel_at_period_end).toBe(true);

    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const localArgs = (subscriptionUpdate.mock.calls as any[][])[0][0];
    expect(localArgs?.data?.cancelAtPeriodEnd).toBe(true);
  });

  test("calls stripe.subscriptions.cancel and sets status=canceled when immediate=true", async () => {
    const subscriptionsCancel = mock((_id: string) =>
      Promise.resolve({ id: STRIPE_SUB_ID, status: "canceled" })
    );
    const subscriptionUpdate = mock((_: any) =>
      Promise.resolve({ ...ACTIVE_SUBSCRIPTION, status: "canceled" })
    );

    const prisma = makeMockPrisma({ subscriptionUpdate });
    const stripe = makeMockStripe({ subscriptionsCancel });
    const plans = makePlansMap();

    await cancelSubscription(
      USER_ID,
      { immediate: true },
      { prisma, stripe, plans }
    );

    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const [stripeSubId] = (subscriptionsCancel.mock.calls as any[][])[0];
    expect(stripeSubId).toBe(STRIPE_SUB_ID);

    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const localArgs = (subscriptionUpdate.mock.calls as any[][])[0][0];
    expect(localArgs?.data?.status).toBe("canceled");
  });

  test("is a no-op when subscription is already canceled and immediate is not set", async () => {
    const subscriptionsUpdate = mock((_id: string, _params: any) =>
      Promise.resolve({ id: STRIPE_SUB_ID })
    );
    const subscriptionsCancel = mock((_id: string) =>
      Promise.resolve({ id: STRIPE_SUB_ID, status: "canceled" })
    );

    const prisma = makeMockPrisma({
      subscriptionFindFirst: (_: any) =>
        Promise.resolve(ALREADY_CANCELED_SUBSCRIPTION),
    });
    const stripe = makeMockStripe({ subscriptionsUpdate, subscriptionsCancel });
    const plans = makePlansMap();

    await cancelSubscription(USER_ID, {}, { prisma, stripe, plans });

    expect(subscriptionsUpdate).not.toHaveBeenCalled();
    expect(subscriptionsCancel).not.toHaveBeenCalled();
  });

  test("throws SubscriptionStateError when no active subscription found", async () => {
    const prisma = makeMockPrisma({
      subscriptionFindFirst: (_: any) => Promise.resolve(null),
    });
    const stripe = makeMockStripe();
    const plans = makePlansMap();

    await expect(
      cancelSubscription(USER_ID, {}, { prisma, stripe, plans })
    ).rejects.toBeInstanceOf(SubscriptionStateError);
  });
});

// ─── reactivateSubscription ───────────────────────────────────────────────────

describe("reactivateSubscription", () => {
  test("clears cancel_at_period_end on Stripe and updates local record", async () => {
    const subscriptionsUpdate = mock((_id: string, _params: any) =>
      Promise.resolve({ id: STRIPE_SUB_ID, cancel_at_period_end: false })
    );
    const subscriptionUpdate = mock((_: any) =>
      Promise.resolve({
        ...PENDING_CANCEL_SUBSCRIPTION,
        cancelAtPeriodEnd: false,
      })
    );

    const prisma = makeMockPrisma({
      subscriptionFindFirst: (_: any) =>
        Promise.resolve(PENDING_CANCEL_SUBSCRIPTION),
      subscriptionUpdate,
    });
    const stripe = makeMockStripe({ subscriptionsUpdate });
    const plans = makePlansMap();

    await reactivateSubscription(USER_ID, { prisma, stripe, plans });

    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const [stripeSubId, stripeParams] = (
      subscriptionsUpdate.mock.calls as any[][]
    )[0];
    expect(stripeSubId).toBe(STRIPE_SUB_ID);
    expect(stripeParams?.cancel_at_period_end).toBe(false);

    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const localArgs = (subscriptionUpdate.mock.calls as any[][])[0][0];
    expect(localArgs?.data?.cancelAtPeriodEnd).toBe(false);
  });

  test("throws SubscriptionStateError when subscription is not in pending cancellation state", async () => {
    // Active subscription with cancelAtPeriodEnd=false has nothing to reactivate
    const prisma = makeMockPrisma({
      subscriptionFindFirst: (_: any) => Promise.resolve(ACTIVE_SUBSCRIPTION),
    });
    const stripe = makeMockStripe();
    const plans = makePlansMap();

    await expect(
      reactivateSubscription(USER_ID, { prisma, stripe, plans })
    ).rejects.toBeInstanceOf(SubscriptionStateError);
  });

  test("throws SubscriptionStateError when subscription is already fully canceled", async () => {
    const prisma = makeMockPrisma({
      subscriptionFindFirst: (_: any) =>
        Promise.resolve(ALREADY_CANCELED_SUBSCRIPTION),
    });
    const stripe = makeMockStripe();
    const plans = makePlansMap();

    await expect(
      reactivateSubscription(USER_ID, { prisma, stripe, plans })
    ).rejects.toBeInstanceOf(SubscriptionStateError);
  });

  test("throws SubscriptionStateError when no subscription found", async () => {
    const prisma = makeMockPrisma({
      subscriptionFindFirst: (_: any) => Promise.resolve(null),
    });
    const stripe = makeMockStripe();
    const plans = makePlansMap();

    await expect(
      reactivateSubscription(USER_ID, { prisma, stripe, plans })
    ).rejects.toBeInstanceOf(SubscriptionStateError);
  });
});
