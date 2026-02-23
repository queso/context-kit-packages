"use client";

import {
  EmbeddedCheckoutProvider,
  EmbeddedCheckout as StripeEmbeddedCheckout,
} from "@stripe/react-stripe-js";
import { loadStripe } from "@stripe/stripe-js";
import { useEffect, useMemo, useState } from "react";
import { cn } from "../lib/utils.js";
import type { EmbeddedCheckoutProps } from "../types.js";

type CheckoutState =
  | { status: "loading" }
  | { status: "ready"; clientSecret: string }
  | { status: "error"; message: string };

export function EmbeddedCheckout({
  fetchClientSecret,
  stripePublishableKey,
  returnUrl,
  className,
}: EmbeddedCheckoutProps) {
  const [state, setState] = useState<CheckoutState>({ status: "loading" });
  const [retryKey, setRetryKey] = useState(0);

  // Memoize the Stripe promise — don't recreate on each render
  const stripePromise = useMemo(
    () => loadStripe(stripePublishableKey),
    [stripePublishableKey]
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: retryKey triggers re-fetch on retry
  useEffect(() => {
    setState({ status: "loading" });
    let cancelled = false;

    fetchClientSecret()
      .then((secret) => {
        if (!cancelled) {
          setState({ status: "ready", clientSecret: secret });
        }
      })
      .catch(() => {
        if (!cancelled) {
          const message = "Something went wrong. Please try again.";
          setState({ status: "error", message });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [fetchClientSecret, retryKey]);

  const handleRetry = () => {
    setRetryKey((k) => k + 1);
  };

  if (state.status === "error") {
    return (
      <div
        className={cn(
          "flex flex-col items-center gap-4 rounded-2xl border border-[var(--billing-checkout-error-border,#fecaca)] bg-[var(--billing-checkout-error-bg,#fff5f5)] p-8 text-center",
          className
        )}
        role="alert"
      >
        <p className="text-[var(--billing-checkout-error-text,#dc2626)]">
          {state.message}
        </p>
        <button
          type="button"
          onClick={handleRetry}
          className="rounded-lg bg-[var(--billing-cta-bg,#6366f1)] px-4 py-2 text-sm font-semibold text-[var(--billing-cta-text,#fff)] hover:bg-[var(--billing-cta-hover-bg,#4f46e5)]"
        >
          Try Again
        </button>
      </div>
    );
  }

  if (state.status === "loading") {
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded-2xl border border-[var(--billing-checkout-border,#e2e8f0)] bg-[var(--billing-checkout-bg,#fff)] p-8",
          className
        )}
        role="status"
        aria-busy="true"
      >
        <div className="animate-spin h-8 w-8 rounded-full border-4 border-[var(--billing-checkout-spinner-border,#e2e8f0)] border-t-[var(--billing-checkout-spinner-color,#6366f1)]" />
        <span className="sr-only">Loading checkout...</span>
      </div>
    );
  }

  // status === "ready"
  const options = {
    fetchClientSecret: () => Promise.resolve(state.clientSecret),
    ...(returnUrl ? { returnUrl } : {}),
  };

  return (
    <div
      className={cn(
        "rounded-2xl border border-[var(--billing-checkout-border,#e2e8f0)] bg-[var(--billing-checkout-bg,#fff)] p-4",
        className
      )}
    >
      <EmbeddedCheckoutProvider stripe={stripePromise} options={options}>
        <StripeEmbeddedCheckout />
      </EmbeddedCheckoutProvider>
    </div>
  );
}
