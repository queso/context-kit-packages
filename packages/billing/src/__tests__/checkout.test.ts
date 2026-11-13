import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createCheckoutSession,
  createPortalSession,
  completeCheckout,
  nextMonthStartUtc,
  AlreadySubscribedError,
} from "../checkout";
import { billingCustomer, billingSubscription } from "../schema/postgres";
import { createTestDb } from "./helpers/db";
import { FakeStripe } from "./helpers/fake-stripe";
import { testConfig } from "./helpers/config";
import type { BillingContext } from "../types";

const NOW = new Date("2026-01-20T15:30:00Z");
let fake: FakeStripe;
let ctx: BillingContext;
let close: () => Promise<void>;

beforeEach(async () => {
  fake = new FakeStripe();
  const t = await createTestDb();
  close = t.close;
  ctx = { db: t.db, stripe: fake.client(), config: testConfig, now: () => NOW };
  fake.addPrice({ id: "price_pro", lookupKey: "test_pro_monthly" });
  fake.addPrice({ id: "price_team", lookupKey: "test_team_monthly" });
  fake.addPrice({ id: "price_over", lookupKey: "test_credit_overage", usageType: "metered", unitAmount: 12 });
});
afterEach(() => close());

const checkoutCreates = () =>
  fake.requests.filter((r) => r.method === "POST" && r.path === "/v1/checkout/sessions");

describe("nextMonthStartUtc", () => {
  test.each([
    ["2026-01-20T15:30:00Z", "2026-02-01T00:00:00.000Z"],
    ["2026-12-31T23:59:59Z", "2027-01-01T00:00:00.000Z"],
    ["2026-03-01T00:00:00Z", "2026-04-01T00:00:00.000Z"],
  ])("%s -> %s", (now, expected) => {
    expect(nextMonthStartUtc(new Date(now)).toISOString()).toBe(expected);
  });
});

describe("createCheckoutSession", () => {
  const input = {
    subjectId: "100",
    plan: "pro",
    successUrl: "https://app.test/billing/success?session_id={CHECKOUT_SESSION_ID}",
    cancelUrl: "https://app.test/billing",
  };

  test("creates a hosted subscription Checkout with the plan price and the metered overage price", async () => {
    const session = await createCheckoutSession(ctx, input);

    expect(session.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const [req] = checkoutCreates();
    const customer = (await ctx.db.select().from(billingCustomer))[0]!.stripeCustomerId;
    expect(req?.params).toMatchObject({
      mode: "subscription",
      customer,
      client_reference_id: "100",
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      line_items: [{ price: "price_pro", quantity: "1" }, { price: "price_over" }],
      subscription_data: {
        metadata: { subject_id: "100" },
        billing_cycle_anchor_config: { day_of_month: "1", hour: "0", minute: "0", second: "0" },
      },
    });
    // Stripe: "Quantity should not be defined when recurring.usage_type=metered."
    expect((req?.params.line_items as Record<string, unknown>[])[1]).not.toHaveProperty("quantity");
    expect(req?.params).not.toHaveProperty("ui_mode");
    expect(req?.params).not.toHaveProperty("automatic_tax");
  });

  test.each(["2026-01-20T15:30:00Z", "2026-01-31T12:00:00Z", "2026-01-31T23:45:00Z"])(
    "at %s Stripe computes the anchor: a config is sent, never a timestamp or expires_at",
    async (now) => {
      ctx = { ...ctx, now: () => new Date(now) };
      await createCheckoutSession(ctx, input);
      const params = checkoutCreates()[0]?.params as Record<string, Record<string, unknown>>;
      expect(params.subscription_data?.billing_cycle_anchor_config).toEqual({
        day_of_month: "1",
        hour: "0",
        minute: "0",
        second: "0",
      });
      expect(params.subscription_data).not.toHaveProperty("billing_cycle_anchor");
      expect(params).not.toHaveProperty("expires_at");
    }
  );

  test("can leave the billing anchor to Stripe", async () => {
    await createCheckoutSession(ctx, { ...input, anchorToMonthStart: false });
    const params = checkoutCreates()[0]?.params as Record<string, Record<string, unknown>>;
    expect(params.subscription_data).not.toHaveProperty("billing_cycle_anchor");
    expect(params.subscription_data).not.toHaveProperty("billing_cycle_anchor_config");
    expect(params).not.toHaveProperty("expires_at");
  });

  test("expires the subject's earlier open session when a new one is created", async () => {
    const first = await createCheckoutSession(ctx, input);
    const second = await createCheckoutSession(ctx, input);
    expect(fake.checkoutSessions.get(first.id)?.status).toBe("expired");
    expect(fake.checkoutSessions.get(second.id)?.status).toBe("open");
  });

  test("does not touch another customer's open session", async () => {
    const other = await createCheckoutSession(ctx, { ...input, subjectId: "200" });
    const mine = await createCheckoutSession(ctx, input);
    expect(fake.checkoutSessions.get(other.id)?.status).toBe("open");
    expect(fake.checkoutSessions.get(mine.id)?.status).toBe("open");
  });

  test("two concurrent calls for one subject leave exactly one open session", async () => {
    await Promise.all([createCheckoutSession(ctx, input), createCheckoutSession(ctx, input)]);
    const open = [...fake.checkoutSessions.values()].filter((cs) => cs.status === "open");
    expect(fake.checkoutSessions.size).toBe(2);
    expect(open).toHaveLength(1);
  });

  test("turns on Stripe Tax collection only when the config asks for it", async () => {
    ctx = { ...ctx, config: { ...testConfig, automaticTax: true } };
    await createCheckoutSession(ctx, input);
    expect(checkoutCreates()[0]?.params).toMatchObject({
      automatic_tax: { enabled: "true" },
      billing_address_collection: "auto",
      customer_update: { address: "auto", name: "auto" },
      tax_id_collection: { enabled: "true" },
    });
  });

  test("fails loudly when a lookup key matches two active prices", async () => {
    fake.addPrice({ id: "price_pro_2", lookupKey: "test_pro_monthly" });
    await expect(createCheckoutSession(ctx, input)).rejects.toThrow(/test_pro_monthly/);
    expect(checkoutCreates()).toHaveLength(0);
  });

  test("refuses the free plan", async () => {
    await expect(createCheckoutSession(ctx, { ...input, plan: "free" })).rejects.toThrow(/free plan/);
    expect(checkoutCreates()).toHaveLength(0);
  });

  test("refuses a plan that is not in the config", async () => {
    await expect(createCheckoutSession(ctx, { ...input, plan: "enterprise" })).rejects.toThrow(/enterprise/);
  });

  test("fails clearly when a price lookup key is missing in Stripe", async () => {
    fake.prices.delete("price_over");
    await expect(createCheckoutSession(ctx, input)).rejects.toThrow(/test_credit_overage/);
    expect(checkoutCreates()).toHaveLength(0);
  });

  test.each(["active", "trialing", "past_due"])(
    "refuses a second subscription while one is %s",
    async (status) => {
      await ctx.db.insert(billingSubscription).values({
        stripeSubscriptionId: "sub_1",
        subjectId: "100",
        stripeCustomerId: "cus_1",
        status,
        planKey: "pro",
        livemode: false,
        syncedAt: NOW,
      });
      await expect(createCheckoutSession(ctx, { ...input, plan: "team" })).rejects.toBeInstanceOf(
        AlreadySubscribedError
      );
      expect(checkoutCreates()).toHaveLength(0);
    }
  );

  test("allows a new checkout after the old subscription was canceled", async () => {
    await ctx.db.insert(billingSubscription).values({
      stripeSubscriptionId: "sub_1",
      subjectId: "100",
      stripeCustomerId: "cus_1",
      status: "canceled",
      planKey: "pro",
      livemode: false,
      syncedAt: NOW,
    });
    await expect(createCheckoutSession(ctx, input)).resolves.toHaveProperty("url");
  });
});

describe("completeCheckout", () => {
  test("syncs the subscription from the success page, before or without the webhook", async () => {
    const session = await createCheckoutSession(ctx, {
      subjectId: "100",
      plan: "pro",
      successUrl: "https://app.test/ok",
      cancelUrl: "https://app.test/no",
    });
    const customer = (await ctx.db.select().from(billingCustomer))[0]!.stripeCustomerId;
    fake.putSubscription({ id: "sub_new", customer, status: "active", priceIds: ["price_pro", "price_over"], metadata: { subject_id: "100" } });
    fake.completeCheckoutSession(session.id, "sub_new");

    const result = await completeCheckout(ctx, session.id, { subjectId: "100" });

    expect(result).toMatchObject({ outcome: "synced", subjectId: "100", subscriptionId: "sub_new" });
    expect((await ctx.db.select().from(billingSubscription))[0]?.planKey).toBe("pro");
  });

  test("does nothing for a session that is still open", async () => {
    const session = await createCheckoutSession(ctx, {
      subjectId: "100",
      plan: "pro",
      successUrl: "https://app.test/ok",
      cancelUrl: "https://app.test/no",
    });
    expect(await completeCheckout(ctx, session.id, { subjectId: "100" })).toBeNull();
    expect(await ctx.db.select().from(billingSubscription)).toHaveLength(0);
  });

  test("refuses a session that belongs to another subject", async () => {
    const session = await createCheckoutSession(ctx, {
      subjectId: "100",
      plan: "pro",
      successUrl: "https://app.test/ok",
      cancelUrl: "https://app.test/no",
    });
    await expect(completeCheckout(ctx, session.id, { subjectId: "999" })).rejects.toThrow(/another subject/);
  });
});

describe("createPortalSession", () => {
  test("opens the hosted portal for the subject's customer", async () => {
    await ctx.db.insert(billingCustomer).values({ subjectId: "100", stripeCustomerId: "cus_100", livemode: false });
    const session = await createPortalSession(ctx, { subjectId: "100", returnUrl: "https://app.test/billing" });
    expect(session.url).toMatch(/^https:\/\/billing\.stripe\.com\//);
    const req = fake.requests.find((r) => r.path === "/v1/billing_portal/sessions");
    expect(req?.params).toEqual({ customer: "cus_100", return_url: "https://app.test/billing" });
  });

  test("passes a portal configuration id through", async () => {
    await ctx.db.insert(billingCustomer).values({ subjectId: "100", stripeCustomerId: "cus_100", livemode: false });
    await createPortalSession(ctx, { subjectId: "100", returnUrl: "https://app.test/b", configuration: "bpc_123" });
    const req = fake.requests.find((r) => r.path === "/v1/billing_portal/sessions");
    expect(req?.params.configuration).toBe("bpc_123");
  });

  test("refuses a subject that has never checked out", async () => {
    await expect(
      createPortalSession(ctx, { subjectId: "nobody", returnUrl: "https://app.test/b" })
    ).rejects.toThrow(/no Stripe customer/);
  });
});
