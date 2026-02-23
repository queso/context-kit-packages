import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { BillingProvider } from "../components/billing-provider";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const freePlan = { id: "free", name: "Free", isFree: true };
const proPlan = {
  id: "pro",
  name: "Pro",
  stripePriceIds: { monthly: "price_pro_monthly", yearly: "price_pro_yearly" },
};
const enterprisePlan = {
  id: "enterprise",
  name: "Enterprise",
  stripePriceIds: {
    monthly: "price_ent_monthly",
    yearly: "price_ent_yearly",
  },
};

const plans = [freePlan, proPlan, enterprisePlan];

const prices = {
  free: {},
  pro: { monthly: 19, yearly: 190, currency: "USD" },
  enterprise: { monthly: 49, yearly: 490, currency: "USD" },
};

const features = {
  free: ["5 projects", "Community support"],
  pro: ["Unlimited projects", "Priority support", "Analytics"],
  enterprise: ["Everything in Pro", "SLA", "Dedicated support"],
};

const mockSubscription = {
  id: "sub_1",
  customerId: "cus_1",
  stripeSubscriptionId: "stripe_sub_1",
  stripePriceId: "price_pro_monthly",
  planId: "pro",
  plan: proPlan,
  status: "active" as const,
  interval: "monthly",
  currentPeriodStart: new Date("2026-01-01"),
  currentPeriodEnd: new Date("2026-02-01"),
  cancelAtPeriodEnd: false,
};

// Wrapper that provides BillingProvider context
function makeWrapper(
  wrapperPlans = plans,
  subscription: typeof mockSubscription | null = null
) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <BillingProvider
        plans={wrapperPlans}
        currentSubscription={subscription ?? undefined}
        isAuthenticated={subscription != null}
      >
        {children}
      </BillingProvider>
    );
  };
}

// ---------------------------------------------------------------------------
// PricingTable
// ---------------------------------------------------------------------------

describe("PricingTable", () => {
  test("renders a card for each plan in context", async () => {
    const { PricingTable } = await import("../components/pricing-table");
    const Wrapper = await makeWrapper();
    const onSelectPlan = mock(() => {});

    render(
      <Wrapper>
        <PricingTable
          features={features}
          prices={prices}
          onSelectPlan={onSelectPlan}
        />
      </Wrapper>
    );

    expect(screen.getByText("Free")).toBeDefined();
    expect(screen.getByText("Pro")).toBeDefined();
    expect(screen.getByText("Enterprise")).toBeDefined();
  });

  test("shows IntervalToggle when plans have both monthly and yearly prices", async () => {
    const { PricingTable } = await import("../components/pricing-table");
    const Wrapper = await makeWrapper();
    const onSelectPlan = mock(() => {});

    render(
      <Wrapper>
        <PricingTable
          features={features}
          prices={prices}
          onSelectPlan={onSelectPlan}
        />
      </Wrapper>
    );

    // IntervalToggle renders a radiogroup with Monthly/Yearly
    expect(screen.getByRole("radiogroup")).toBeDefined();
    expect(screen.getByText(/monthly/i)).toBeDefined();
    expect(screen.getByText(/yearly/i)).toBeDefined();
  });

  test("hides IntervalToggle when no plans have both monthly and yearly prices", async () => {
    const { PricingTable } = await import("../components/pricing-table");
    // Only free plan — no monthly/yearly prices
    const Wrapper = await makeWrapper([freePlan]);
    const onSelectPlan = mock(() => {});

    render(
      <Wrapper>
        <PricingTable
          features={{ free: features.free }}
          prices={{ free: {} }}
          onSelectPlan={onSelectPlan}
        />
      </Wrapper>
    );

    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  test("highlights the correct card when highlighted prop matches a planId", async () => {
    const { PricingTable } = await import("../components/pricing-table");
    const Wrapper = await makeWrapper();
    const onSelectPlan = mock(() => {});

    render(
      <Wrapper>
        <PricingTable
          features={features}
          prices={prices}
          highlighted="pro"
          onSelectPlan={onSelectPlan}
        />
      </Wrapper>
    );

    // "Recommended" badge appears on highlighted card
    expect(screen.getByText(/recommended/i)).toBeDefined();
  });

  test("shows 'Current Plan' on the correct card for authenticated user", async () => {
    const { PricingTable } = await import("../components/pricing-table");
    const Wrapper = await makeWrapper(plans, mockSubscription);
    const onSelectPlan = mock(() => {});

    render(
      <Wrapper>
        <PricingTable
          features={features}
          prices={prices}
          onSelectPlan={onSelectPlan}
        />
      </Wrapper>
    );

    expect(screen.getByText(/current plan/i)).toBeDefined();
  });

  test("renders empty state message when no plans configured", async () => {
    const { PricingTable } = await import("../components/pricing-table");
    const Wrapper = await makeWrapper([]);
    const onSelectPlan = mock(() => {});

    render(
      <Wrapper>
        <PricingTable features={{}} prices={{}} onSelectPlan={onSelectPlan} />
      </Wrapper>
    );

    expect(screen.getByText(/no plans configured/i)).toBeDefined();
  });

  test("passes features to cards based on planId mapping", async () => {
    const { PricingTable } = await import("../components/pricing-table");
    const Wrapper = await makeWrapper();
    const onSelectPlan = mock(() => {});

    render(
      <Wrapper>
        <PricingTable
          features={features}
          prices={prices}
          onSelectPlan={onSelectPlan}
        />
      </Wrapper>
    );

    expect(screen.getByText("Unlimited projects")).toBeDefined();
    expect(screen.getByText("Community support")).toBeDefined();
    expect(screen.getByText("Dedicated support")).toBeDefined();
  });

  test("calls onSelectPlan when a plan CTA is clicked", async () => {
    const { PricingTable } = await import("../components/pricing-table");
    const Wrapper = await makeWrapper();
    const onSelectPlan = mock(() => {});

    render(
      <Wrapper>
        <PricingTable
          features={features}
          prices={prices}
          onSelectPlan={onSelectPlan}
        />
      </Wrapper>
    );

    // Click the first non-free CTA (Pro "Get Started")
    const buttons = screen.getAllByRole("button");
    const ctaButton = buttons.find(
      (b) => !b.hasAttribute("disabled") && b.textContent?.match(/get started/i)
    );
    expect(ctaButton).toBeDefined();
    if (ctaButton) fireEvent.click(ctaButton);

    expect(onSelectPlan).toHaveBeenCalled();
  });
});
