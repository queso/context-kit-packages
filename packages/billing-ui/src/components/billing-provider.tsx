"use client";

import type {
  PlanDefinition,
  SubscriptionData,
  SubscriptionStatus,
} from "@context-kit/billing";
import type React from "react";
import { createContext, useMemo, useState } from "react";
import type { BillingUIContextValue } from "../types.js";

export const BillingUIContext = createContext<BillingUIContextValue | null>(
  null
);

export interface BillingProviderProps {
  plans: PlanDefinition[];
  currentSubscription?: SubscriptionData | null;
  isAuthenticated: boolean;
  children: React.ReactNode;
}

export function BillingProvider({
  plans,
  currentSubscription,
  isAuthenticated,
  children,
}: BillingProviderProps) {
  const [interval, setInterval] = useState<"monthly" | "yearly">("monthly");

  const value = useMemo<BillingUIContextValue>(() => {
    const currentPlan = currentSubscription
      ? (plans.find((p) => p.id === currentSubscription.planId) ?? null)
      : null;

    const subscriptionStatus: SubscriptionStatus | null =
      currentSubscription?.status ?? null;

    return {
      plans,
      currentPlan,
      currentSubscription: currentSubscription ?? null,
      subscriptionStatus,
      interval,
      setInterval,
      isLoading: false,
      isAuthenticated,
    };
  }, [plans, currentSubscription, isAuthenticated, interval]);

  return (
    <BillingUIContext.Provider value={value}>
      {children}
    </BillingUIContext.Provider>
  );
}
