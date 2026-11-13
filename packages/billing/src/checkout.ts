import { and, eq, inArray } from "drizzle-orm";
import type Stripe from "stripe";
import { ensureCustomer, getCustomerId, assertSubjectId, type CustomerDetails } from "./customers.js";
import { billingCustomer, billingSubscription } from "./schema/postgres.js";
import { syncSubscription, type SyncResult } from "./subscriptions.js";
import type { BillingContext } from "./types.js";

const DAY_MS = 86_400_000;
const MIN_SESSION_MS = 30 * 60_000;

/** Statuses that still hold a live subscription; a second Checkout would double-bill. */
const LIVE_STATUSES = ["active", "trialing", "past_due", "unpaid", "incomplete", "paused"];

export class AlreadySubscribedError extends Error {
  constructor(readonly subjectId: string, readonly subscriptionId: string) {
    super(`subject ${subjectId} already has subscription ${subscriptionId}; change its plan instead of opening a new Checkout`);
    this.name = "AlreadySubscribedError";
  }
}

/** 00:00 UTC on the first day of the month after `now`. */
export function nextMonthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/**
 * Indexes prices by lookup key. Stripe moves a lookup key between prices
 * atomically (`transfer_lookup_key`), so a key should name one price; if two
 * active prices ever share one, this throws rather than pick either.
 */
export function indexByLookupKey<P extends { id: string; lookup_key: string | null }>(prices: P[]): Map<string, P> {
  const out = new Map<string, P>();
  for (const p of prices) {
    if (!p.lookup_key) continue;
    const other = out.get(p.lookup_key);
    if (other) {
      throw new Error(`Lookup key "${p.lookup_key}" matches more than one active price (${other.id}, ${p.id}); archive one`);
    }
    out.set(p.lookup_key, p);
  }
  return out;
}

/** Looks prices up by lookup key and fails with the missing keys named. */
export async function resolvePricesByLookupKey(
  stripe: Stripe,
  lookupKeys: string[]
): Promise<Map<string, Stripe.Price>> {
  const list = await stripe.prices.list({ lookup_keys: lookupKeys, active: true, limit: 10 });
  const found = indexByLookupKey(list.data);
  const missing = lookupKeys.filter((k) => !found.has(k));
  if (missing.length > 0) {
    throw new Error(`No active Stripe price with lookup key ${missing.join(", ")}; run bootstrapCatalog first`);
  }
  return found;
}

/** The Checkout Session parameters, separated out so their shape can be checked against stripe-mock. */
export function buildCheckoutParams(
  config: BillingContext["config"],
  input: {
    subjectId: string;
    customer: string;
    basePriceId: string;
    overagePriceId: string;
    successUrl: string;
    cancelUrl: string;
    billingCycleAnchor: Date | null;
  }
): Stripe.Checkout.SessionCreateParams {
  const params: Stripe.Checkout.SessionCreateParams = {
    mode: "subscription",
    customer: input.customer,
    client_reference_id: input.subjectId,
    line_items: [
      { price: input.basePriceId, quantity: 1 },
      // Stripe: "Quantity should not be defined when recurring.usage_type=metered."
      { price: input.overagePriceId },
    ],
    subscription_data: {
      metadata: { subject_id: input.subjectId },
      ...(input.billingCycleAnchor
        ? { billing_cycle_anchor: Math.floor(input.billingCycleAnchor.getTime() / 1000) }
        : {}),
    },
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  };
  if (config.automaticTax) {
    params.automatic_tax = { enabled: true };
    params.billing_address_collection = "auto";
    params.customer_update = { address: "auto", name: "auto" };
    params.tax_id_collection = { enabled: true };
  }
  return params;
}

export interface CheckoutInput {
  subjectId: string;
  /** A paid plan key from the config. */
  plan: string;
  /** Include `{CHECKOUT_SESSION_ID}` so the success page can call completeCheckout. */
  successUrl: string;
  cancelUrl: string;
  /** Used only when the Stripe customer is created by this call. */
  customer?: CustomerDetails;
  /**
   * Renew on the 1st of each month at 00:00 UTC so Stripe's billing period
   * matches a calendar-month usage ledger. The first invoice is prorated.
   * Default true.
   */
  anchorToMonthStart?: boolean;
}

/**
 * Creates a hosted Checkout Session for a paid plan and returns its URL. The
 * caller authorizes the request, then redirects:
 *
 * ```ts
 * "use server";
 * export async function upgrade(formData: FormData) {
 *   const account = await requireAccountAdmin(formData.get("account"));   // your auth
 *   const { url } = await billing.createCheckoutSession({ subjectId: String(account.id), plan: "pro", ... });
 *   redirect(url);                                                         // outside any try/catch
 * }
 * ```
 */
export async function createCheckoutSession(
  ctx: BillingContext,
  input: CheckoutInput
): Promise<{ id: string; url: string }> {
  assertSubjectId(input.subjectId);
  const plan = ctx.config.plans[input.plan];
  if (!plan) throw new Error(`Unknown plan "${input.plan}"`);
  if (input.plan === ctx.config.freePlan || !plan.priceLookupKey) {
    throw new Error("The free plan has no Checkout; it needs no payment");
  }

  const [live] = await ctx.db
    .select({ id: billingSubscription.stripeSubscriptionId })
    .from(billingSubscription)
    .where(and(eq(billingSubscription.subjectId, input.subjectId), inArray(billingSubscription.status, LIVE_STATUSES)));
  if (live) throw new AlreadySubscribedError(input.subjectId, live.id);

  const prices = await resolvePricesByLookupKey(ctx.stripe, [plan.priceLookupKey, ctx.config.overage.priceLookupKey]);
  const customer = await ensureCustomer(ctx, input.subjectId, input.customer);
  const now = ctx.now?.() ?? new Date();
  let anchor: Date | null = null;
  if (input.anchorToMonthStart !== false) {
    anchor = nextMonthStartUtc(now);
    // Stripe's shortest session lifetime is 30 minutes. Inside the last 30
    // minutes of a month, anchor on the following month start instead.
    if (anchor.getTime() - now.getTime() < MIN_SESSION_MS) anchor = nextMonthStartUtc(anchor);
  }

  const params = buildCheckoutParams(ctx.config, {
    subjectId: input.subjectId,
    customer,
    basePriceId: prices.get(plan.priceLookupKey)!.id,
    overagePriceId: prices.get(ctx.config.overage.priceLookupKey)!.id,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
    billingCycleAnchor: input.anchorToMonthStart === false ? null : anchor,
  });
  if (anchor && anchor.getTime() - now.getTime() < DAY_MS) {
    // A session lives 24 hours by default. Expire it at the anchor so a
    // customer cannot complete it after the anchor has passed.
    params.expires_at = Math.floor(anchor.getTime() / 1000);
  }

  const session = await ctx.stripe.checkout.sessions.create(params);
  if (!session.url) throw new Error("Stripe returned a Checkout Session without a URL");
  return { id: session.id, url: session.url };
}

/**
 * Fulfils a finished Checkout from the success page. Stripe advises triggering
 * fulfilment there as well as from the webhook, since the webhook can be late;
 * both paths run the same idempotent sync. Returns null while the session is
 * still open.
 */
export async function completeCheckout(
  ctx: BillingContext,
  sessionId: string,
  expected: { subjectId: string }
): Promise<SyncResult | null> {
  const session = await ctx.stripe.checkout.sessions.retrieve(sessionId);
  if (session.client_reference_id !== expected.subjectId) {
    throw new Error("This Checkout Session belongs to another subject");
  }
  if (session.status !== "complete" || session.mode !== "subscription" || !session.subscription) return null;

  const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
  if (customerId) {
    await ctx.db
      .insert(billingCustomer)
      .values({ subjectId: expected.subjectId, stripeCustomerId: customerId, livemode: session.livemode })
      .onConflictDoNothing();
  }
  const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription.id;
  return syncSubscription(ctx, subscriptionId);
}

/**
 * Creates a Customer Portal session (cards, invoices, cancellation) and returns
 * its URL. The portal cannot change a subscription that has a metered price, so
 * plan changes are not offered there.
 */
export async function createPortalSession(
  ctx: BillingContext,
  input: { subjectId: string; returnUrl: string; configuration?: string }
): Promise<{ url: string }> {
  assertSubjectId(input.subjectId);
  const customer = await getCustomerId(ctx.db, input.subjectId);
  if (!customer) throw new Error(`Subject ${input.subjectId} has no Stripe customer yet`);
  const session = await ctx.stripe.billingPortal.sessions.create({
    customer,
    return_url: input.returnUrl,
    ...(input.configuration ? { configuration: input.configuration } : {}),
  });
  return { url: session.url };
}
