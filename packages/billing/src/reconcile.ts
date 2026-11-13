import type Stripe from "stripe";
import { billingCustomer } from "./schema/postgres.js";
import { syncCustomerSubscriptions } from "./subscriptions.js";
import type { BillingContext } from "./types.js";

export interface ReconcileSummary {
  customers: number;
  subscriptions: number;
  unknownSubject: number;
  repairedCustomers: number;
  /** Unmapped subjects that had several tagged Stripe customers. */
  duplicateSubjects: number;
}

/** Among customers sharing a subject: one with a live subscription, else the oldest. */
async function chooseCustomer(ctx: BillingContext, candidates: Stripe.Customer[]): Promise<Stripe.Customer> {
  const oldestFirst = [...candidates].sort((a, b) => a.created - b.created);
  if (oldestFirst.length === 1) return oldestFirst[0]!;
  for (const customer of oldestFirst) {
    const subs = await ctx.stripe.subscriptions.list({ customer: customer.id, status: "all", limit: 100 });
    if (subs.data.some((s) => s.status !== "canceled" && s.status !== "incomplete_expired")) return customer;
  }
  return oldestFirst[0]!;
}

/**
 * Rebuilds the stored billing state from Stripe. Safe to run at any time; use
 * it on a schedule or whenever the local tables are suspected to be wrong.
 *
 * With `repairCustomers`, it also lists every Stripe customer and restores a
 * missing `billing_customer` row from the customer's `metadata.subject_id`.
 * It uses the list APIs throughout, never search, which can lag behind writes.
 */
export async function reconcile(
  ctx: BillingContext,
  options: { repairCustomers?: boolean } = {}
): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { customers: 0, subscriptions: 0, unknownSubject: 0, repairedCustomers: 0, duplicateSubjects: 0 };

  if (options.repairCustomers) {
    const known = new Set((await ctx.db.select({ id: billingCustomer.stripeCustomerId }).from(billingCustomer)).map((r) => r.id));
    // Group unmapped tagged customers by subject, since two can share one.
    const bySubject = new Map<string, Stripe.Customer[]>();
    for await (const customer of ctx.stripe.customers.list({ limit: 100 })) {
      const subjectId = customer.metadata?.subject_id;
      if (!subjectId || known.has(customer.id)) continue;
      bySubject.set(subjectId, [...(bySubject.get(subjectId) ?? []), customer]);
    }
    for (const [subjectId, candidates] of bySubject) {
      if (candidates.length > 1) summary.duplicateSubjects++;
      const customer = await chooseCustomer(ctx, candidates);
      const inserted = await ctx.db
        .insert(billingCustomer)
        .values({ subjectId, stripeCustomerId: customer.id, livemode: customer.livemode })
        .onConflictDoNothing()
        .returning({ id: billingCustomer.subjectId });
      summary.repairedCustomers += inserted.length;
    }
  }

  const customers = await ctx.db.select({ id: billingCustomer.stripeCustomerId }).from(billingCustomer);
  for (const { id } of customers) {
    summary.customers++;
    for (const result of await syncCustomerSubscriptions(ctx, id)) {
      if (result.outcome === "synced") summary.subscriptions++;
      else summary.unknownSubject++;
    }
  }
  return summary;
}
