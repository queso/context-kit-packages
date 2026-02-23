"use client";

import type { PlanDefinition } from "@context-kit/billing";
import { useContext } from "react";
import { cn } from "../lib/utils.js";
import type { PricingTableProps } from "../types.js";
import { BillingUIContext } from "./billing-provider.js";
import { IntervalToggle } from "./interval-toggle.js";
import { PricingCard } from "./pricing-card.js";

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function PricingTable({
  features,
  prices,
  highlighted,
  onSelectPlan,
  signInPath,
  className,
}: PricingTableProps) {
  const ctx = useContext(BillingUIContext);

  // Derive plans: use context if available, otherwise derive from prices keys
  const plans: PlanDefinition[] = ctx?.plans.length
    ? ctx.plans
    : Object.keys(prices).map((id) => ({ id, name: capitalize(id) }));

  const currentPlan = ctx?.currentPlan ?? null;
  const interval = ctx?.interval ?? "monthly";
  const setIntervalFn = ctx?.setInterval ?? (() => {});
  const isAuthenticated = ctx?.isAuthenticated ?? false;

  // Show IntervalToggle only when at least one plan has both monthly and yearly prices
  const hasIntervalPricing = plans.some((plan) => {
    const p = prices[plan.id];
    return p?.monthly != null && p?.yearly != null;
  });

  // Calculate savings percentage from first plan that has both monthly and yearly
  const savingsPlan = plans.find((plan) => {
    const p = prices[plan.id];
    return p?.monthly != null && p?.yearly != null;
  });
  const savingsPercentage = savingsPlan
    ? Math.round(
        ((prices[savingsPlan.id].monthly! * 12 -
          prices[savingsPlan.id].yearly!) /
          (prices[savingsPlan.id].monthly! * 12)) *
          100
      )
    : 0;

  if (plans.length === 0) {
    return (
      <div
        className={cn(
          "text-center text-[var(--billing-empty-text,#64748b)]",
          className
        )}
      >
        No plans configured. Add plans to your billing config.
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-8", className)}>
      {hasIntervalPricing && (
        <div className="flex justify-center">
          <IntervalToggle
            interval={interval}
            onIntervalChange={setIntervalFn}
            savingsPercentage={savingsPercentage}
          />
        </div>
      )}

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {plans.map((plan, idx) => {
          const planPrices = prices[plan.id] ?? {};
          const price = planPrices.monthly ?? 0;
          const yearlyPrice = planPrices.yearly;
          const currency = planPrices.currency;
          const planFeatures = features[plan.id];
          const isCurrent = currentPlan?.id === plan.id;
          const isHighlighted = highlighted === plan.id;
          const currentPlanOrder =
            currentPlan != null
              ? plans.findIndex((p) => p.id === currentPlan.id)
              : undefined;

          return (
            <PricingCard
              key={plan.id}
              plan={plan}
              features={planFeatures}
              price={price}
              yearlyPrice={yearlyPrice}
              currency={currency}
              highlighted={isHighlighted}
              isCurrent={isCurrent}
              interval={interval}
              onSelectPlan={onSelectPlan}
              signInPath={signInPath}
              isAuthenticated={isAuthenticated}
              currentPlanOrder={
                currentPlanOrder !== undefined && currentPlanOrder >= 0
                  ? currentPlanOrder
                  : undefined
              }
              planOrder={idx}
            />
          );
        })}
      </div>
    </div>
  );
}
