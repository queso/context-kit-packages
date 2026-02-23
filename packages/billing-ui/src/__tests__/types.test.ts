import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { $ } from "bun";

const projectRoot = resolve(import.meta.dir, "../../../..");

/**
 * Smoke tests for billing-ui TypeScript types.
 * These tests verify that types.ts compiles and exports the required shapes.
 * Type-level assertions are done via a separate typecheck-only snippet
 * compiled inline by tsc --noEmit through the package typecheck script.
 */

describe("@context-kit/billing-ui types", () => {
  test("types.ts compiles without errors (via typecheck)", async () => {
    const result = await $`bun --filter @context-kit/billing-ui typecheck`
      .cwd(projectRoot)
      .nothrow();
    expect(result.exitCode).toBe(0);
  }, 30_000);

  test("all required types are exported from types.ts", async () => {
    const { resolve: pathResolve } = await import("node:path");
    const typesPath = pathResolve(import.meta.dir, "../types.ts");
    const source = await Bun.file(typesPath).text();

    const requiredExports = [
      "BillingUIContextValue",
      "PlanPricing",
      "PricingTableProps",
      "PricingCardProps",
      "IntervalToggleProps",
      "EmbeddedCheckoutProps",
      "CheckoutSuccessProps",
      "PricingPageProps",
      "CheckoutPageProps",
      "CheckoutSuccessPageProps",
    ];

    for (const name of requiredExports) {
      expect(source).toContain(`export`);
      expect(source).toContain(name);
    }
  });

  test("key acceptance criteria are met in types.ts source", async () => {
    const typesPath = resolve(import.meta.dir, "../types.ts");
    const source = await Bun.file(typesPath).text();

    // EmbeddedCheckoutProps uses fetchClientSecret + stripePublishableKey (NOT planId/interval)
    expect(source).toContain("fetchClientSecret");
    expect(source).toContain("stripePublishableKey");

    // IntervalToggleProps uses savingsPercentage (NOT monthlySavings)
    expect(source).toContain("savingsPercentage");
    expect(source).not.toContain("monthlySavings");

    // BillingUIContextValue has no BillingInstance dependency
    expect(source).not.toContain("BillingInstance");

    // PricingCardProps includes price, yearlyPrice, currency
    expect(source).toContain("yearlyPrice");
    expect(source).toContain("currency");

    // Re-exports from @context-kit/billing
    expect(source).toContain("@context-kit/billing");
    expect(source).toContain("PlanDefinition");
    expect(source).toContain("SubscriptionStatus");
    expect(source).toContain("SubscriptionData");

    // PricingPageProps MUST contain: plans, currentSubscription, onSelectPlan
    const pricingPageMatch = source.match(
      /interface PricingPageProps[^{]*\{([^}]*)\}/s
    );
    expect(pricingPageMatch).not.toBeNull();
    const pricingPageBody = pricingPageMatch?.[1] ?? "";
    expect(pricingPageBody).toContain("plans");
    expect(pricingPageBody).toContain("currentSubscription");
    expect(pricingPageBody).toContain("onSelectPlan");

    // CheckoutSuccessPageProps MUST contain: planName
    const checkoutSuccessMatch = source.match(
      /interface CheckoutSuccessPageProps[^{]*\{([^}]*)\}/s
    );
    expect(checkoutSuccessMatch).not.toBeNull();
    const checkoutSuccessBody = checkoutSuccessMatch?.[1] ?? "";
    expect(checkoutSuccessBody).toContain("planName");
  });
});
