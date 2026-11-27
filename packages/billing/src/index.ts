import type Stripe from "stripe";
import { validateConfig } from "./config.js";
import { createStripeClient, type StripeClientOptions } from "./stripe-client.js";
import { ensureCustomer, getCustomerId, type CustomerDetails } from "./customers.js";
import { getEntitlement } from "./entitlement.js";
import { syncSubscription } from "./subscriptions.js";
import { createWebhookHandler, processEvent } from "./webhooks.js";
import { enqueueUsage, reportPendingUsage, type UsageRecord } from "./usage.js";
import { createCheckoutSession, completeCheckout, createPortalSession, type CheckoutInput } from "./checkout.js";
import { reconcile } from "./reconcile.js";
import type { BillingConfig, BillingContext, BillingDb } from "./types.js";

export type { BillingConfig, BillingContext, BillingDb, PlanDefinition } from "./types.js";
export { validateConfig } from "./config.js";
export { createStripeClient, STRIPE_API_VERSION, type StripeClientOptions } from "./stripe-client.js";
export { ensureCustomer, getCustomerId, type CustomerDetails } from "./customers.js";
export { getEntitlement, resolveEntitlement, type Entitlement, type EntitlementReason } from "./entitlement.js";
export { syncSubscription, syncCustomerSubscriptions, type SyncResult } from "./subscriptions.js";
export { createWebhookHandler, processEvent, type EventOutcome, type WebhookHandlerOptions } from "./webhooks.js";
export {
  computeOverage,
  enqueueUsage,
  reportPendingUsage,
  isDuplicateIdentifierError,
  UsageReportingBlockedError,
  type BlockedReason,
  type UsageRecord,
  type EnqueueResult,
  type ReportSummary,
} from "./usage.js";
export {
  createCheckoutSession,
  completeCheckout,
  createPortalSession,
  nextMonthStartUtc,
  resolvePricesByLookupKey,
  AlreadySubscribedError,
  type CheckoutInput,
} from "./checkout.js";
export { reconcile, type ReconcileSummary } from "./reconcile.js";
export { bootstrapCatalog, type Catalog, type BootstrapResult } from "./bootstrap.js";

export type CreateBillingOptions = {
  db: BillingDb;
  config: BillingConfig;
  /** The endpoint signing secret. When set, `webhookHandler` is available. */
  webhookSecret?: string;
  now?: () => Date;
} & (
  | { stripe: Stripe; secretKey?: never; stripeOptions?: never }
  | { secretKey: string; stripeOptions?: StripeClientOptions; stripe?: never }
);

/**
 * Wires the package to an app's database, Stripe key and plan table. Call it
 * once at module scope and import the result where needed:
 *
 * ```ts
 * // lib/billing.ts
 * export const billing = createBilling({
 *   db,
 *   secretKey: process.env.STRIPE_SECRET_KEY!,
 *   webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
 *   config: { plans: { ... }, freePlan: "free", overage: { ... }, gracePeriodDays: 7 },
 * });
 * ```
 */
export function createBilling(options: CreateBillingOptions) {
  const config = validateConfig(options.config);
  let stripe: Stripe;
  if (options.stripe) stripe = options.stripe;
  else if (options.secretKey) stripe = createStripeClient(options.secretKey, options.stripeOptions);
  else throw new Error("createBilling needs a stripe client or a secretKey");

  const ctx: BillingContext = { db: options.db, stripe, config, ...(options.now ? { now: options.now } : {}) };

  return {
    ctx,
    stripe,
    config,
    ensureCustomer: (subjectId: string, details?: CustomerDetails) => ensureCustomer(ctx, subjectId, details),
    getCustomerId: (subjectId: string) => getCustomerId(ctx.db, subjectId),
    getEntitlement: (subjectId: string) => getEntitlement(ctx, subjectId),
    createCheckoutSession: (input: CheckoutInput) => createCheckoutSession(ctx, input),
    completeCheckout: (sessionId: string, expected: { subjectId: string }) => completeCheckout(ctx, sessionId, expected),
    createPortalSession: (input: { subjectId: string; returnUrl: string; configuration?: string }) =>
      createPortalSession(ctx, input),
    syncSubscription: (subscriptionId: string) => syncSubscription(ctx, subscriptionId),
    processEvent: (event: Stripe.Event) => processEvent(ctx, event),
    /** Pass `db: tx` to enqueue inside the transaction that writes your own usage record. */
    enqueueUsage: (record: UsageRecord, db?: BillingDb) => enqueueUsage(db ? { ...ctx, db } : ctx, record),
    reportPendingUsage: (opts?: { limit?: number }) => reportPendingUsage(ctx, opts),
    reconcile: (opts?: { repairCustomers?: boolean }) => reconcile(ctx, opts),
    webhookHandler: options.webhookSecret ? createWebhookHandler(ctx, { secret: options.webhookSecret }) : undefined,
  };
}

export type Billing = ReturnType<typeof createBilling>;
