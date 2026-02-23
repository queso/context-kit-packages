/**
 * Core types and error classes for @context-kit/billing.
 */

// ─── Error Classes ────────────────────────────────────────────────────────────

/**
 * Base error class for all billing-related errors.
 *
 * @example
 * ```ts
 * try {
 *   await billing.createCheckoutSession(params);
 * } catch (err) {
 *   if (err instanceof BillingError) {
 *     console.error("Billing error:", err.message);
 *   }
 * }
 * ```
 */
export class BillingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a usage cap is exceeded and `soft` mode is not enabled.
 *
 * @example
 * ```ts
 * try {
 *   await billing.recordUsage(userId, "api_calls", 1);
 * } catch (err) {
 *   if (err instanceof UsageCapExceededError) {
 *     console.log(`Used: ${err.used}, Limit: ${err.limit}`);
 *   }
 * }
 * ```
 */
export class UsageCapExceededError extends BillingError {
  used: number;
  limit: number;

  constructor(message: string, { used, limit }: { used: number; limit: number }) {
    super(message);
    this.name = "UsageCapExceededError";
    this.used = used;
    this.limit = limit;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the billing configuration is invalid (e.g., missing plans or keys).
 *
 * @example
 * ```ts
 * try {
 *   const billing = createBilling(config);
 * } catch (err) {
 *   if (err instanceof InvalidConfigError) {
 *     console.error("Fix your billing config:", err.message);
 *   }
 * }
 * ```
 */
export class InvalidConfigError extends BillingError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidConfigError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when webhook signature verification fails.
 *
 * @example
 * ```ts
 * try {
 *   const response = await webhookHandler(req);
 * } catch (err) {
 *   if (err instanceof WebhookVerificationError) {
 *     console.error("Invalid webhook signature:", err.message);
 *   }
 * }
 * ```
 */
export class WebhookVerificationError extends BillingError {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when an operation is invalid for the current subscription state
 * (e.g., canceling an already-canceled subscription, changing plans while past due).
 *
 * @example
 * ```ts
 * try {
 *   await billing.changePlan(userId, { planId: "pro" });
 * } catch (err) {
 *   if (err instanceof SubscriptionStateError) {
 *     console.error("Invalid subscription state:", err.message);
 *   }
 * }
 * ```
 */
export class SubscriptionStateError extends BillingError {
  constructor(message: string) {
    super(message);
    this.name = "SubscriptionStateError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─── Domain Types ─────────────────────────────────────────────────────────────

export type SubscriptionStatus =
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "trialing"
  | "incomplete"
  | "incomplete_expired"
  | "paused";

export interface PlanDefinition {
  /** Unique plan identifier slug (matches planId stored in Subscription). */
  id: string;
  /** Human-readable plan name. */
  name: string;
  /** Single Stripe Price ID (for plans with one price). */
  stripePriceId?: string;
  /** Per-interval Stripe Price IDs (for plans with monthly/yearly pricing). */
  stripePriceIds?: {
    monthly?: string;
    yearly?: string;
  };
  /** Per-feature usage caps for this plan. */
  usageCaps?: Record<string, number>;
  /** Maximum number of seats for this plan. */
  seatLimit?: number;
  /** Whether this is a free plan (no Stripe subscription created). */
  isFree?: boolean;
}

export interface FreeTierConfig {
  /** Plan ID used for free-tier users. */
  planId: string;
  /** Human-readable name for the free tier. */
  name: string;
  /** Per-feature usage caps for the free tier. */
  usageCaps?: Record<string, number>;
}

export interface BillingConfig {
  /** Your Prisma client instance. */
  prisma: unknown;
  /** Stripe secret key. Reads from STRIPE_SECRET_KEY env var if omitted. */
  stripeSecretKey?: string;
  /** Stripe webhook signing secret. Reads from STRIPE_WEBHOOK_SECRET env var if omitted. */
  stripeWebhookSecret?: string;
  /** Plan definitions available in your application. */
  plans: PlanDefinition[];
  /** Optional free-tier config applied when no paid subscription exists. */
  freeTier?: FreeTierConfig;
}

export interface SubscriptionData {
  id: string;
  customerId: string;
  stripeSubscriptionId: string | null;
  stripePriceId: string | null;
  planId: string;
  plan: PlanDefinition;
  status: SubscriptionStatus;
  interval: string | null;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
}

export interface UsageResult {
  used: number;
  limit: number | null;
  remaining: number | null;
  allowed: boolean;
}

export interface CheckoutSessionParams {
  userId: string;
  planId: string;
  /** URL to redirect to on successful checkout. */
  successUrl: string;
  /** URL to redirect to when checkout is cancelled. */
  cancelUrl: string;
}

export interface CancelParams {
  /** If true, cancel immediately rather than at period end. */
  immediate?: boolean;
}

export interface ChangePlanParams {
  planId: string;
  /** Whether to prorate the change. Defaults to true. */
  prorate?: boolean;
}

export interface PlanWithPeriod extends PlanDefinition {
  currentPeriodStart?: Date;
  currentPeriodEnd?: Date;
}

export interface BillingInstance {
  getSubscription(userId: string): Promise<SubscriptionData | null>;
  getPlan(planId: string): PlanDefinition;
  checkUsage(userId: string, metric: string): Promise<UsageResult>;
  recordUsage(userId: string, metric: string, amount: number): Promise<UsageResult | void>;
  createCheckoutSession(params: CheckoutSessionParams): Promise<{ url: string }>;
  changePlan(userId: string, params: ChangePlanParams): Promise<void>;
  cancelSubscription(userId: string, params?: CancelParams): Promise<void>;
  reactivateSubscription(userId: string): Promise<void>;
}
