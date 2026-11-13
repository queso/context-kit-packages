import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import Stripe from "stripe";
import { createWebhookHandler } from "../webhooks";
import { billingCustomer, billingSubscription, billingWebhookEvent } from "../schema/postgres";
import { createTestDb } from "./helpers/db";
import { FakeStripe } from "./helpers/fake-stripe";
import { testConfig } from "./helpers/config";
import eventFixture from "./fixtures/stripe/event.json";
import checkoutSessionFixture from "./fixtures/stripe/checkout.session.json";
import invoiceFixture from "./fixtures/stripe/invoice.json";
import subscriptionFixture from "./fixtures/stripe/subscription.json";
import type { BillingContext } from "../types";

const SECRET = "whsec_test_secret";
let fake: FakeStripe;
let ctx: BillingContext;
let close: () => Promise<void>;
let handle: (req: Request) => Promise<Response>;

beforeEach(async () => {
  fake = new FakeStripe();
  const t = await createTestDb();
  close = t.close;
  ctx = { db: t.db, stripe: fake.client(), config: testConfig };
  handle = createWebhookHandler(ctx, { secret: SECRET });
  fake.addPrice({ id: "price_pro", lookupKey: "test_pro_monthly" });
  fake.addPrice({ id: "price_team", lookupKey: "test_team_monthly" });
  fake.addPrice({ id: "price_over", lookupKey: "test_credit_overage", usageType: "metered" });
});
afterEach(() => close());

let eventCounter = 0;
function event(type: string, object: Record<string, unknown>, id = `evt_test_${++eventCounter}`) {
  return { ...structuredClone(eventFixture), id, type, api_version: "2026-10-28.endive", data: { object } };
}

// Bun loads stripe-node's Web Crypto build, whose signer is async only.
async function signedRequest(payload: unknown, opts: { secret?: string; timestamp?: number; body?: string } = {}) {
  const body = opts.body ?? JSON.stringify(payload);
  const header = await Stripe.webhooks.generateTestHeaderStringAsync({
    payload: JSON.stringify(payload),
    secret: opts.secret ?? SECRET,
    ...(opts.timestamp ? { timestamp: opts.timestamp } : {}),
  });
  return new Request("https://app.test/api/billing/webhook", {
    method: "POST",
    headers: { "stripe-signature": header, "content-type": "application/json" },
    body,
  });
}

function subscriptionObject(id: string, priceLookup: string) {
  return { ...structuredClone(subscriptionFixture), id, items: { data: [{ price: { lookup_key: priceLookup } }] } };
}

const retrieves = (id: string) =>
  fake.requests.filter((r) => r.method === "GET" && r.path === `/v1/subscriptions/${id}`).length;

describe("signature verification", () => {
  test("rejects a request with no Stripe-Signature header", async () => {
    const res = await handle(new Request("https://app.test/x", { method: "POST", body: "{}" }));
    expect(res.status).toBe(400);
  });

  test("rejects a payload signed with another secret", async () => {
    const res = await handle(await signedRequest(event("customer.subscription.updated", {}), { secret: "whsec_other" }));
    expect(res.status).toBe(400);
  });

  test("rejects a body changed after signing", async () => {
    const payload = event("customer.subscription.updated", subscriptionObject("sub_1", "test_pro_monthly"));
    const tampered = JSON.stringify({ ...payload, type: "invoice.paid" });
    const res = await handle(await signedRequest(payload, { body: tampered }));
    expect(res.status).toBe(400);
  });

  test("rejects a signature older than Stripe's default 5-minute tolerance", async () => {
    const old = Math.floor(Date.now() / 1000) - 301;
    const res = await handle(await signedRequest(event("customer.subscription.updated", {}), { timestamp: old }));
    expect(res.status).toBe(400);
  });

  test("does not echo the verification error to the caller", async () => {
    const res = await handle(await signedRequest(event("x", {}), { secret: "whsec_other" }));
    expect(await res.text()).not.toContain("whsec");
  });

  test("records nothing for a rejected request", async () => {
    await handle(await signedRequest(event("customer.subscription.updated", {}), { secret: "whsec_other" }));
    expect(await ctx.db.select().from(billingWebhookEvent)).toHaveLength(0);
  });
});

describe("event processing", () => {
  test("a subscription event re-fetches the subscription and stores it", async () => {
    fake.putSubscription({ id: "sub_1", customer: "cus_1", status: "active", priceIds: ["price_pro", "price_over"], metadata: { subject_id: "100" } });
    const payload = event("customer.subscription.created", subscriptionObject("sub_1", "test_pro_monthly"));

    const res = await handle(await signedRequest(payload));

    expect(res.status).toBe(200);
    const [sub] = await ctx.db.select().from(billingSubscription);
    expect(sub).toMatchObject({ stripeSubscriptionId: "sub_1", subjectId: "100", planKey: "pro" });
    const [ev] = await ctx.db.select().from(billingWebhookEvent);
    expect(ev).toMatchObject({ stripeEventId: payload.id, type: "customer.subscription.created", objectId: "sub_1", lastError: null });
    expect(ev?.processedAt).toBeInstanceOf(Date);
  });

  test("a repeated delivery of the same event is acknowledged and not processed again", async () => {
    fake.putSubscription({ id: "sub_1", customer: "cus_1", status: "active", priceIds: ["price_pro"], metadata: { subject_id: "100" } });
    const payload = event("customer.subscription.updated", subscriptionObject("sub_1", "test_pro_monthly"));

    expect((await handle(await signedRequest(payload))).status).toBe(200);
    expect((await handle(await signedRequest(payload))).status).toBe(200);

    expect(retrieves("sub_1")).toBe(1);
    expect(await ctx.db.select().from(billingWebhookEvent)).toHaveLength(1);
  });

  test("events arriving out of order still leave Stripe's current state", async () => {
    // Stripe's current state is Team. The newer event (Team) arrives first, the
    // older one (snapshot says Pro) arrives second. The payload is never
    // applied; each event re-fetches, so the row ends on Team either way.
    fake.putSubscription({ id: "sub_1", customer: "cus_1", status: "active", priceIds: ["price_team"], metadata: { subject_id: "100" } });
    await handle(await signedRequest(event("customer.subscription.updated", subscriptionObject("sub_1", "test_team_monthly"))));
    await handle(await signedRequest(event("customer.subscription.updated", subscriptionObject("sub_1", "test_pro_monthly"))));

    const rows = await ctx.db.select().from(billingSubscription);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.planKey).toBe("team");
  });

  test("checkout.session.completed links the subject to the customer and syncs the subscription", async () => {
    fake.putSubscription({ id: "sub_9", customer: "cus_9", status: "active", priceIds: ["price_pro", "price_over"] });
    const session = {
      ...structuredClone(checkoutSessionFixture),
      id: "cs_test_1",
      mode: "subscription",
      customer: "cus_9",
      subscription: "sub_9",
      client_reference_id: "900",
      livemode: false,
    };

    const res = await handle(await signedRequest(event("checkout.session.completed", session)));

    expect(res.status).toBe(200);
    expect(await ctx.db.select().from(billingCustomer)).toEqual([
      expect.objectContaining({ subjectId: "900", stripeCustomerId: "cus_9" }),
    ]);
    expect((await ctx.db.select().from(billingSubscription))[0]).toMatchObject({ subjectId: "900", planKey: "pro" });
  });

  describe("a completed checkout never rebinds an existing mapping", () => {
    const completed = (customer: string, subject: string, sub: string) => ({
      ...structuredClone(checkoutSessionFixture),
      id: `cs_test_${customer}_${subject}`,
      mode: "subscription",
      customer,
      subscription: sub,
      client_reference_id: subject,
      livemode: false,
    });

    test("a customer already mapped to subject A stays with A when a session names subject B", async () => {
      fake.putSubscription({ id: "sub_x", customer: "cus_X", status: "active", priceIds: ["price_pro"], metadata: { subject_id: "A" } });
      await ctx.db.insert(billingCustomer).values({ subjectId: "A", stripeCustomerId: "cus_X", livemode: false });

      const res = await handle(await signedRequest(event("checkout.session.completed", completed("cus_X", "B", "sub_x"))));

      expect(res.status).toBe(200);
      expect(await ctx.db.select().from(billingCustomer)).toEqual([
        expect.objectContaining({ subjectId: "A", stripeCustomerId: "cus_X" }),
      ]);
    });

    test("a subject already mapped to cus_Y keeps it when a session for the subject carries cus_Z", async () => {
      fake.putSubscription({ id: "sub_z", customer: "cus_Z", status: "active", priceIds: ["price_pro"], metadata: { subject_id: "A" } });
      await ctx.db.insert(billingCustomer).values({ subjectId: "A", stripeCustomerId: "cus_Y", livemode: false });

      const res = await handle(await signedRequest(event("checkout.session.completed", completed("cus_Z", "A", "sub_z"))));

      expect(res.status).toBe(200);
      expect(await ctx.db.select().from(billingCustomer)).toEqual([
        expect.objectContaining({ subjectId: "A", stripeCustomerId: "cus_Y" }),
      ]);
    });
  });

  test("checkout.session.completed in payment mode is recorded and ignored", async () => {
    const session = { ...structuredClone(checkoutSessionFixture), id: "cs_test_2", mode: "payment", subscription: null };
    const res = await handle(await signedRequest(event("checkout.session.completed", session)));
    expect(res.status).toBe(200);
    expect(await ctx.db.select().from(billingSubscription)).toHaveLength(0);
  });

  test("invoice.payment_failed syncs the invoice's subscription", async () => {
    fake.putSubscription({
      id: "sub_5",
      customer: "cus_5",
      status: "past_due",
      priceIds: ["price_pro"],
      metadata: { subject_id: "500" },
      latestInvoiceFinalizedAt: Date.parse("2026-01-02T00:00:00Z") / 1000,
    });
    const invoice = {
      ...structuredClone(invoiceFixture),
      id: "in_5",
      parent: { type: "subscription_details", quote_details: null, subscription_details: { metadata: null, subscription: "sub_5" } },
    };

    expect((await handle(await signedRequest(event("invoice.payment_failed", invoice)))).status).toBe(200);
    expect((await ctx.db.select().from(billingSubscription))[0]).toMatchObject({
      status: "past_due",
      pastDueSince: new Date("2026-01-02T00:00:00Z"),
    });
  });

  test("an invoice without a subscription is recorded and ignored", async () => {
    const invoice = { ...structuredClone(invoiceFixture), id: "in_6", parent: null };
    expect((await handle(await signedRequest(event("invoice.paid", invoice)))).status).toBe(200);
    expect(fake.requests.filter((r) => r.path.startsWith("/v1/subscriptions"))).toHaveLength(0);
  });

  test("an event type the package does not handle is acknowledged and recorded", async () => {
    const payload = event("customer.created", { id: "cus_x", object: "customer" });
    expect((await handle(await signedRequest(payload))).status).toBe(200);
    const [ev] = await ctx.db.select().from(billingWebhookEvent);
    expect(ev?.processedAt).toBeInstanceOf(Date);
  });

  test("a failure while processing returns 500 and leaves the event for Stripe's retry", async () => {
    fake.putSubscription({ id: "sub_1", customer: "cus_1", status: "active", priceIds: ["price_pro"], metadata: { subject_id: "100" } });
    fake.failNext((r) => r.path === "/v1/subscriptions/sub_1", 500);
    const payload = event("customer.subscription.updated", subscriptionObject("sub_1", "test_pro_monthly"));

    const first = await handle(await signedRequest(payload));
    expect(first.status).toBe(500);
    const [ev] = await ctx.db.select().from(billingWebhookEvent);
    expect(ev?.processedAt).toBeNull();
    expect(ev?.lastError).toBeTruthy();

    const retry = await handle(await signedRequest(payload));
    expect(retry.status).toBe(200);
    expect(await ctx.db.select().from(billingSubscription)).toHaveLength(1);
    const [after] = await ctx.db.select().from(billingWebhookEvent);
    expect(after?.processedAt).toBeInstanceOf(Date);
    expect(after?.lastError).toBeNull();
  });

  test("an event whose object no longer exists in Stripe is acknowledged and flagged, not retried for days", async () => {
    const res = await handle(await signedRequest(event("customer.subscription.updated", subscriptionObject("sub_gone", "test_pro_monthly"))));
    expect(res.status).toBe(200);
    const [ev] = await ctx.db.select().from(billingWebhookEvent);
    expect(ev?.lastError).toBe("resource_missing");
    expect(ev?.processedAt).toBeInstanceOf(Date);
  });

  test("a subscription with no known subject answers 500 so Stripe retries, and succeeds once the customer is mapped", async () => {
    fake.putSubscription({ id: "sub_x", customer: "cus_unknown", status: "active", priceIds: ["price_pro"] });
    const payload = event("customer.subscription.created", subscriptionObject("sub_x", "test_pro_monthly"));

    const first = await handle(await signedRequest(payload));
    expect(first.status).toBe(500);
    const [ev] = await ctx.db.select().from(billingWebhookEvent);
    expect(ev?.lastError).toBe("unknown_subject");
    expect(ev?.processedAt).toBeNull();

    await ctx.db.insert(billingCustomer).values({ subjectId: "late", stripeCustomerId: "cus_unknown", livemode: false });
    const retry = await handle(await signedRequest(payload));
    expect(retry.status).toBe(200);
    expect((await ctx.db.select().from(billingSubscription))[0]?.subjectId).toBe("late");
    const [after] = await ctx.db.select().from(billingWebhookEvent);
    expect(after).toMatchObject({ lastError: null });
    expect(after?.processedAt).toBeInstanceOf(Date);
  });

  test("a subject mismatch is acknowledged and flagged; retrying cannot fix it", async () => {
    await ctx.db.insert(billingCustomer).values({ subjectId: "real", stripeCustomerId: "cus_m", livemode: false });
    fake.putSubscription({ id: "sub_m", customer: "cus_m", status: "active", priceIds: ["price_pro"], metadata: { subject_id: "other" } });
    const res = await handle(await signedRequest(event("customer.subscription.updated", subscriptionObject("sub_m", "test_pro_monthly"))));
    expect(res.status).toBe(200);
    const [ev] = await ctx.db.select().from(billingWebhookEvent);
    expect(ev?.lastError).toBe("subject_mismatch");
    expect(ev?.processedAt).toBeInstanceOf(Date);
  });
});
