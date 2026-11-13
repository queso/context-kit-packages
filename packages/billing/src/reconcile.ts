import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { billingCustomer } from "./schema/postgres.js";
import { syncCustomerSubscriptions } from "./subscriptions.js";
import type { BillingContext } from "./types.js";

export interface ReconcileSummary {
  customers: number;
  subscriptions: number;
  unknownSubject: number;
  repairedCustomers: number;
  /** Subjects that had several tagged Stripe customers. */
  duplicateSubjects: number;
}

async function hasLiveSubscription(ctx: BillingContext, customerId: string): Promise<boolean> {
  const subs = await ctx.stripe.subscriptions.list({ customer: customerId, status: "all", limit: 100 });
  return subs.data.some((s) => s.status !== "canceled" && s.status !== "incomplete_expired");
}

/** Among customers sharing a subject: one with a live subscription, else the oldest. */
async function chooseCustomer(ctx: BillingContext, candidates: Stripe.Customer[]): Promise<Stripe.Customer> {
  const oldestFirst = [...candidates].sort((a, b) => a.created - b.created);
  if (oldestFirst.length === 1) return oldestFirst[0]!;
  for (const customer of oldestFirst) {
    if (await hasLiveSubscription(ctx, customer.id)) return customer;
  }
  return oldestFirst[0]!;
}

/**
 * Rebuilds the stored billing state from Stripe. Safe to run at any time; use
 * it on a schedule or whenever the local tables are suspected to be wrong.
 *
 * With `repairCustomers`, it also lists every Stripe customer and restores a
 * missing `billing_customer` row from the customer's `metadata.subject_id`.
 * Subscriptions of every tagged customer are synced, mapped or not. When the
 * mapped customer of a subject has no live subscription and exactly one other
 * customer of that subject has one, the mapping moves to that customer.
 * It uses the list APIs throughout, never search, which can lag behind writes.
 */
export async function reconcile(
  ctx: BillingContext,
  options: { repairCustomers?: boolean } = {}
): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { customers: 0, subscriptions: 0, unknownSubject: 0, repairedCustomers: 0, duplicateSubjects: 0 };

  const extraCustomerIds = new Set<string>();

  if (options.repairCustomers) {
    const mapped = new Map(
      (await ctx.db.select({ subjectId: billingCustomer.subjectId, id: billingCustomer.stripeCustomerId }).from(billingCustomer)).map(
        (r) => [r.subjectId, r.id]
      )
    );
    // Group tagged customers by subject, mapped or not, since several can share one.
    const bySubject = new Map<string, Stripe.Customer[]>();
    for await (const customer of ctx.stripe.customers.list({ limit: 100 })) {
      const subjectId = customer.metadata?.subject_id;
      if (!subjectId) continue;
      bySubject.set(subjectId, [...(bySubject.get(subjectId) ?? []), customer]);
    }
    for (const [subjectId, candidates] of bySubject) {
      if (candidates.length > 1) summary.duplicateSubjects++;
      const mappedId = mapped.get(subjectId);
      if (!mappedId) {
        const customer = await chooseCustomer(ctx, candidates);
        const inserted = await ctx.db
          .insert(billingCustomer)
          .values({ subjectId, stripeCustomerId: customer.id, livemode: customer.livemode })
          .onConflictDoNothing()
          .returning({ id: billingCustomer.subjectId });
        summary.repairedCustomers += inserted.length;
        for (const c of candidates) extraCustomerIds.add(c.id);
        continue;
      }
      const others = candidates.filter((c) => c.id !== mappedId);
      if (others.length === 0) continue;
      for (const c of others) extraCustomerIds.add(c.id);
      if (await hasLiveSubscription(ctx, mappedId)) continue;
      const live: Stripe.Customer[] = [];
      for (const c of others) if (await hasLiveSubscription(ctx, c.id)) live.push(c);
      if (live.length === 1) {
        await ctx.db
          .update(billingCustomer)
          .set({ stripeCustomerId: live[0]!.id, livemode: live[0]!.livemode })
          .where(eq(billingCustomer.subjectId, subjectId));
      }
    }
  }

  const customers = await ctx.db.select({ id: billingCustomer.stripeCustomerId }).from(billingCustomer);
  const ids = new Set([...customers.map((c) => c.id), ...extraCustomerIds]);
  for (const id of ids) {
    summary.customers++;
    for (const result of await syncCustomerSubscriptions(ctx, id)) {
      if (result.outcome === "synced") summary.subscriptions++;
      else summary.unknownSubject++;
    }
  }
  return summary;
}
