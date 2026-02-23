import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const proPlan = {
  id: "pro",
  name: "Pro",
  stripePriceIds: { monthly: "price_monthly", yearly: "price_yearly" },
};

const freePlan = {
  id: "free",
  name: "Free",
  isFree: true,
};

const features = ["Unlimited projects", "Priority support", "Analytics"];

// ---------------------------------------------------------------------------
// PricingCard
// ---------------------------------------------------------------------------

describe("PricingCard", () => {
  test("renders plan name, price, features, and CTA", async () => {
    const { PricingCard } = await import("../components/pricing-card");
    const onSelectPlan = mock(() => {});

    render(
      <PricingCard
        plan={proPlan}
        features={features}
        price={19}
        interval="monthly"
        onSelectPlan={onSelectPlan}
        isAuthenticated={false}
      />
    );

    expect(screen.getByText("Pro")).toBeDefined();
    expect(screen.getByText("Unlimited projects")).toBeDefined();
    expect(screen.getByText("Priority support")).toBeDefined();
    // CTA exists
    expect(screen.getByRole("button")).toBeDefined();
  });

  test("displays formatted price '$19/mo' for monthly interval", async () => {
    const { PricingCard } = await import("../components/pricing-card");

    render(
      <PricingCard
        plan={proPlan}
        price={19}
        interval="monthly"
        isAuthenticated={false}
      />
    );

    const text = screen.getByText(/\$19/);
    expect(text).toBeDefined();
    expect(text.textContent).toContain("/mo");
  });

  test("displays yearlyPrice with '/yr' suffix when interval is yearly", async () => {
    const { PricingCard } = await import("../components/pricing-card");

    render(
      <PricingCard
        plan={proPlan}
        price={19}
        yearlyPrice={190}
        interval="yearly"
        isAuthenticated={false}
      />
    );

    const text = screen.getByText(/\$190/);
    expect(text).toBeDefined();
    expect(text.textContent).toContain("/yr");
  });

  test("shows 'Current Plan' badge and disabled CTA when isCurrent", async () => {
    const { PricingCard } = await import("../components/pricing-card");

    render(
      <PricingCard
        plan={proPlan}
        price={19}
        interval="monthly"
        isCurrent={true}
        isAuthenticated={true}
      />
    );

    expect(screen.getByText(/current plan/i)).toBeDefined();
    const cta = screen.getByRole("button", { name: /current plan/i });
    expect(cta.hasAttribute("disabled")).toBe(true);
  });

  test("shows 'Recommended' badge when highlighted is true", async () => {
    const { PricingCard } = await import("../components/pricing-card");

    render(
      <PricingCard
        plan={proPlan}
        price={19}
        interval="monthly"
        highlighted={true}
        isAuthenticated={false}
      />
    );

    expect(screen.getByText(/recommended/i)).toBeDefined();
  });

  test("calls onSelectPlan with planId and interval on CTA click", async () => {
    const { PricingCard } = await import("../components/pricing-card");
    const onSelectPlan = mock(() => {});

    render(
      <PricingCard
        plan={proPlan}
        price={19}
        interval="monthly"
        onSelectPlan={onSelectPlan}
        isAuthenticated={true}
      />
    );

    const cta = screen.getByRole("button");
    fireEvent.click(cta);

    expect(onSelectPlan).toHaveBeenCalledWith("pro", "monthly");
  });

  test("free plan shows 'Free' with no interval suffix", async () => {
    const { PricingCard } = await import("../components/pricing-card");

    render(
      <PricingCard
        plan={freePlan}
        price={0}
        interval="monthly"
        isAuthenticated={false}
      />
    );

    // The heading shows the plan name "Free", AND the price area should
    // separately display "Free" instead of "$0/mo".  We expect at least two
    // distinct elements containing the text "Free" — one heading, one price.
    const freeElements = screen.getAllByText(/^free$/i);
    expect(freeElements.length).toBeGreaterThanOrEqual(2);

    // The price element must NOT include an interval suffix like "/mo" or "/yr"
    const priceEl = freeElements.find(
      (el) => el.tagName.toLowerCase() !== "h3"
    );
    expect(priceEl).toBeDefined();
    expect(priceEl!.textContent).not.toMatch(/\/mo|\/yr/i);
  });

  test("CTA shows 'Get Started' when not authenticated", async () => {
    const { PricingCard } = await import("../components/pricing-card");
    const onSelectPlan = mock(() => {});

    render(
      <PricingCard
        plan={proPlan}
        price={19}
        interval="monthly"
        onSelectPlan={onSelectPlan}
        isAuthenticated={false}
      />
    );

    expect(screen.getByText(/get started/i)).toBeDefined();
  });

  test("CTA shows 'Upgrade' when isUpgrade is true", async () => {
    const { PricingCard } = await import("../components/pricing-card");
    const onSelectPlan = mock(() => {});

    render(
      <PricingCard
        plan={proPlan}
        price={19}
        interval="monthly"
        onSelectPlan={onSelectPlan}
        isAuthenticated={true}
        isUpgrade={true}
      />
    );

    expect(screen.getByText(/upgrade/i)).toBeDefined();
  });

  test("CTA shows 'Downgrade' when isDowngrade is true", async () => {
    const { PricingCard } = await import("../components/pricing-card");
    const onSelectPlan = mock(() => {});

    render(
      <PricingCard
        plan={proPlan}
        price={19}
        interval="monthly"
        onSelectPlan={onSelectPlan}
        isAuthenticated={true}
        isDowngrade={true}
      />
    );

    expect(screen.getByText(/downgrade/i)).toBeDefined();
  });

  test("renders plan name as an h3 heading", async () => {
    const { PricingCard } = await import("../components/pricing-card");

    render(
      <PricingCard
        plan={proPlan}
        price={19}
        interval="monthly"
        isAuthenticated={false}
      />
    );

    expect(
      screen.getByRole("heading", { level: 3, name: /pro/i })
    ).toBeDefined();
  });

  test("feature list uses semantic ul/li elements", async () => {
    const { PricingCard } = await import("../components/pricing-card");

    const { container } = render(
      <PricingCard
        plan={proPlan}
        features={features}
        price={19}
        interval="monthly"
        isAuthenticated={false}
      />
    );

    expect(container.querySelector("ul")).toBeDefined();
    const listItems = container.querySelectorAll("li");
    expect(listItems.length).toBeGreaterThanOrEqual(features.length);
  });

  test("accepts className prop", async () => {
    const { PricingCard } = await import("../components/pricing-card");

    const { container } = render(
      <PricingCard
        plan={proPlan}
        price={19}
        interval="monthly"
        isAuthenticated={false}
        className="custom-card"
      />
    );

    expect(container.firstElementChild?.className).toContain("custom-card");
  });
});
