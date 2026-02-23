import { describe, expect, mock, test } from "bun:test";
import type { PlanDefinition } from "../types";
import type { PrismaCustomer, PrismaSubscription } from "../prisma";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const WEBHOOK_SECRET = "whsec_test_secret";
const STRIPE_CUSTOMER_ID = "cus_stripe123";
const STRIPE_SUB_ID = "sub_stripe_1";
const LOCAL_CUSTOMER_ID = "local_cust_1";
const USER_ID = "user_abc123";

const PRO_PLAN: PlanDefinition = {
  id: "pro",
  name: "Pro",
  stripePriceId: "price_pro_monthly",
};

const PERIOD_START_TS = 1717200000; // 2024-06-01 UTC
const PERIOD_END_TS = 1719792000;   // 2024-07-01 UTC

const MOCK_CUSTOMER: PrismaCustomer = {
  id: LOCAL_CUSTOMER_ID,
  userId: USER_ID,
  stripeCustomerId: STRIPE_CUSTOMER_ID,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
};

const MOCK_LOCAL_SUB: PrismaSubscription = {
  id: "local_sub_1",
  customerId: LOCAL_CUSTOMER_ID,
  stripeSubscriptionId: STRIPE_SUB_ID,
  stripePriceId: "price_pro_monthly",
  planId: "pro",
  status: "active",
  interval: "monthly",
  currentPeriodStart: new Date(PERIOD_START_TS * 1000),
  currentPeriodEnd: new Date(PERIOD_END_TS * 1000),
  cancelAtPeriodEnd: false,
  createdAt: new Date("2024-06-01"),
  updatedAt: new Date("2024-06-01"),
};

// ─── Stripe event payloads ────────────────────────────────────────────────────

function makeStripeSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: STRIPE_SUB_ID,
    customer: STRIPE_CUSTOMER_ID,
    status: "active",
    items: {
      data: [{
        price: { id: "price_pro_monthly" },
        recurring: { interval: "month" },
      }],
    },
    current_period_start: PERIOD_START_TS,
    current_period_end: PERIOD_END_TS,
    cancel_at_period_end: false,
    metadata: { planId: "pro", userId: USER_ID },
    ...overrides,
  };
}

function makeCheckoutSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "cs_test_session_1",
    customer: STRIPE_CUSTOMER_ID,
    subscription: STRIPE_SUB_ID,
    metadata: { planId: "pro", userId: USER_ID },
    mode: "subscription",
    payment_status: "paid",
    ...overrides,
  };
}

function makeInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: "in_test_1",
    customer: STRIPE_CUSTOMER_ID,
    subscription: STRIPE_SUB_ID,
    status: "paid",
    ...overrides,
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
  subscriptionUpsert?: (args: any) => Promise<PrismaSubscription>;
  subscriptionUpdate?: (args: any) => Promise<PrismaSubscription>;
  subscriptionFindFirst?: (args: any) => Promise<PrismaSubscription | null>;
}): any {
  return {
    customer: {
      findUnique: overrides?.customerFindUnique ?? ((_: any) => Promise.resolve(MOCK_CUSTOMER)),
    },
    subscription: {
      upsert: overrides?.subscriptionUpsert ?? ((_: any) => Promise.resolve(MOCK_LOCAL_SUB)),
      update: overrides?.subscriptionUpdate ?? ((_: any) => Promise.resolve(MOCK_LOCAL_SUB)),
      findFirst: overrides?.subscriptionFindFirst ?? ((_: any) => Promise.resolve(MOCK_LOCAL_SUB)),
    },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: test mock
function makeMockStripe(overrides?: {
  webhooksConstructEvent?: ReturnType<typeof mock>;
}): any {
  return {
    webhooks: {
      constructEvent: overrides?.webhooksConstructEvent ??
        mock((payload: string, sig: string, _secret: string) => {
          if (sig !== "valid-sig") throw new Error("No signatures found matching the expected signature for payload.");
          return JSON.parse(payload);
        }),
    },
  };
}

// Helper: build a minimal Next.js-like Request with a raw body and signature header
function makeRequest(event: object, sig = "valid-sig"): Request {
  const body = JSON.stringify(event);
  return new Request("https://example.com/api/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": sig,
    },
    body,
  });
}

function makeEvent(type: string, data: object) {
  return {
    id: `evt_${type.replace(/\./g, "_")}`,
    type,
    data: { object: data },
  };
}

// ─── Import target ────────────────────────────────────────────────────────────

// @ts-expect-error: module created by B.A. during implementation phase
const { toWebhookHandler } = await import("../webhook");

// ─── toWebhookHandler ─────────────────────────────────────────────────────────

describe("toWebhookHandler", () => {
  test("returns a function (Next.js POST route handler)", () => {
    const stripe = makeMockStripe();
    const prisma = makeMockPrisma();
    const plans = makePlansMap();

    const handler = toWebhookHandler({ stripe, prisma, plans, webhookSecret: WEBHOOK_SECRET });

    expect(typeof handler).toBe("function");
  });

  test("returns 400 when Stripe signature verification fails", async () => {
    const stripe = makeMockStripe({
      webhooksConstructEvent: mock(() => {
        throw new Error("No signatures found matching the expected signature for payload.");
      }),
    });
    const prisma = makeMockPrisma();
    const plans = makePlansMap();

    const handler = toWebhookHandler({ stripe, prisma, plans, webhookSecret: WEBHOOK_SECRET });
    const req = makeRequest(makeEvent("checkout.session.completed", {}), "invalid-sig");

    const response = await handler(req);

    expect(response.status).toBe(400);
  });

  test("returns 200 for checkout.session.completed and upserts subscription", async () => {
    const subscriptionUpsert = mock((_: any) => Promise.resolve(MOCK_LOCAL_SUB));
    const prisma = makeMockPrisma({ subscriptionUpsert });
    const stripe = makeMockStripe();
    const plans = makePlansMap();

    const event = makeEvent("checkout.session.completed", makeCheckoutSession());
    const handler = toWebhookHandler({ stripe, prisma, plans, webhookSecret: WEBHOOK_SECRET });
    const req = makeRequest(event);

    const response = await handler(req);

    expect(response.status).toBe(200);
    expect(subscriptionUpsert).toHaveBeenCalledTimes(1);
  });

  test("returns 200 for customer.subscription.created and upserts local subscription", async () => {
    const subscriptionUpsert = mock((_: any) => Promise.resolve(MOCK_LOCAL_SUB));
    const prisma = makeMockPrisma({ subscriptionUpsert });
    const stripe = makeMockStripe();
    const plans = makePlansMap();

    const event = makeEvent("customer.subscription.created", makeStripeSubscription());
    const handler = toWebhookHandler({ stripe, prisma, plans, webhookSecret: WEBHOOK_SECRET });
    const req = makeRequest(event);

    const response = await handler(req);

    expect(response.status).toBe(200);
    expect(subscriptionUpsert).toHaveBeenCalledTimes(1);
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const callArgs = (subscriptionUpsert.mock.calls as any[][])[0][0];
    expect(callArgs?.where?.stripeSubscriptionId ?? callArgs?.create?.stripeSubscriptionId).toBe(STRIPE_SUB_ID);
  });

  test("returns 200 for customer.subscription.updated and syncs status change", async () => {
    const subscriptionUpsert = mock((_: any) => Promise.resolve(MOCK_LOCAL_SUB));
    const prisma = makeMockPrisma({ subscriptionUpsert });
    const stripe = makeMockStripe();
    const plans = makePlansMap();

    const updatedSub = makeStripeSubscription({ status: "past_due" });
    const event = makeEvent("customer.subscription.updated", updatedSub);
    const handler = toWebhookHandler({ stripe, prisma, plans, webhookSecret: WEBHOOK_SECRET });
    const req = makeRequest(event);

    const response = await handler(req);

    expect(response.status).toBe(200);
    expect(subscriptionUpsert).toHaveBeenCalledTimes(1);
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const callArgs = (subscriptionUpsert.mock.calls as any[][])[0][0];
    const upsertedStatus = callArgs?.update?.status ?? callArgs?.create?.status;
    expect(upsertedStatus).toBe("past_due");
  });

  test("returns 200 for customer.subscription.deleted and marks local subscription canceled", async () => {
    const subscriptionUpdate = mock((_: any) =>
      Promise.resolve({ ...MOCK_LOCAL_SUB, status: "canceled" })
    );
    const prisma = makeMockPrisma({ subscriptionUpdate });
    const stripe = makeMockStripe();
    const plans = makePlansMap();

    const deletedSub = makeStripeSubscription({ status: "canceled" });
    const event = makeEvent("customer.subscription.deleted", deletedSub);
    const handler = toWebhookHandler({ stripe, prisma, plans, webhookSecret: WEBHOOK_SECRET });
    const req = makeRequest(event);

    const response = await handler(req);

    expect(response.status).toBe(200);
    // Either upsert or update should have been called with status=canceled
    const wasCanceled =
      (subscriptionUpdate.mock.calls as any[][]).some(
        ([args]) => args?.data?.status === "canceled"
      );
    expect(wasCanceled).toBe(true);
  });

  test("returns 200 for invoice.paid without error", async () => {
    const prisma = makeMockPrisma();
    const stripe = makeMockStripe();
    const plans = makePlansMap();

    const event = makeEvent("invoice.paid", makeInvoice({ status: "paid" }));
    const handler = toWebhookHandler({ stripe, prisma, plans, webhookSecret: WEBHOOK_SECRET });
    const req = makeRequest(event);

    const response = await handler(req);

    expect(response.status).toBe(200);
  });

  test("returns 200 for invoice.payment_failed without error", async () => {
    const prisma = makeMockPrisma();
    const stripe = makeMockStripe();
    const plans = makePlansMap();

    const event = makeEvent("invoice.payment_failed", makeInvoice({ status: "open" }));
    const handler = toWebhookHandler({ stripe, prisma, plans, webhookSecret: WEBHOOK_SECRET });
    const req = makeRequest(event);

    const response = await handler(req);

    expect(response.status).toBe(200);
  });

  test("returns 200 for an unknown event type (graceful no-op)", async () => {
    const prisma = makeMockPrisma();
    const stripe = makeMockStripe();
    const plans = makePlansMap();

    const event = makeEvent("some.unknown.event", { id: "obj_1" });
    const handler = toWebhookHandler({ stripe, prisma, plans, webhookSecret: WEBHOOK_SECRET });
    const req = makeRequest(event);

    const response = await handler(req);

    expect(response.status).toBe(200);
  });

  test("is idempotent: processing the same event twice produces the same subscription state", async () => {
    // Both calls upsert — the second should overwrite with identical data (no duplicate errors)
    const upsertResults: PrismaSubscription[] = [];
    const subscriptionUpsert = mock((_: any) => {
      const result = { ...MOCK_LOCAL_SUB };
      upsertResults.push(result);
      return Promise.resolve(result);
    });

    const prisma = makeMockPrisma({ subscriptionUpsert });
    const stripe = makeMockStripe();
    const plans = makePlansMap();

    const event = makeEvent("customer.subscription.updated", makeStripeSubscription());
    const handler = toWebhookHandler({ stripe, prisma, plans, webhookSecret: WEBHOOK_SECRET });

    const req1 = makeRequest(event);
    const req2 = makeRequest(event);

    const [res1, res2] = await Promise.all([handler(req1), handler(req2)]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    // Both calls should have used the same stripeSubscriptionId (upsert key)
    const calls = subscriptionUpsert.mock.calls as any[][];
    expect(calls).toHaveLength(2);
    const id1 = calls[0][0]?.where?.stripeSubscriptionId;
    const id2 = calls[1][0]?.where?.stripeSubscriptionId;
    if (id1 && id2) expect(id1).toBe(id2);
  });

  test("checkout.session.completed: no-op (no db writes) when customer not found", async () => {
    const subscriptionUpsert = mock((_: any) => Promise.resolve(MOCK_LOCAL_SUB));
    const prisma = makeMockPrisma({
      customerFindUnique: (_: any) => Promise.resolve(null),
      subscriptionUpsert,
    });
    const stripe = makeMockStripe();
    const plans = makePlansMap();

    const event = makeEvent("checkout.session.completed", makeCheckoutSession());
    const handler = toWebhookHandler({ stripe, prisma, plans, webhookSecret: WEBHOOK_SECRET });
    const req = makeRequest(event);

    const response = await handler(req);

    expect(response.status).toBe(200);
    expect(subscriptionUpsert).not.toHaveBeenCalled();
  });

  test("customer.subscription.updated syncs cancel_at_period_end flag", async () => {
    const subscriptionUpsert = mock((_: any) => Promise.resolve(MOCK_LOCAL_SUB));
    const prisma = makeMockPrisma({ subscriptionUpsert });
    const stripe = makeMockStripe();
    const plans = makePlansMap();

    const updatedSub = makeStripeSubscription({ cancel_at_period_end: true });
    const event = makeEvent("customer.subscription.updated", updatedSub);
    const handler = toWebhookHandler({ stripe, prisma, plans, webhookSecret: WEBHOOK_SECRET });
    const req = makeRequest(event);

    await handler(req);

    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const callArgs = (subscriptionUpsert.mock.calls as any[][])[0][0];
    const cancelAtPeriodEnd =
      callArgs?.update?.cancelAtPeriodEnd ?? callArgs?.create?.cancelAtPeriodEnd;
    expect(cancelAtPeriodEnd).toBe(true);
  });
});
