"use client";

import Link from "next/link";
import { cn } from "../lib/utils.js";
import type { CheckoutSuccessProps } from "../types.js";

export function CheckoutSuccess({
  redirectUrl,
  planName,
  className,
}: CheckoutSuccessProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-6 rounded-2xl border border-[var(--billing-success-border,#bbf7d0)] bg-[var(--billing-success-bg,#f0fdf4)] p-10 text-center",
        className
      )}
    >
      {/* Success icon */}
      <div
        className="flex h-16 w-16 items-center justify-center rounded-full bg-[var(--billing-success-icon-bg,#dcfce7)]"
        aria-hidden="true"
      >
        <svg
          className="h-8 w-8 text-[var(--billing-success-icon-color,#16a34a)]"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M4.5 12.75l6 6 9-13.5"
          />
        </svg>
      </div>

      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold text-[var(--billing-success-heading,#0f172a)]">
          Subscription Confirmed
        </h1>
        <p className="text-[var(--billing-success-text,#475569)]">
          {planName
            ? `You are now subscribed to ${planName}.`
            : "Your subscription is now active."}
        </p>
      </div>

      <Link
        href={redirectUrl}
        className="mt-2 rounded-lg bg-[var(--billing-cta-bg,#6366f1)] px-6 py-2.5 text-sm font-semibold text-[var(--billing-cta-text,#fff)] transition-colors hover:bg-[var(--billing-cta-hover-bg,#4f46e5)]"
      >
        Continue
      </Link>
    </div>
  );
}
