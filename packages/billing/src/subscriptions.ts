import { eq, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { planForLookupKey } from "./config.js";
import { billingCustomer, billingSubscription } from "./schema/postgres.js";
import type { BillingContext } from "./types.js";

export type SyncResult =
  | { outcome: "synced"; subjectId: string; subscriptionId: string }
  /** No billing_customer row for the customer and no subject_id metadata. */
  | { outcome: "unknown_subject"; subscriptionId: string }
  /** metadata.subject_id names a different subject than the customer mapping. Not stored. */
  | { outcome: "subject_mismatch"; subscriptionId: string };

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

/**
 * The subject a subscription belongs to. The stored customer mapping is the
 * checked path and wins. `metadata.subject_id` on the subscription (set by this
 * package's Checkout) and on the customer (set by ensureCustomer) are fallbacks
 * for a customer not mapped yet. If the mapping exists and either metadata
 * disagrees with it, or there is no mapping and the two metadata sources
 * disagree, something outside this package edited one of them, so the
 * subscription is not attributed to any. `sub.customer` is read as an expanded
 * object when the caller expanded it; a string or a deleted customer carries no
 * metadata.
 */
async function resolveSubject(
  ctx: BillingContext,
  sub: Stripe.Subscription
): Promise<{ subjectId: string } | { problem: "unknown_subject" | "subject_mismatch" }> {
  const customerId = idOf(sub.customer);
  const [row] = customerId
    ? await ctx.db
        .select({ subjectId: billingCustomer.subjectId })
        .from(billingCustomer)
        .where(eq(billingCustomer.stripeCustomerId, customerId))
    : [];
  const fromSubscription = sub.metadata?.subject_id || undefined;
  const customer = typeof sub.customer === "object" && sub.customer && !("deleted" in sub.customer && sub.customer.deleted)
    ? (sub.customer as Stripe.Customer)
    : null;
  const fromCustomer = customer?.metadata?.subject_id || undefined;
  const claimed = [fromSubscription, fromCustomer].filter((v): v is string => !!v);
  if (row ? claimed.some((v) => v !== row.subjectId) : claimed.length === 2 && claimed[0] !== claimed[1]) {
    return { problem: "subject_mismatch" };
  }
  const subjectId = row?.subjectId ?? claimed[0];
  return subjectId ? { subjectId } : { problem: "unknown_subject" };
}

/**
 * When the subscription's unpaid stretch began, which is where the grace period
 * counts from. It is the finalization time of the oldest open invoice, not the
 * latest one: a renewal while past_due adds a newer invoice, and counting from
 * that would restart the grace period every month. A previously stored value is
 * kept if it is earlier (for example, the old invoice was marked uncollectible)
 * and no invoice has been paid since it; the current time is the fallback, so a
 * past_due row is never without one.
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
  if (stored?.since) {
    // A payment after the stored date means that unpaid stretch ended, even if
    // the sync that saw the subscription active again was missed. Stripe lists
    // invoices newest first.
    const paid = await ctx.stripe.invoices.list({ subscription: sub.id, status: "paid", limit: 1 });
    const paidAt = fromUnix(paid.data[0]?.status_transitions?.paid_at);
    if (!paidAt || paidAt <= stored.since) candidates.push(stored.since);
  }
  if (candidates.length === 0) return now;
  return new Date(Math.min(...candidates.map((d) => d.getTime())));
}

/**
 * Writes a subscription object, fetched from the API, into
 * `billing_subscription`. The whole row is replaced, so the result depends only
 * on the object passed in, never on what was stored before.
 *
 * Not exported: it must run under syncSubscription's advisory lock, otherwise
 * an older fetch can overwrite a newer one.
 */
async function storeSubscription(
  ctx: BillingContext,
  sub: Stripe.Subscription
): Promise<SyncResult> {
  const resolved = await resolveSubject(ctx, sub);
  if ("problem" in resolved) return { outcome: resolved.problem, subscriptionId: sub.id };
  const { subjectId } = resolved;

  const items = sub.items.data;
  // Prefer the configured lookup key. A single metered item with another key is
  // taken as a grandfathered overage price; with several, none is guessed.
  const metered = items.filter((i) => i.price.recurring?.usage_type === "metered");
  const overageItem = items.find((i) => i.price.lookup_key === ctx.config.overage.priceLookupKey)
    ?? (metered.length === 1 ? metered[0] : undefined);
  const baseItem = items.find((i) => i !== overageItem && i.price.recurring?.usage_type !== "metered")
    ?? items.find((i) => i !== overageItem);

  const now = ctx.now?.() ?? new Date();
  // Only past_due has a grace period; unpaid is on free limits by design (#7).
  const pastDueSince = sub.status === "past_due" ? await firstUnpaidAt(ctx, sub, now) : null;

  const values = {
    stripeSubscriptionId: sub.id,
    subjectId,
    stripeCustomerId: idOf(sub.customer) ?? "",
    status: sub.status,
    planKey: baseItem ? planKeyForPrice(ctx, baseItem.price) : null,
    basePriceId: baseItem?.price.id ?? null,
    overagePriceId: overageItem?.price.id ?? null,
    billingInterval: baseItem?.price.recurring?.interval ?? overageItem?.price.recurring?.interval ?? null,
    billingIntervalCount: baseItem?.price.recurring?.interval_count ?? overageItem?.price.recurring?.interval_count ?? null,
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

/** First key of the two-key advisory lock, so billing locks cannot collide with an app's own ("bill"). */
const LOCK_NAMESPACE = 0x62696c6c;

/**
 * Fetches one subscription from Stripe and stores its current state.
 *
 * Fetch and store run under a transaction-scoped advisory lock keyed on the
 * subscription id. Two concurrent deliveries for one subscription therefore
 * run one after the other, and the second fetches after the first has stored,
 * so an older response can never overwrite a newer one. The lock is held for
 * one Stripe GET (normally well under a second; at most about 95 seconds with
 * the client's 30-second timeout and 2 retries) and only blocks syncs of the
 * same subscription.
 */
export async function syncSubscription(
  ctx: BillingContext,
  subscriptionId: string
): Promise<SyncResult> {
  return ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_NAMESPACE}, hashtext(${subscriptionId}))`);
    const sub = await ctx.stripe.subscriptions.retrieve(subscriptionId, {
      expand: ["latest_invoice", "customer"],
    });
    return storeSubscription({ ...ctx, db: tx }, sub);
  });
}

/**
 * Re-syncs every subscription of a customer, canceled ones included. The list
 * API (read-after-write consistent, unlike search) supplies the ids; each one
 * is then fetched and stored through syncSubscription, under its lock.
 */
export async function syncCustomerSubscriptions(
  ctx: BillingContext,
  customerId: string
): Promise<SyncResult[]> {
  const ids: string[] = [];
  for await (const sub of ctx.stripe.subscriptions.list({ customer: customerId, status: "all", limit: 100 })) {
    ids.push(sub.id);
  }
  const results: SyncResult[] = [];
  for (const id of ids) results.push(await syncSubscription(ctx, id));
  return results;
}
