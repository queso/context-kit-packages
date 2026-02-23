import { describe, expect, test } from "bun:test";
import { act, render, renderHook, screen } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const freePlan = {
  id: "free",
  name: "Free",
  isFree: true,
};

const proPlan = {
  id: "pro",
  name: "Pro",
  stripePriceIds: { monthly: "price_monthly", yearly: "price_yearly" },
};

const plans = [freePlan, proPlan];

const mockSubscription = {
  id: "sub_1",
  customerId: "cus_1",
  stripeSubscriptionId: "stripe_sub_1",
  stripePriceId: "price_monthly",
  planId: "pro",
  plan: proPlan,
  status: "active" as const,
  interval: "monthly",
  currentPeriodStart: new Date("2026-01-01"),
  currentPeriodEnd: new Date("2026-02-01"),
  cancelAtPeriodEnd: false,
};

// ---------------------------------------------------------------------------
// BillingProvider
// ---------------------------------------------------------------------------

describe("BillingProvider", () => {
  test("renders children without error when no currentSubscription", async () => {
    const { BillingProvider } = await import("../components/billing-provider");
    render(
      <BillingProvider plans={plans} isAuthenticated={false}>
        <div>billing child</div>
      </BillingProvider>
    );
    expect(screen.getByText("billing child")).toBeDefined();
  });

  test("derives currentPlan from currentSubscription.planId", async () => {
    const { BillingProvider } = await import("../components/billing-provider");
    const { useBilling } = await import("../hooks/use-billing");

    const { result } = renderHook(() => useBilling(), {
      wrapper: ({ children }) => (
        <BillingProvider
          plans={plans}
          currentSubscription={mockSubscription}
          isAuthenticated={true}
        >
          {children}
        </BillingProvider>
      ),
    });

    expect(result.current.currentPlan?.id).toBe("pro");
    expect(result.current.currentPlan?.name).toBe("Pro");
  });

  test("sets subscriptionStatus from currentSubscription.status", async () => {
    const { BillingProvider } = await import("../components/billing-provider");
    const { useBilling } = await import("../hooks/use-billing");

    const { result } = renderHook(() => useBilling(), {
      wrapper: ({ children }) => (
        <BillingProvider
          plans={plans}
          currentSubscription={mockSubscription}
          isAuthenticated={true}
        >
          {children}
        </BillingProvider>
      ),
    });

    expect(result.current.subscriptionStatus).toBe("active");
  });

  test("isAuthenticated is true when isAuthenticated prop is true", async () => {
    const { BillingProvider } = await import("../components/billing-provider");
    const { useBilling } = await import("../hooks/use-billing");

    const { result } = renderHook(() => useBilling(), {
      wrapper: ({ children }) => (
        <BillingProvider
          plans={plans}
          currentSubscription={mockSubscription}
          isAuthenticated={true}
        >
          {children}
        </BillingProvider>
      ),
    });

    expect(result.current.isAuthenticated).toBe(true);
  });

  test("isAuthenticated is false when isAuthenticated prop is false", async () => {
    const { BillingProvider } = await import("../components/billing-provider");
    const { useBilling } = await import("../hooks/use-billing");

    const { result } = renderHook(() => useBilling(), {
      wrapper: ({ children }) => (
        <BillingProvider plans={plans} isAuthenticated={false}>
          {children}
        </BillingProvider>
      ),
    });

    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.currentPlan).toBeNull();
    expect(result.current.subscriptionStatus).toBeNull();
  });

  test("interval defaults to 'monthly' and toggles via setInterval", async () => {
    const { BillingProvider } = await import("../components/billing-provider");
    const { useBilling } = await import("../hooks/use-billing");

    const { result } = renderHook(() => useBilling(), {
      wrapper: ({ children }) => (
        <BillingProvider plans={plans} isAuthenticated={false}>
          {children}
        </BillingProvider>
      ),
    });

    expect(result.current.interval).toBe("monthly");

    act(() => {
      result.current.setInterval("yearly");
    });

    expect(result.current.interval).toBe("yearly");
  });
});

// ---------------------------------------------------------------------------
// useBilling hook
// ---------------------------------------------------------------------------

describe("useBilling hook", () => {
  test("throws descriptive error when used outside BillingProvider", async () => {
    const { useBilling } = await import("../hooks/use-billing");

    const originalError = console.error;
    console.error = () => {};

    expect(() => {
      renderHook(() => useBilling());
    }).toThrow(/BillingProvider/i);

    console.error = originalError;
  });

  test("returns context value with plans array when inside provider", async () => {
    const { BillingProvider } = await import("../components/billing-provider");
    const { useBilling } = await import("../hooks/use-billing");

    const { result } = renderHook(() => useBilling(), {
      wrapper: ({ children }) => (
        <BillingProvider plans={plans} isAuthenticated={false}>
          {children}
        </BillingProvider>
      ),
    });

    expect(result.current.plans).toHaveLength(2);
    expect(result.current.plans[0].id).toBe("free");
    expect(result.current.plans[1].id).toBe("pro");
  });

  test("isLoading is false (data is pre-fetched via props)", async () => {
    const { BillingProvider } = await import("../components/billing-provider");
    const { useBilling } = await import("../hooks/use-billing");

    const { result } = renderHook(() => useBilling(), {
      wrapper: ({ children }) => (
        <BillingProvider plans={plans} isAuthenticated={false}>
          {children}
        </BillingProvider>
      ),
    });

    expect(result.current.isLoading).toBe(false);
  });
});
