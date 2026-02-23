"use client";

import { useContext } from "react";
import { BillingUIContext } from "../components/billing-provider.js";
import type { BillingUIContextValue } from "../types.js";

export function useBilling(): BillingUIContextValue {
  const ctx = useContext(BillingUIContext);
  if (!ctx) {
    throw new Error(
      "useBilling must be used within a BillingProvider. " +
        "Wrap your component tree with <BillingProvider>."
    );
  }
  return ctx;
}
