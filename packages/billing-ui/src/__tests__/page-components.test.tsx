import { describe, expect, mock, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import type React from "react";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("@stripe/react-stripe-js", () => ({
  EmbeddedCheckoutProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="stripe-provider">{children}</div>
  ),
  EmbeddedCheckout: () => (
    <div data-testid="stripe-embedded-checkout">Stripe Checkout Form</div>
  ),
}));

mock.module("@stripe/stripe-js", () => ({
  loadStripe: mock(() => Promise.resolve({})),
}));

mock.module("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const freePlan = { id: "free", name: "Free", isFree: true };
const proPlan = {
  id: "pro",
  name: "Pro",
  stripePriceIds: { monthly: "price_pro_monthly", yearly: "price_pro_yearly" },
};
const plans = [freePlan, proPlan];

const prices = {
  free: {},
  pro: { monthly: 19, yearly: 190, currency: "USD" },
};

const features = {
  free: ["5 projects"],
  pro: ["Unlimited projects", "Priority support"],
};

// ---------------------------------------------------------------------------
// PricingPage
// ---------------------------------------------------------------------------

describe("PricingPage", () => {
  test("renders plan names given plans + features + prices + onSelectPlan", async () => {
    const { PricingPage } = await import("../components/pages/pricing-page");
    const onSelectPlan = mock(() => {});

    render(
      <PricingPage
        plans={plans}
        features={features}
        prices={prices}
        onSelectPlan={onSelectPlan}
      />
    );

    expect(screen.getByText("Free")).toBeDefined();
    expect(screen.getByText("Pro")).toBeDefined();
  });

  test("does not accept BillingInstance or userId props (serialized data only)", async () => {
    const { resolve } = await import("node:path");
    const source = await Bun.file(
      resolve(import.meta.dir, "../components/pages/pricing-page.tsx")
    ).text();
    expect(source).not.toContain("BillingInstance");
    expect(source).not.toContain("userId");
  });

  test("accepts className prop on outer container", async () => {
    const { PricingPage } = await import("../components/pages/pricing-page");
    const onSelectPlan = mock(() => {});

    const { container } = render(
      <PricingPage
        plans={plans}
        features={features}
        prices={prices}
        onSelectPlan={onSelectPlan}
        className="pricing-page-custom"
      />
    );

    expect(container.querySelector(".pricing-page-custom")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CheckoutPage
// ---------------------------------------------------------------------------

describe("CheckoutPage", () => {
  test("renders with fetchClientSecret + stripePublishableKey props", async () => {
    const { CheckoutPage } = await import("../components/pages/checkout-page");

    const fetchClientSecret = () => new Promise<string>(() => {});

    const { container } = render(
      <CheckoutPage
        fetchClientSecret={fetchClientSecret}
        stripePublishableKey="pk_test_123"
      />
    );

    // Component renders without throwing
    expect(container.firstElementChild).not.toBeNull();
  });

  test("does not accept planId or interval props (fetchClientSecret pattern only)", async () => {
    const { resolve } = await import("node:path");
    const source = await Bun.file(
      resolve(import.meta.dir, "../components/pages/checkout-page.tsx")
    ).text();
    expect(source).toContain("fetchClientSecret");
    expect(source).toContain("stripePublishableKey");
    expect(source).not.toContain("planId");
  });

  test("accepts className prop on outer container", async () => {
    const { CheckoutPage } = await import("../components/pages/checkout-page");

    const fetchClientSecret = () => new Promise<string>(() => {});

    const { container } = render(
      <CheckoutPage
        fetchClientSecret={fetchClientSecret}
        stripePublishableKey="pk_test_123"
        className="checkout-page-custom"
      />
    );

    expect(container.querySelector(".checkout-page-custom")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CheckoutSuccessPage
// ---------------------------------------------------------------------------

describe("CheckoutSuccessPage", () => {
  test("renders success heading and CTA linking to redirectUrl", async () => {
    const { CheckoutSuccessPage } = await import(
      "../components/pages/checkout-success-page"
    );

    render(<CheckoutSuccessPage redirectUrl="/dashboard" />);

    const heading = screen.getByRole("heading");
    expect(heading).toBeDefined();
    expect(heading.textContent?.toLowerCase()).toMatch(
      /subscri|success|confirm/i
    );

    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/dashboard");
  });

  test("shows planName in message when provided", async () => {
    const { CheckoutSuccessPage } = await import(
      "../components/pages/checkout-success-page"
    );

    render(<CheckoutSuccessPage redirectUrl="/dashboard" planName="Pro" />);

    expect(document.body.textContent).toContain("Pro");
  });

  test("accepts className prop on outer container", async () => {
    const { CheckoutSuccessPage } = await import(
      "../components/pages/checkout-success-page"
    );

    const { container } = render(
      <CheckoutSuccessPage
        redirectUrl="/dashboard"
        className="success-page-custom"
      />
    );

    expect(container.querySelector(".success-page-custom")).not.toBeNull();
  });
});
