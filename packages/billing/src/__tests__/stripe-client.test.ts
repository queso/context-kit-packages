import { describe, test, expect } from "bun:test";
import Stripe from "stripe";
import { createStripeClient, STRIPE_API_VERSION } from "../stripe-client";

describe("createStripeClient", () => {
  test("pins the same API version as the installed stripe-node release", () => {
    // stripe-node's TypeScript types describe the version it pins. If a
    // stripe-node upgrade moves the pin, this fails until STRIPE_API_VERSION is
    // moved too, so the types and the requests never disagree.
    expect(STRIPE_API_VERSION).toBe(Stripe.API_VERSION);
    expect(STRIPE_API_VERSION).toBe("2026-10-28.endive");
  });

  test("sends the pinned version on every request", async () => {
    let versionHeader = null as string | null;
    const fetchFn = (async (_url: string, init: RequestInit) => {
      versionHeader = new Headers(init.headers).get("stripe-version");
      return new Response(JSON.stringify({ id: "cus_1", object: "customer" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const stripe = createStripeClient("sk_test_123", {
      httpClient: Stripe.createFetchHttpClient(fetchFn),
    });
    await stripe.customers.retrieve("cus_1");
    expect(versionHeader).toBe(STRIPE_API_VERSION);
  });

  test.each(["", "pk_test_123", "pk_live_123", "whsec_123"])(
    "refuses %p, which is not a secret or restricted key",
    (key) => {
      expect(() => createStripeClient(key)).toThrow(/secret or restricted key/);
    }
  );

  test.each(["sk_test_1", "rk_test_1", "sk_live_1", "rk_live_1"])("accepts %p", (key) => {
    expect(() => createStripeClient(key)).not.toThrow();
  });

  test("never puts the key in an error message", () => {
    try {
      createStripeClient("pk_live_supersecretvalue");
      throw new Error("expected a throw");
    } catch (err) {
      expect(String(err)).not.toContain("supersecretvalue");
    }
  });
});
