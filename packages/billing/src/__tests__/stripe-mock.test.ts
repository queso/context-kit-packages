import { describe, test, expect } from "bun:test";
import Stripe from "stripe";
import { createStripeClient } from "../stripe-client";
import { buildCheckoutParams } from "../checkout";
import { buildMeterEventParams } from "../usage";
import { bootstrapCatalog } from "../bootstrap";
import { testConfig } from "./helpers/config";

/**
 * Sends the package's real request parameters to stripe-mock, Stripe's official
 * mock server, which validates every request against Stripe's OpenAPI spec and
 * rejects unknown or mistyped parameters. stripe-mock is stateless and returns
 * fixed fixtures, so this suite checks request shapes only; behaviour is tested
 * against the stateful fake in the other files.
 *
 * Start it with:
 *   docker run --rm -p 12111:12111 stripe/stripe-mock
 * and set STRIPE_MOCK_URL=http://localhost:12111. CI sets REQUIRE_STRIPE_MOCK so
 * a missing server fails the job instead of skipping.
 */

const url = process.env.STRIPE_MOCK_URL ?? "";
const enabled = /^https?:\/\//.test(url);

if (process.env.REQUIRE_STRIPE_MOCK && !enabled) {
  throw new Error("REQUIRE_STRIPE_MOCK is set but STRIPE_MOCK_URL is missing or not an http(s) URL");
}
if (!enabled) {
  console.warn(
    "\n[billing] stripe-mock suite SKIPPED: set STRIPE_MOCK_URL=http://localhost:12111 " +
      "(docker run --rm -p 12111:12111 stripe/stripe-mock) to check request shapes against Stripe's OpenAPI spec.\n"
  );
}

function client(): Stripe {
  const parsed = new URL(url);
  return createStripeClient("sk_test_123", {
    host: parsed.hostname,
    port: Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)),
    protocol: parsed.protocol === "https:" ? "https" : "http",
    maxNetworkRetries: 0,
  });
}

describe.skipIf(!enabled)("request shapes accepted by stripe-mock (Stripe's OpenAPI spec)", () => {
  test("Checkout Session with the month-start billing_cycle_anchor_config", async () => {
    const params = buildCheckoutParams(testConfig, {
      subjectId: "100",
      customer: "cus_123",
      basePriceId: "price_base",
      overagePriceId: "price_over",
      successUrl: "https://app.test/ok?session_id={CHECKOUT_SESSION_ID}",
      cancelUrl: "https://app.test/no",
      anchorToMonthStart: true,
    });
    expect(params.subscription_data?.billing_cycle_anchor_config).toBeDefined();
    const session = await client().checkout.sessions.create(params);
    expect(session.object).toBe("checkout.session");
  });

  test("Checkout Session with Stripe Tax collection on", async () => {
    const params = buildCheckoutParams(
      { ...testConfig, automaticTax: true },
      {
        subjectId: "100",
        customer: "cus_123",
        basePriceId: "price_base",
        overagePriceId: "price_over",
        successUrl: "https://app.test/ok",
        cancelUrl: "https://app.test/no",
        anchorToMonthStart: false,
      }
    );
    expect((await client().checkout.sessions.create(params)).object).toBe("checkout.session");
  });

  test("customer create with subject metadata and an idempotency key", async () => {
    const customer = await client().customers.create(
      { metadata: { subject_id: "100" }, name: "octo-org" },
      { idempotencyKey: "context-kit-billing:customer:100" }
    );
    expect(customer.object).toBe("customer");
  });

  test("portal session", async () => {
    const session = await client().billingPortal.sessions.create({ customer: "cus_123", return_url: "https://app.test/b" });
    expect(session.object).toBe("billing_portal.session");
  });

  test("meter event", async () => {
    const params = buildMeterEventParams(
      { eventName: "test_credits", sourceId: "run_1", occurredAt: new Date(), value: 3 },
      "cus_123"
    );
    const event = await client().billing.meterEvents.create(params, { idempotencyKey: "context-kit-billing:meter:run_1" });
    expect(event.object).toBe("billing.meter_event");
  });

  test("subscription retrieve and list with the expansions sync uses", async () => {
    const stripe = client();
    expect((await stripe.subscriptions.retrieve("sub_123", { expand: ["latest_invoice"] })).object).toBe("subscription");
    const list = await stripe.subscriptions.list({ customer: "cus_123", status: "all", expand: ["data.latest_invoice"], limit: 100 });
    expect(list.object).toBe("list");
  });

  test("open and latest paid invoices of a subscription (grace period start)", async () => {
    expect((await client().invoices.list({ subscription: "sub_123", status: "open", limit: 100 })).object).toBe("list");
    expect((await client().invoices.list({ subscription: "sub_123", status: "paid", limit: 1 })).object).toBe("list");
  });

  test("price lookup by lookup key", async () => {
    const list = await client().prices.list({ lookup_keys: ["test_pro_monthly"], active: true, limit: 10 });
    expect(list.object).toBe("list");
  });

  test("bootstrap: meter, products, licensed and metered prices", async () => {
    // stripe-mock's fixtures never match our lookup keys or event name, so
    // bootstrap takes the create path for everything.
    const result = await bootstrapCatalog(client(), testConfig, {
      currency: "usd",
      plans: {
        pro: { productName: "Pro", unitAmount: 2900 },
        team: { productName: "Team", unitAmount: 7900 },
        fleet: { productName: "Fleet", unitAmount: 19900 },
      },
      overage: { productName: "Credits", unitAmount: 12, meterDisplayName: "Credits" },
    });
    expect(result.created.length).toBeGreaterThan(0);
  });

  test("an unknown parameter is rejected, so the checks above have teeth", async () => {
    await expect(
      client().checkout.sessions.create({ mode: "subscription", not_a_real_param: 1 } as never)
    ).rejects.toThrow(/additional properties/);
  });
});
