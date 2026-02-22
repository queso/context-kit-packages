import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { InvalidConfigError } from "../types";

// Mock the stripe module before importing createBilling
mock.module("stripe", () => {
  return {
    default: class MockStripe {
      constructor(public _key: string) {}
    },
  };
});

// Import after mocking so the mock is in place
const { createBilling } = await import("../create-billing");

const MOCK_PRISMA = {} as unknown;

const VALID_PLAN = {
  id: "pro",
  name: "Pro",
  stripePriceId: "price_pro_monthly",
};

const FREE_PLAN = {
  id: "free",
  name: "Free",
  isFree: true,
};

describe("createBilling", () => {
  let originalStripeKey: string | undefined;
  let originalWebhookSecret: string | undefined;

  beforeEach(() => {
    originalStripeKey = process.env.STRIPE_SECRET_KEY;
    originalWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    process.env.STRIPE_SECRET_KEY = "sk_test_env_key";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_env_secret";
  });

  afterEach(() => {
    if (originalStripeKey === undefined) {
      delete process.env.STRIPE_SECRET_KEY;
    } else {
      process.env.STRIPE_SECRET_KEY = originalStripeKey;
    }
    if (originalWebhookSecret === undefined) {
      delete process.env.STRIPE_WEBHOOK_SECRET;
    } else {
      process.env.STRIPE_WEBHOOK_SECRET = originalWebhookSecret;
    }
  });

  test("happy path: returns BillingInstance with all methods", () => {
    const billing = createBilling({
      prisma: MOCK_PRISMA,
      stripeSecretKey: "sk_test_123",
      stripeWebhookSecret: "whsec_abc",
      plans: [VALID_PLAN],
    });

    const expectedMethods = [
      "getSubscription",
      "getPlan",
      "checkUsage",
      "recordUsage",
      "createCheckoutSession",
      "changePlan",
      "cancelSubscription",
      "reactivateSubscription",
    ];

    for (const method of expectedMethods) {
      expect(typeof billing[method as keyof typeof billing]).toBe("function");
    }
  });

  test("missing prisma throws InvalidConfigError", () => {
    expect(() =>
      createBilling({
        prisma: undefined as unknown,
        stripeSecretKey: "sk_test_123",
        stripeWebhookSecret: "whsec_abc",
        plans: [VALID_PLAN],
      })
    ).toThrow(InvalidConfigError);
  });

  test("missing Stripe key (no config, no env) throws InvalidConfigError", () => {
    delete process.env.STRIPE_SECRET_KEY;

    expect(() =>
      createBilling({
        prisma: MOCK_PRISMA,
        stripeWebhookSecret: "whsec_abc",
        plans: [VALID_PLAN],
      })
    ).toThrow(InvalidConfigError);
  });

  test("invalid plan (missing id) throws InvalidConfigError", () => {
    expect(() =>
      createBilling({
        prisma: MOCK_PRISMA,
        stripeSecretKey: "sk_test_123",
        stripeWebhookSecret: "whsec_abc",
        plans: [{ id: "", name: "Pro", stripePriceId: "price_123" }],
      })
    ).toThrow(InvalidConfigError);
  });

  test("free tier config creates synthetic free plan accessible via getPlan", () => {
    const billing = createBilling({
      prisma: MOCK_PRISMA,
      stripeSecretKey: "sk_test_123",
      stripeWebhookSecret: "whsec_abc",
      plans: [VALID_PLAN],
      freeTier: {
        planId: "free",
        name: "Free",
      },
    });

    const freePlan = billing.getPlan("free");
    expect(freePlan).toBeDefined();
    expect(freePlan.id).toBe("free");
    expect(freePlan.isFree).toBe(true);
  });
});
