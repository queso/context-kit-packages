import { describe, expect, mock, test } from "bun:test";
import type { PlanDefinition } from "../types";
import { BillingError } from "../types";
import type { PrismaCustomer } from "../prisma";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const USER_ID = "user_abc123";
const STRIPE_CUSTOMER_ID = "cus_stripe123";
const SUCCESS_URL = "https://example.com/success";
const CANCEL_URL = "https://example.com/cancel";
const STRIPE_SESSION_ID = "cs_test_session_1";
const STRIPE_SESSION_URL = "https://checkout.stripe.com/pay/cs_test_session_1";

const PRO_PLAN_SINGLE_PRICE: PlanDefinition = {
  id: "pro",
  name: "Pro",
  stripePriceId: "price_pro_monthly",
};

const PRO_PLAN_MULTI_PRICE: PlanDefinition = {
  id: "pro_multi",
  name: "Pro Multi",
  stripePriceIds: {
    monthly: "price_pro_monthly",
    yearly: "price_pro_yearly",
  },
};

const FREE_PLAN: PlanDefinition = {
  id: "free",
  name: "Free",
  isFree: true,
};

const MOCK_CUSTOMER: PrismaCustomer = {
  id: "local_cust_1",
  userId: USER_ID,
  stripeCustomerId: STRIPE_CUSTOMER_ID,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
};

// ─── Mock factories ───────────────────────────────────────────────────────────

function makePlansMap(plans: PlanDefinition[] = [PRO_PLAN_SINGLE_PRICE]): Map<string, PlanDefinition> {
  const map = new Map<string, PlanDefinition>();
  for (const plan of plans) {
    map.set(plan.id, plan);
  }
  return map;
}

// biome-ignore lint/suspicious/noExplicitAny: test mock
function makeMockPrisma(overrides?: {
  customerFindUnique?: ReturnType<typeof mock>;
  customerCreate?: ReturnType<typeof mock>;
}): any {
  return {
    customer: {
      findUnique: overrides?.customerFindUnique ?? mock(() => Promise.resolve(MOCK_CUSTOMER)),
      create: overrides?.customerCreate ?? mock(() => Promise.resolve(MOCK_CUSTOMER)),
    },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: test mock
function makeMockStripe(overrides?: {
  customersCreate?: ReturnType<typeof mock>;
  checkoutSessionsCreate?: ReturnType<typeof mock>;
}): any {
  return {
    customers: {
      create: overrides?.customersCreate ?? mock(() => Promise.resolve({ id: STRIPE_CUSTOMER_ID })),
    },
    checkout: {
      sessions: {
        create: overrides?.checkoutSessionsCreate ?? mock(() =>
          Promise.resolve({ id: STRIPE_SESSION_ID, url: STRIPE_SESSION_URL })
        ),
      },
    },
  };
}

// ─── Import target ────────────────────────────────────────────────────────────

// @ts-expect-error: module created by B.A. during implementation phase
const { createCheckoutSession } = await import("../checkout");

// ─── createCheckoutSession ────────────────────────────────────────────────────

describe("createCheckoutSession", () => {
  test("returns sessionId and url on successful creation", async () => {
    const prisma = makeMockPrisma();
    const stripe = makeMockStripe();
    const plans = makePlansMap();

    const result = await createCheckoutSession(
      { userId: USER_ID, planId: "pro", successUrl: SUCCESS_URL, cancelUrl: CANCEL_URL },
      { prisma, stripe, plans }
    );

    expect(result.sessionId).toBe(STRIPE_SESSION_ID);
    expect(result.url).toBe(STRIPE_SESSION_URL);
  });

  test("creates Stripe checkout session with correct parameters", async () => {
    const checkoutSessionsCreate = mock(() =>
      Promise.resolve({ id: STRIPE_SESSION_ID, url: STRIPE_SESSION_URL })
    );
    const prisma = makeMockPrisma();
    const stripe = makeMockStripe({ checkoutSessionsCreate });
    const plans = makePlansMap();

    await createCheckoutSession(
      { userId: USER_ID, planId: "pro", successUrl: SUCCESS_URL, cancelUrl: CANCEL_URL },
      { prisma, stripe, plans }
    );

    expect(checkoutSessionsCreate).toHaveBeenCalledTimes(1);
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const callArgs = (checkoutSessionsCreate.mock.calls as any[][])[0][0];
    expect(callArgs.customer).toBe(STRIPE_CUSTOMER_ID);
    expect(callArgs.mode).toBe("subscription");
    expect(callArgs.success_url).toBe(SUCCESS_URL);
    expect(callArgs.cancel_url).toBe(CANCEL_URL);
    expect(callArgs.line_items).toEqual([
      { price: "price_pro_monthly", quantity: 1 },
    ]);
    expect(callArgs.subscription_data?.metadata?.userId).toBe(USER_ID);
    expect(callArgs.subscription_data?.metadata?.planId).toBe("pro");
  });

  test("resolves price from stripePriceIds[interval] for multi-price plan", async () => {
    const checkoutSessionsCreate = mock(() =>
      Promise.resolve({ id: STRIPE_SESSION_ID, url: STRIPE_SESSION_URL })
    );
    const prisma = makeMockPrisma();
    const stripe = makeMockStripe({ checkoutSessionsCreate });
    const plans = makePlansMap([PRO_PLAN_MULTI_PRICE]);

    await createCheckoutSession(
      { userId: USER_ID, planId: "pro_multi", interval: "yearly", successUrl: SUCCESS_URL, cancelUrl: CANCEL_URL },
      { prisma, stripe, plans }
    );

    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const callArgs = (checkoutSessionsCreate.mock.calls as any[][])[0][0];
    expect(callArgs.line_items[0].price).toBe("price_pro_yearly");
  });

  test("calls getOrCreateCustomer to ensure Stripe customer exists", async () => {
    const customerFindUnique = mock(() => Promise.resolve(null));
    const customerCreate = mock(() => Promise.resolve(MOCK_CUSTOMER));
    const customersCreate = mock(() => Promise.resolve({ id: STRIPE_CUSTOMER_ID }));

    const prisma = makeMockPrisma({ customerFindUnique, customerCreate });
    const stripe = makeMockStripe({ customersCreate });
    const plans = makePlansMap();

    await createCheckoutSession(
      { userId: USER_ID, planId: "pro", successUrl: SUCCESS_URL, cancelUrl: CANCEL_URL },
      { prisma, stripe, plans }
    );

    // Customer didn't exist, so Stripe customer creation was triggered
    expect(customersCreate).toHaveBeenCalledWith({ metadata: { userId: USER_ID } });
  });

  test("throws BillingError when planId does not exist in plans map", async () => {
    const prisma = makeMockPrisma();
    const stripe = makeMockStripe();
    const plans = makePlansMap();

    await expect(
      createCheckoutSession(
        { userId: USER_ID, planId: "nonexistent", successUrl: SUCCESS_URL, cancelUrl: CANCEL_URL },
        { prisma, stripe, plans }
      )
    ).rejects.toBeInstanceOf(BillingError);
  });

  test("throws BillingError when plan is a free plan", async () => {
    const prisma = makeMockPrisma();
    const stripe = makeMockStripe();
    const plans = makePlansMap([FREE_PLAN]);

    await expect(
      createCheckoutSession(
        { userId: USER_ID, planId: "free", successUrl: SUCCESS_URL, cancelUrl: CANCEL_URL },
        { prisma, stripe, plans }
      )
    ).rejects.toThrow("Cannot checkout a free plan");
  });

  test("throws BillingError when plan has no price ID resolvable for the requested interval", async () => {
    const planWithoutYearly: PlanDefinition = {
      id: "basic",
      name: "Basic",
      stripePriceIds: { monthly: "price_basic_monthly" },
    };
    const prisma = makeMockPrisma();
    const stripe = makeMockStripe();
    const plans = makePlansMap([planWithoutYearly]);

    await expect(
      createCheckoutSession(
        { userId: USER_ID, planId: "basic", interval: "yearly", successUrl: SUCCESS_URL, cancelUrl: CANCEL_URL },
        { prisma, stripe, plans }
      )
    ).rejects.toBeInstanceOf(BillingError);
  });

  test("throws BillingError when plan has neither stripePriceId nor stripePriceIds", async () => {
    const brokenPlan: PlanDefinition = {
      id: "broken",
      name: "Broken",
    };
    const prisma = makeMockPrisma();
    const stripe = makeMockStripe();
    const plans = makePlansMap([brokenPlan]);

    await expect(
      createCheckoutSession(
        { userId: USER_ID, planId: "broken", successUrl: SUCCESS_URL, cancelUrl: CANCEL_URL },
        { prisma, stripe, plans }
      )
    ).rejects.toBeInstanceOf(BillingError);
  });

  test("uses stripePriceIds[interval] over stripePriceId when plan has both and interval is provided", async () => {
    // Bug: if resolvePriceId checks stripePriceId first, it returns "price_pro_fallback"
    // even when an interval is explicitly requested. stripePriceIds[interval] must take
    // precedence when an interval is provided.
    const planWithBoth: PlanDefinition = {
      id: "pro_both",
      name: "Pro Both",
      stripePriceId: "price_pro_fallback",
      stripePriceIds: {
        monthly: "price_pro_monthly",
        yearly: "price_pro_yearly",
      },
    };

    const checkoutSessionsCreate = mock(() =>
      Promise.resolve({ id: STRIPE_SESSION_ID, url: STRIPE_SESSION_URL })
    );
    const prisma = makeMockPrisma();
    const stripe = makeMockStripe({ checkoutSessionsCreate });
    const plans = makePlansMap([planWithBoth]);

    await createCheckoutSession(
      { userId: USER_ID, planId: "pro_both", interval: "yearly", successUrl: SUCCESS_URL, cancelUrl: CANCEL_URL },
      { prisma, stripe, plans }
    );

    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const callArgs = (checkoutSessionsCreate.mock.calls as any[][])[0][0];
    // Must use the yearly price from stripePriceIds, not the fallback stripePriceId
    expect(callArgs.line_items[0].price).toBe("price_pro_yearly");
    expect(callArgs.line_items[0].price).not.toBe("price_pro_fallback");
  });

  test("does not call Stripe checkout when plan validation fails", async () => {
    const checkoutSessionsCreate = mock(() =>
      Promise.resolve({ id: STRIPE_SESSION_ID, url: STRIPE_SESSION_URL })
    );
    const prisma = makeMockPrisma();
    const stripe = makeMockStripe({ checkoutSessionsCreate });
    const plans = makePlansMap();

    await expect(
      createCheckoutSession(
        { userId: USER_ID, planId: "nonexistent", successUrl: SUCCESS_URL, cancelUrl: CANCEL_URL },
        { prisma, stripe, plans }
      )
    ).rejects.toBeInstanceOf(BillingError);

    expect(checkoutSessionsCreate).not.toHaveBeenCalled();
  });
});
