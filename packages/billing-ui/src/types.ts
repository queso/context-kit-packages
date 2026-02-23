// Re-exports from @context-kit/billing
export type {
  PlanDefinition,
  SubscriptionData,
  SubscriptionStatus,
} from "@context-kit/billing";

import type {
  PlanDefinition,
  SubscriptionData,
  SubscriptionStatus,
} from "@context-kit/billing";

// ─── Context ──────────────────────────────────────────────────────────────────

export interface BillingUIContextValue {
  plans: PlanDefinition[];
  currentPlan: PlanDefinition | null;
  currentSubscription: SubscriptionData | null;
  subscriptionStatus: SubscriptionStatus | null;
  interval: "monthly" | "yearly";
  setInterval: (interval: "monthly" | "yearly") => void;
  /** Always `false` — data is pre-fetched via props, not loaded client-side. */
  isLoading: boolean;
  isAuthenticated: boolean;
}

// ─── Pricing ──────────────────────────────────────────────────────────────────

export type PlanPricing = Record<
  string,
  { monthly?: number; yearly?: number; currency?: string }
>;

export interface PricingTableProps {
  features: Record<string, string[]>;
  prices: PlanPricing;
  highlighted?: string;
  onSelectPlan: (planId: string, interval: "monthly" | "yearly") => void;
  signInPath?: string;
  className?: string;
}

export interface PricingCardProps {
  plan: PlanDefinition;
  features?: string[];
  price: number;
  yearlyPrice?: number;
  currency?: string;
  highlighted?: boolean;
  isCurrent?: boolean;
  interval: "monthly" | "yearly";
  onSelectPlan?: (planId: string, interval: "monthly" | "yearly") => void;
  signInPath?: string;
  isAuthenticated?: boolean;
  /** Whether selecting this plan is an upgrade from the current plan. */
  isUpgrade?: boolean;
  /** Whether selecting this plan is a downgrade from the current plan. */
  isDowngrade?: boolean;
  className?: string;
}

export interface IntervalToggleProps {
  interval: "monthly" | "yearly";
  onIntervalChange: (interval: "monthly" | "yearly") => void;
  savingsPercentage?: number;
  className?: string;
}

// ─── Checkout ─────────────────────────────────────────────────────────────────

export interface EmbeddedCheckoutProps {
  fetchClientSecret: () => Promise<string>;
  stripePublishableKey: string;
  returnUrl?: string;
  className?: string;
}

export interface CheckoutSuccessProps {
  redirectUrl: string;
  planName?: string;
  className?: string;
}

// ─── Page-level ───────────────────────────────────────────────────────────────

export interface PricingPageProps {
  plans: PlanDefinition[];
  currentSubscription?: SubscriptionData | null;
  isAuthenticated?: boolean;
  features: Record<string, string[]>;
  prices: PlanPricing;
  onSelectPlan: (planId: string, interval: "monthly" | "yearly") => void;
  highlighted?: string;
  signInPath?: string;
  className?: string;
}

export interface CheckoutPageProps {
  fetchClientSecret: () => Promise<string>;
  stripePublishableKey: string;
  returnUrl?: string;
  className?: string;
}

export interface CheckoutSuccessPageProps {
  redirectUrl: string;
  planName?: string;
  className?: string;
}
