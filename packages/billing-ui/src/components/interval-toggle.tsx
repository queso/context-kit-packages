"use client";

import { cn } from "../lib/utils.js";
import type { IntervalToggleProps } from "../types.js";

export function IntervalToggle({
  interval,
  onIntervalChange,
  savingsPercentage,
  className,
}: IntervalToggleProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Billing interval"
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-[var(--billing-toggle-border,#e2e8f0)] bg-[var(--billing-toggle-bg,#f8fafc)] p-1",
        className
      )}
    >
      <button
        role="radio"
        aria-checked={interval === "monthly"}
        onClick={() => onIntervalChange("monthly")}
        className={cn(
          "rounded-full px-4 py-1.5 text-sm font-medium transition-colors",
          interval === "monthly"
            ? "bg-[var(--billing-toggle-active-bg,#fff)] text-[var(--billing-toggle-active-text,#0f172a)] shadow-sm"
            : "text-[var(--billing-toggle-text,#64748b)] hover:text-[var(--billing-toggle-hover-text,#0f172a)]"
        )}
        type="button"
      >
        Monthly
      </button>
      <button
        role="radio"
        aria-checked={interval === "yearly"}
        onClick={() => onIntervalChange("yearly")}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-medium transition-colors",
          interval === "yearly"
            ? "bg-[var(--billing-toggle-active-bg,#fff)] text-[var(--billing-toggle-active-text,#0f172a)] shadow-sm"
            : "text-[var(--billing-toggle-text,#64748b)] hover:text-[var(--billing-toggle-hover-text,#0f172a)]"
        )}
        type="button"
      >
        Yearly
        {savingsPercentage != null && savingsPercentage > 0 && (
          <span className="rounded-full bg-[var(--billing-savings-bg,#dcfce7)] px-1.5 py-0.5 text-xs font-semibold text-[var(--billing-savings-text,#166534)]">
            Save {savingsPercentage}%
          </span>
        )}
      </button>
    </div>
  );
}
