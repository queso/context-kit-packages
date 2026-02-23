"use client";

import { cn } from "../lib/utils.js";
import type { PricingCardProps } from "../types.js";

function formatPrice(amount: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

function getCTALabel({
  isCurrent,
  isAuthenticated,
  planOrder,
  currentPlanOrder,
}: {
  isCurrent?: boolean;
  isAuthenticated?: boolean;
  planOrder?: number;
  currentPlanOrder?: number;
}): string {
  if (isCurrent) return "Current Plan";
  if (!isAuthenticated) return "Get Started";
  if (planOrder !== undefined && currentPlanOrder !== undefined) {
    if (planOrder > currentPlanOrder) return "Upgrade";
    if (planOrder < currentPlanOrder) return "Downgrade";
  }
  return "Select Plan";
}

export function PricingCard({
  plan,
  features,
  price,
  yearlyPrice,
  currency = "USD",
  highlighted,
  isCurrent,
  interval,
  onSelectPlan,
  signInPath,
  isAuthenticated,
  currentPlanOrder,
  planOrder,
  className,
}: PricingCardProps) {
  const isFree = plan.isFree || price === 0;

  const displayedPrice =
    interval === "yearly" && yearlyPrice != null ? yearlyPrice : price;
  const suffix = interval === "yearly" ? "/yr" : "/mo";

  const ctaLabel = getCTALabel({
    isCurrent,
    isAuthenticated,
    planOrder,
    currentPlanOrder,
  });

  const handleCTAClick = () => {
    if (isCurrent) return;
    onSelectPlan?.(plan.id, interval);
  };

  return (
    <div
      className={cn(
        "relative flex flex-col rounded-2xl border border-[var(--billing-card-border,#e2e8f0)] bg-[var(--billing-card-bg,#fff)] p-6 shadow-sm",
        highlighted &&
          "border-[var(--billing-card-highlighted-border,#6366f1)] ring-2 ring-[var(--billing-card-highlighted-ring,#6366f1)]",
        className
      )}
    >
      {highlighted && (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-[var(--billing-recommended-bg,#6366f1)] px-3 py-1 text-xs font-semibold text-[var(--billing-recommended-text,#fff)]">
          Recommended
        </span>
      )}

      <h3 className="text-lg font-semibold text-[var(--billing-card-heading,#0f172a)]">
        {plan.name}
      </h3>

      <div className="mt-4 mb-6">
        {isFree ? (
          <span className="text-4xl font-bold text-[var(--billing-card-price,#0f172a)]">
            FREE
          </span>
        ) : (
          <span className="text-4xl font-bold text-[var(--billing-card-price,#0f172a)]">
            {formatPrice(displayedPrice, currency)}
            <span className="text-base font-normal text-[var(--billing-card-price-suffix,#64748b)]">
              {suffix}
            </span>
          </span>
        )}
      </div>

      {features && features.length > 0 && (
        <ul className="mb-6 flex flex-col gap-2">
          {features.map((feature) => (
            <li
              key={feature}
              className="flex items-center gap-2 text-sm text-[var(--billing-card-feature,#475569)]"
            >
              <span aria-hidden="true">✓</span>
              {feature}
            </li>
          ))}
        </ul>
      )}

      {!isAuthenticated && signInPath ? (
        <a
          href={signInPath}
          className="mt-auto block rounded-lg bg-[var(--billing-cta-bg,#6366f1)] px-4 py-2.5 text-center text-sm font-semibold text-[var(--billing-cta-text,#fff)] transition-colors hover:bg-[var(--billing-cta-hover-bg,#4f46e5)]"
        >
          {ctaLabel}
        </a>
      ) : (
        <button
          type="button"
          disabled={isCurrent}
          onClick={handleCTAClick}
          className={cn(
            "mt-auto rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors",
            isCurrent
              ? "cursor-not-allowed bg-[var(--billing-cta-disabled-bg,#f1f5f9)] text-[var(--billing-cta-disabled-text,#94a3b8)]"
              : "bg-[var(--billing-cta-bg,#6366f1)] text-[var(--billing-cta-text,#fff)] hover:bg-[var(--billing-cta-hover-bg,#4f46e5)]"
          )}
        >
          {ctaLabel}
        </button>
      )}
    </div>
  );
}
