import { describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Mock stripe before any imports that pull it in
mock.module("stripe", () => {
  return {
    default: class MockStripe {
      constructor(public _key: string) {}
    },
  };
});

// biome-ignore lint/suspicious/noExplicitAny: structural duck-typing for Prisma client
const MOCK_PRISMA = {} as any;

const VALID_PLAN = {
  id: "pro",
  name: "Pro",
  stripePriceId: "price_pro_monthly",
};

const PACKAGE_ROOT = resolve(import.meta.dir, "../..");

// ─── BillingInstance method wiring ────────────────────────────────────────────

describe("createBilling instance method wiring", () => {
  test("getSubscription delegates to subscription module (not a stub)", async () => {
    const { createBilling } = await import("../create-billing");
    const billing = createBilling({
      // biome-ignore lint/suspicious/noExplicitAny: mock for testing
      prisma: MOCK_PRISMA as any,
      stripeSecretKey: "sk_test_123",
      stripeWebhookSecret: "whsec_abc",
      plans: [VALID_PLAN],
    });

    // Should reject with a domain error (no customer found), NOT a "Not implemented" stub error
    await expect(billing.getSubscription("user-1")).rejects.toThrow();
    const err = await billing.getSubscription("user-1").catch((e) => e);
    expect(err.message).not.toBe("Not implemented: getSubscription");
  });

  test("checkUsage delegates to usage module (not a stub)", async () => {
    const { createBilling } = await import("../create-billing");
    const billing = createBilling({
      // biome-ignore lint/suspicious/noExplicitAny: mock for testing
      prisma: MOCK_PRISMA as any,
      stripeSecretKey: "sk_test_123",
      stripeWebhookSecret: "whsec_abc",
      plans: [VALID_PLAN],
    });

    await expect(billing.checkUsage("user-1", "api_calls")).rejects.toThrow();
    const err = await billing.checkUsage("user-1", "api_calls").catch((e) => e);
    expect(err.message).not.toBe("Not implemented: checkUsage");
  });

  test("recordUsage delegates to usage module (not a stub)", async () => {
    const { createBilling } = await import("../create-billing");
    const billing = createBilling({
      // biome-ignore lint/suspicious/noExplicitAny: mock for testing
      prisma: MOCK_PRISMA as any,
      stripeSecretKey: "sk_test_123",
      stripeWebhookSecret: "whsec_abc",
      plans: [VALID_PLAN],
    });

    await expect(billing.recordUsage("user-1", "api_calls", 1)).rejects.toThrow();
    const err = await billing.recordUsage("user-1", "api_calls", 1).catch((e) => e);
    expect(err.message).not.toBe("Not implemented: recordUsage");
  });

  test("createCheckoutSession delegates to checkout module (not a stub)", async () => {
    const { createBilling } = await import("../create-billing");
    const billing = createBilling({
      // biome-ignore lint/suspicious/noExplicitAny: mock for testing
      prisma: MOCK_PRISMA as any,
      stripeSecretKey: "sk_test_123",
      stripeWebhookSecret: "whsec_abc",
      plans: [VALID_PLAN],
    });

    await expect(
      billing.createCheckoutSession({
        userId: "user-1",
        planId: "pro",
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      })
    ).rejects.toThrow();
    const err = await billing
      .createCheckoutSession({
        userId: "user-1",
        planId: "pro",
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      })
      .catch((e) => e);
    expect(err.message).not.toBe("Not implemented: createCheckoutSession");
  });

  test("changePlan delegates to manage module (not a stub)", async () => {
    const { createBilling } = await import("../create-billing");
    const billing = createBilling({
      // biome-ignore lint/suspicious/noExplicitAny: mock for testing
      prisma: MOCK_PRISMA as any,
      stripeSecretKey: "sk_test_123",
      stripeWebhookSecret: "whsec_abc",
      plans: [VALID_PLAN],
    });

    await expect(billing.changePlan("user-1", { planId: "pro" })).rejects.toThrow();
    const err = await billing.changePlan("user-1", { planId: "pro" }).catch((e) => e);
    expect(err.message).not.toBe("Not implemented: changePlan");
  });

  test("cancelSubscription delegates to manage module (not a stub)", async () => {
    const { createBilling } = await import("../create-billing");
    const billing = createBilling({
      // biome-ignore lint/suspicious/noExplicitAny: mock for testing
      prisma: MOCK_PRISMA as any,
      stripeSecretKey: "sk_test_123",
      stripeWebhookSecret: "whsec_abc",
      plans: [VALID_PLAN],
    });

    await expect(billing.cancelSubscription("user-1")).rejects.toThrow();
    const err = await billing.cancelSubscription("user-1").catch((e) => e);
    expect(err.message).not.toBe("Not implemented: cancelSubscription");
  });

  test("reactivateSubscription delegates to manage module (not a stub)", async () => {
    const { createBilling } = await import("../create-billing");
    const billing = createBilling({
      // biome-ignore lint/suspicious/noExplicitAny: mock for testing
      prisma: MOCK_PRISMA as any,
      stripeSecretKey: "sk_test_123",
      stripeWebhookSecret: "whsec_abc",
      plans: [VALID_PLAN],
    });

    await expect(billing.reactivateSubscription("user-1")).rejects.toThrow();
    const err = await billing.reactivateSubscription("user-1").catch((e) => e);
    expect(err.message).not.toBe("Not implemented: reactivateSubscription");
  });
});

// ─── Barrel exports from index.ts ─────────────────────────────────────────────

describe("barrel exports from index.ts", () => {
  test("createBilling is exported as a function", async () => {
    const mod = await import("../index");
    expect(typeof mod.createBilling).toBe("function");
  });

  test("toWebhookHandler is exported as a function", async () => {
    const mod = await import("../index");
    expect(typeof mod.toWebhookHandler).toBe("function");
  });

  test("BillingError class is exported and constructable", async () => {
    const { BillingError } = await import("../index");
    const err = new BillingError("test");
    expect(err).toBeInstanceOf(BillingError);
    expect(err.name).toBe("BillingError");
  });

  test("UsageCapExceededError class is exported and constructable", async () => {
    const { UsageCapExceededError } = await import("../index");
    const err = new UsageCapExceededError("over limit", { used: 10, limit: 5 });
    expect(err).toBeInstanceOf(UsageCapExceededError);
    expect(err.name).toBe("UsageCapExceededError");
    expect(err.used).toBe(10);
    expect(err.limit).toBe(5);
  });

  test("InvalidConfigError class is exported and constructable", async () => {
    const { InvalidConfigError } = await import("../index");
    const err = new InvalidConfigError("bad config");
    expect(err).toBeInstanceOf(InvalidConfigError);
    expect(err.name).toBe("InvalidConfigError");
  });

  test("WebhookVerificationError class is exported and constructable", async () => {
    const { WebhookVerificationError } = await import("../index");
    const err = new WebhookVerificationError("bad sig");
    expect(err).toBeInstanceOf(WebhookVerificationError);
    expect(err.name).toBe("WebhookVerificationError");
  });

  test("SubscriptionStateError class is exported and constructable", async () => {
    const { SubscriptionStateError } = await import("../index");
    const err = new SubscriptionStateError("bad state");
    expect(err).toBeInstanceOf(SubscriptionStateError);
    expect(err.name).toBe("SubscriptionStateError");
  });

  test("all error classes inherit from BillingError", async () => {
    const {
      BillingError,
      UsageCapExceededError,
      InvalidConfigError,
      WebhookVerificationError,
      SubscriptionStateError,
    } = await import("../index");

    expect(new UsageCapExceededError("x", { used: 1, limit: 0 })).toBeInstanceOf(BillingError);
    expect(new InvalidConfigError("x")).toBeInstanceOf(BillingError);
    expect(new WebhookVerificationError("x")).toBeInstanceOf(BillingError);
    expect(new SubscriptionStateError("x")).toBeInstanceOf(BillingError);
  });

  test("types can be imported without error (module resolves)", async () => {
    // If this import succeeds, all types defined in index are accessible at runtime
    const mod = await import("../index");
    expect(mod).toBeDefined();
  });
});

// ─── Build output files exist ─────────────────────────────────────────────────

describe("build output files", () => {
  test("dist/index.js and dist/index.d.ts exist after build", () => {
    const distDir = resolve(PACKAGE_ROOT, "dist");
    expect(existsSync(resolve(distDir, "index.js"))).toBe(true);
    expect(existsSync(resolve(distDir, "index.d.ts"))).toBe(true);
  });

  test("dist/webhook.js and dist/webhook.d.ts exist after build", () => {
    const distDir = resolve(PACKAGE_ROOT, "dist");
    expect(existsSync(resolve(distDir, "webhook.js"))).toBe(true);
    expect(existsSync(resolve(distDir, "webhook.d.ts"))).toBe(true);
  });

  test("dist/cli.js and dist/cli.d.ts exist after build", () => {
    const distDir = resolve(PACKAGE_ROOT, "dist");
    expect(existsSync(resolve(distDir, "cli.js"))).toBe(true);
    expect(existsSync(resolve(distDir, "cli.d.ts"))).toBe(true);
  });
});
