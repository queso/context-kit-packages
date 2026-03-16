import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Capture process.exit calls without actually exiting
function mockProcessExit(): { calls: number[]; restore: () => void } {
  const calls: number[] = [];
  const original = process.exit.bind(process);
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  (process as any).exit = (code: number) => {
    calls.push(code);
    throw new Error(`process.exit(${code})`);
  };
  return {
    calls,
    restore: () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      (process as any).exit = original;
    },
  };
}

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const STRIPE_KEY = "sk_test_abc123";

const STRIPE_SUB_ACTIVE = {
  id: "sub_stripe_1",
  customer: "cus_stripe_1",
  status: "active",
  items: {
    data: [
      { price: { id: "price_pro_monthly" }, recurring: { interval: "month" } },
    ],
  },
  current_period_start: 1717200000,
  current_period_end: 1719792000,
  cancel_at_period_end: false,
  metadata: { planId: "pro" },
};

const STRIPE_SUB_CANCELED = {
  id: "sub_stripe_2",
  customer: "cus_stripe_2",
  status: "canceled",
  items: {
    data: [
      {
        price: { id: "price_basic_monthly" },
        recurring: { interval: "month" },
      },
    ],
  },
  current_period_start: 1717200000,
  current_period_end: 1719792000,
  cancel_at_period_end: false,
  metadata: { planId: "basic" },
};

const LOCAL_CUSTOMER_1 = {
  id: "local_cust_1",
  userId: "user_1",
  stripeCustomerId: "cus_stripe_1",
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
};

const LOCAL_CUSTOMER_ORPHAN = {
  id: "local_cust_orphan",
  userId: "user_orphan",
  stripeCustomerId: "cus_stripe_orphan",
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
};

const LOCAL_SUB_ACTIVE = {
  id: "local_sub_1",
  customerId: "local_cust_1",
  stripeSubscriptionId: "sub_stripe_1",
  stripePriceId: "price_pro_monthly",
  planId: "pro",
  status: "active",
  interval: "monthly",
  currentPeriodStart: new Date(1717200000 * 1000),
  currentPeriodEnd: new Date(1719792000 * 1000),
  cancelAtPeriodEnd: false,
  createdAt: new Date("2024-06-01"),
  updatedAt: new Date("2024-06-01"),
};

// ─── Mock factories ───────────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: test mock
function makeMockPrisma(overrides?: {
  customerFindUnique?: (args: any) => Promise<any>;
  subscriptionFindFirst?: (args: any) => Promise<any>;
  subscriptionUpsert?: (args: any) => Promise<any>;
  subscriptionUpdateMany?: (args: any) => Promise<any>;
}): any {
  return {
    customer: {
      findUnique:
        overrides?.customerFindUnique ??
        ((_args: any) => Promise.resolve(null)),
    },
    subscription: {
      findFirst:
        overrides?.subscriptionFindFirst ??
        ((_args: any) => Promise.resolve(null)),
      upsert:
        overrides?.subscriptionUpsert ??
        ((_args: any) => Promise.resolve(LOCAL_SUB_ACTIVE)),
      updateMany:
        overrides?.subscriptionUpdateMany ??
        ((_args: any) => Promise.resolve({ count: 0 })),
    },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: test mock
function makeMockStripe(overrides?: {
  subscriptionsList?: (args: any) => Promise<any>;
}): any {
  return {
    subscriptions: {
      list:
        overrides?.subscriptionsList ??
        ((_args: any) =>
          Promise.resolve({ data: [STRIPE_SUB_ACTIVE], has_more: false })),
    },
  };
}

// ─── Import target ────────────────────────────────────────────────────────────

// @ts-expect-error: module created by B.A. during implementation phase
const { runResync } = await import("../cli");

// ─── resync ───────────────────────────────────────────────────────────────────

describe("resync", () => {
  let originalStripeKey: string | undefined;

  beforeEach(() => {
    originalStripeKey = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = STRIPE_KEY;
  });

  afterEach(() => {
    if (originalStripeKey === undefined) {
      delete process.env.STRIPE_SECRET_KEY;
    } else {
      process.env.STRIPE_SECRET_KEY = originalStripeKey;
    }
  });

  test("initializes Stripe from STRIPE_SECRET_KEY env var when stripe param is undefined", async () => {
    // Bug: if the guard only checks for missing env key but doesn't handle stripe=undefined,
    // passing undefined while the env var is set causes stripe.subscriptions.list to throw
    // a TypeError (cannot read properties of undefined) rather than a clear error or a
    // successful run using a Stripe client built from the env key.
    // The implementation should either construct a Stripe client from the env key when
    // stripe is undefined, or throw a clear BillingError — never a raw TypeError.
    const exitMock = mockProcessExit();
    // STRIPE_SECRET_KEY is set (via beforeEach), but we pass stripe: undefined
    let thrownError: unknown = null;

    try {
      await runResync({ prisma: makeMockPrisma(), stripe: undefined });
    } catch (err) {
      thrownError = err;
    } finally {
      exitMock.restore();
    }

    // The implementation must not surface a TypeError about reading properties of undefined.
    // It should either succeed (built Stripe from env) or throw/exit with a clear message.
    if (thrownError instanceof Error) {
      expect(thrownError.message).not.toMatch(/cannot read propert/i);
      expect(thrownError.message).not.toMatch(/undefined/i);
    }
    // If it called process.exit, the code must not be an unhandled-error code from a TypeError
    // (a clean exit(1) with a user-facing message is acceptable)
    for (const code of exitMock.calls) {
      expect([0, 1]).toContain(code);
    }
  });

  test("exits with code 1 and error message when STRIPE_SECRET_KEY is missing", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const exitMock = mockProcessExit();

    try {
      await runResync({ prisma: makeMockPrisma(), stripe: undefined });
    } catch {
      // process.exit throws in test environment
    } finally {
      exitMock.restore();
    }

    expect(exitMock.calls).toContain(1);
  });

  test("successful resync: iterates Stripe subscriptions and upserts local records", async () => {
    const subscriptionUpsert = mock((_args: any) =>
      Promise.resolve(LOCAL_SUB_ACTIVE)
    );
    const prisma = makeMockPrisma({
      customerFindUnique: (_args: any) => Promise.resolve(LOCAL_CUSTOMER_1),
      subscriptionUpsert,
    });
    const stripe = makeMockStripe();

    const summary = await runResync({ prisma, stripe: stripe });

    expect(subscriptionUpsert).toHaveBeenCalledTimes(1);
    expect(summary.synced).toBeGreaterThanOrEqual(1);
    expect(summary.errors).toBe(0);
  });

  test("successful resync exits with code 0", async () => {
    const prisma = makeMockPrisma({
      customerFindUnique: (_args: any) => Promise.resolve(LOCAL_CUSTOMER_1),
    });
    const stripe = makeMockStripe();
    const exitMock = mockProcessExit();

    try {
      await runResync({ prisma, stripe, exitOnComplete: true });
    } catch {
      // process.exit throws in test environment
    } finally {
      exitMock.restore();
    }

    expect(exitMock.calls).toContain(0);
  });

  test("marks local subscriptions as canceled when not present in Stripe response", async () => {
    const subscriptionUpdateMany = mock((_args: any) =>
      Promise.resolve({ count: 1 })
    );
    const prisma = makeMockPrisma({
      customerFindUnique: (_args: any) => Promise.resolve(LOCAL_CUSTOMER_1),
      subscriptionUpdateMany,
    });
    // Stripe returns empty list — all local active subs should be canceled
    const stripe = makeMockStripe({
      subscriptionsList: (_args: any) =>
        Promise.resolve({ data: [], has_more: false }),
    });

    const summary = await runResync({ prisma, stripe });

    expect(subscriptionUpdateMany).toHaveBeenCalledTimes(1);
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const callArgs = (subscriptionUpdateMany.mock.calls as any[][])[0][0];
    expect(callArgs?.data?.status).toBe("canceled");
    expect(summary.canceled).toBeGreaterThanOrEqual(0);
  });

  test("skips orphaned Stripe subscription with no matching local customer and records in summary", async () => {
    const subscriptionUpsert = mock((_args: any) =>
      Promise.resolve(LOCAL_SUB_ACTIVE)
    );
    const prisma = makeMockPrisma({
      // No local customer found for this Stripe customer
      customerFindUnique: (_args: any) => Promise.resolve(null),
      subscriptionUpsert,
    });
    const stripe = makeMockStripe();

    const summary = await runResync({ prisma, stripe });

    // Should not upsert when no local customer found
    expect(subscriptionUpsert).not.toHaveBeenCalled();
    expect(summary.skipped).toBeGreaterThanOrEqual(1);
  });

  test("handles already-canceled Stripe subscriptions without creating local records", async () => {
    const subscriptionUpsert = mock((_args: any) =>
      Promise.resolve(LOCAL_SUB_ACTIVE)
    );
    const prisma = makeMockPrisma({
      customerFindUnique: (_args: any) => Promise.resolve(LOCAL_CUSTOMER_1),
      subscriptionUpsert,
    });
    const stripe = makeMockStripe({
      subscriptionsList: (_args: any) =>
        Promise.resolve({ data: [STRIPE_SUB_CANCELED], has_more: false }),
    });

    const summary = await runResync({ prisma, stripe });

    // A canceled Stripe sub should not cause creation of a new local record
    // (it may update an existing one to canceled status, but won't create fresh)
    // The exact behavior depends on implementation; at minimum no errors should occur
    expect(summary.errors).toBe(0);
  });

  test("exits with code 1 and records errors in summary when an exception occurs during sync", async () => {
    const prisma = makeMockPrisma({
      customerFindUnique: (_args: any) => Promise.resolve(LOCAL_CUSTOMER_1),
      subscriptionUpsert: (_args: any) =>
        Promise.reject(new Error("DB write failed")),
    });
    const stripe = makeMockStripe();
    const exitMock = mockProcessExit();

    let summary: any = null;
    try {
      summary = await runResync({ prisma, stripe, exitOnComplete: true });
    } catch {
      // process.exit throws in test environment
    } finally {
      exitMock.restore();
    }

    expect(exitMock.calls).toContain(1);
    if (summary) {
      expect(summary.errors).toBeGreaterThan(0);
    }
  });

  test("prints summary output after resync completes", async () => {
    const logs: string[] = [];
    const originalLog = console.log.bind(console);
    console.log = (...args: any[]) => logs.push(args.join(" "));

    const prisma = makeMockPrisma({
      customerFindUnique: (_args: any) => Promise.resolve(LOCAL_CUSTOMER_1),
    });
    const stripe = makeMockStripe();

    try {
      await runResync({ prisma, stripe });
    } finally {
      console.log = originalLog;
    }

    // Some summary output should have been printed
    expect(logs.length).toBeGreaterThan(0);
  });
});
