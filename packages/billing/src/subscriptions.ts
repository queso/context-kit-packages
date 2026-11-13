import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { planForLookupKey } from "./config.js";
import { billingCustomer, billingSubscription } from "./schema/postgres.js";
import type { BillingContext } from "./types.js";

export type SyncResult =
  | { outcome: "synced"; subjectId: string; subscriptionId: string }
  | { outcome: "unknown_subject"; subscriptionId: string };

const fromUnix = (s: number | null | undefined): Date | null =>
  typeof s === "number" ? new Date(s * 1000) : null;

const idOf = (v: string | { id: string } | null | undefined): string | null =>
  v == null ? null : typeof v === "string" ? v : v.id;

function planKeyForPrice(ctx: BillingContext, price: Stripe.Price): string | null {
  const byLookup = planForLookupKey(ctx.config, price.lookup_key);
  if (byLookup) return byLookup;
  // A grandfathered price lost its lookup key to a newer price. bootstrap and
  // price migrations tag every plan price with metadata.plan_key so it is still
  // recognised.
  const tagged = price.metadata?.plan_key;
  return tagged && tagged in ctx.config.plans ? tagged : null;
}

async function resolveSubject(ctx: BillingContext, sub: Stripe.Subscription): Promise<string | null> {
  const fromMetadata = sub.metadata?.subject_id;
  if (fromMetadata) return fromMetadata;
  const customerId = idOf(sub.customer);
  if (!customerId) return null;
  const [row] = await ctx.db
    .select({ subjectId: billingCustomer.subjectId })
    .from(billingCustomer)
    .where(eq(billingCustomer.stripeCustomerId, customerId));
  return row?.subjectId ?? null;
}

/**
 * When the subscription's unpaid stretch began, which is where the grace period
 * counts from. It is the finalization time of the oldest open invoice, not the
 * latest one: a renewal while past_due adds a newer invoice, and counting from
 * that would restart the grace period every month. A previously stored value is
 * kept if it is earlier (for example, the old invoice was marked uncollectible),
 * and the current time is the fallback, so a past_due row is never without one.
 */
async function firstUnpaidAt(ctx: BillingContext, sub: Stripe.Subscription, now: Date): Promise<Date> {
  const candidates: Date[] = [];
  for await (const invoice of ctx.stripe.invoices.list({ subscription: sub.id, status: "open", limit: 100 })) {
    const finalized = fromUnix(invoice.status_transitions?.finalized_at);
    if (finalized) candidates.push(finalized);
  }
  const [stored] = await ctx.db
    .select({ since: billingSubscription.pastDueSince })
    .from(billingSubscription)
    .where(eq(billingSubscription.stripeSubscriptionId, sub.id));
  if (stored?.since) candidates.push(stored.since);
  if (candidates.length === 0) return now;
  return new Date(Math.min(...candidates.map((d) => d.getTime())));
}

/**
 * Writes a subscription object, fetched from the API, into
 * `billing_subscription`. The whole row is replaced, so the result depends only
 * on the object passed in, never on what was stored before.
 */
export async function storeSubscription(
  ctx: BillingContext,
  sub: Stripe.Subscription
): Promise<SyncResult> {
  const subjectId = await resolveSubject(ctx, sub);
  if (!subjectId) return { outcome: "unknown_subject", subscriptionId: sub.id };

  const items = sub.items.data;
  const overageItem = items.find((i) => i.price.lookup_key === ctx.config.overage.priceLookupKey)
    ?? items.find((i) => i.price.recurring?.usage_type === "metered");
  const baseItem = items.find((i) => i !== overageItem && i.price.recurring?.usage_type !== "metered")
    ?? items.find((i) => i !== overageItem);

  const now = ctx.now?.() ?? new Date();
  const pastDueSince =
    sub.status === "past_due" || sub.status === "unpaid" ? await firstUnpaidAt(ctx, sub, now) : null;

  const values = {
    stripeSubscriptionId: sub.id,
    subjectId,
    stripeCustomerId: idOf(sub.customer) ?? "",
    status: sub.status,
    planKey: baseItem ? planKeyForPrice(ctx, baseItem.price) : null,
    basePriceId: baseItem?.price.id ?? null,
    overagePriceId: overageItem?.price.id ?? null,
    currentPeriodStart: fromUnix(baseItem?.current_period_start ?? overageItem?.current_period_start),
    currentPeriodEnd: fromUnix(baseItem?.current_period_end ?? overageItem?.current_period_end),
    cancelAt: fromUnix(sub.cancel_at),
    trialEnd: fromUnix(sub.trial_end),
    pastDueSince,
    livemode: sub.livemode,
    syncedAt: now,
  };

  const { stripeSubscriptionId: _id, ...updates } = values;
  await ctx.db
    .insert(billingSubscription)
    .values(values)
    .onConflictDoUpdate({ target: billingSubscription.stripeSubscriptionId, set: updates });

  return { outcome: "synced", subjectId, subscriptionId: sub.id };
}

/** Fetches one subscription from Stripe and stores its current state. */
export async function syncSubscription(
  ctx: BillingContext,
  subscriptionId: string
): Promise<SyncResult> {
  const sub = await ctx.stripe.subscriptions.retrieve(subscriptionId, {
    expand: ["latest_invoice"],
  });
  return storeSubscription(ctx, sub);
}

/**
 * Fetches every subscription of a customer, canceled ones included, and stores
 * each. Uses the list API, which is read-after-write consistent, rather than
 * search, which can lag.
 */
export async function syncCustomerSubscriptions(
  ctx: BillingContext,
  customerId: string
): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  for await (const sub of ctx.stripe.subscriptions.list({
    customer: customerId,
    status: "all",
    expand: ["data.latest_invoice"],
    limit: 100,
  })) {
    results.push(await storeSubscription(ctx, sub));
  }
  return results;
}
