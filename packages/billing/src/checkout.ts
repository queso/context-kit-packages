import { and, eq, inArray, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { ensureCustomer, getCustomerId, assertSubjectId, type CustomerDetails } from "./customers.js";
import { billingCustomer, billingSubscription } from "./schema/postgres.js";
import { syncSubscription, type SyncResult } from "./subscriptions.js";
import type { BillingContext, BillingDb } from "./types.js";

/** First key of the two-key advisory lock, shared with subscriptions.ts ("bill"). */
const LOCK_NAMESPACE = 0x62696c6c;

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
    anchorToMonthStart: boolean;
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
      // Stripe computes the anchor when the subscription is created and
      // accounts for short months, so a session needs no expiry handling.
      ...(input.anchorToMonthStart
        ? { billing_cycle_anchor_config: { day_of_month: 1, hour: 0, minute: 0, second: 0 } }
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

  const prices = await resolvePricesByLookupKey(ctx.stripe, [plan.priceLookupKey, ctx.config.overage.priceLookupKey]);

  // The live-subscription check, the expiry of older open sessions and the
  // create run under one lock per subject, so two concurrent calls cannot each
  // pass the check and leave two open sessions. The lock is held across a few
  // Stripe calls and only blocks Checkouts for the same subject.
  return ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_NAMESPACE}, hashtext(${"checkout:" + input.subjectId}))`);
    const txCtx = { ...ctx, db: tx };

    const [live] = await tx
      .select({ id: billingSubscription.stripeSubscriptionId })
      .from(billingSubscription)
      .where(and(eq(billingSubscription.subjectId, input.subjectId), inArray(billingSubscription.status, LIVE_STATUSES)));
    if (live) throw new AlreadySubscribedError(input.subjectId, live.id);

    const customer = await ensureCustomer(txCtx, input.subjectId, input.customer);

    // A Checkout can complete before its subscription is synced locally, so the
    // local check above is not enough: ask Stripe too.
    for await (const sub of ctx.stripe.subscriptions.list({ customer, status: "all", limit: 100 })) {
      if (LIVE_STATUSES.includes(sub.status)) throw new AlreadySubscribedError(input.subjectId, sub.id);
    }

    const params = buildCheckoutParams(ctx.config, {
      subjectId: input.subjectId,
      customer,
      basePriceId: prices.get(plan.priceLookupKey!)!.id,
      overagePriceId: prices.get(ctx.config.overage.priceLookupKey)!.id,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      anchorToMonthStart: input.anchorToMonthStart !== false,
    });
    const session = await ctx.stripe.checkout.sessions.create(params);
    if (!session.url) throw new Error("Stripe returned a Checkout Session without a URL");

    // An older open session could be completed after this one, or after a
    // subscription starts, and would bill a second subscription. Expire them
    // only once the new session exists, so a failed create leaves the old one.
    for await (const old of ctx.stripe.checkout.sessions.list({ customer, status: "open", limit: 100 })) {
      if (old.id !== session.id) await ctx.stripe.checkout.sessions.expire(old.id);
    }
    return { id: session.id, url: session.url };
  });
}

/**
 * Maps a subject to the Stripe customer a Checkout Session used. Does nothing
 * when the session has no customer or the mapping already exists.
 */
export async function recordSessionCustomer(
  db: BillingDb,
  session: Pick<Stripe.Checkout.Session, "customer" | "livemode">,
  subjectId: string
): Promise<void> {
  const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
  if (!customerId) return;
  await db
    .insert(billingCustomer)
    .values({ subjectId, stripeCustomerId: customerId, livemode: session.livemode })
    .onConflictDoNothing();
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
  // livemode is not compared with the key's mode: one database pairs with one Stripe mode (README, "one database per Stripe mode").
  const session = await ctx.stripe.checkout.sessions.retrieve(sessionId);
  if (session.client_reference_id !== expected.subjectId) {
    throw new Error("This Checkout Session belongs to another subject");
  }
  if (session.status !== "complete" || session.mode !== "subscription" || !session.subscription) return null;

  await recordSessionCustomer(ctx.db, session, expected.subjectId);
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
