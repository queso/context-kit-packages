import { billingCustomer } from "./schema/postgres.js";
import { syncCustomerSubscriptions } from "./subscriptions.js";
import type { BillingContext } from "./types.js";

export interface ReconcileSummary {
  customers: number;
  subscriptions: number;
  unknownSubject: number;
  repairedCustomers: number;
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
  const summary: ReconcileSummary = { customers: 0, subscriptions: 0, unknownSubject: 0, repairedCustomers: 0 };

  if (options.repairCustomers) {
    const known = new Set((await ctx.db.select({ id: billingCustomer.stripeCustomerId }).from(billingCustomer)).map((r) => r.id));
    for await (const customer of ctx.stripe.customers.list({ limit: 100 })) {
      const subjectId = customer.metadata?.subject_id;
      if (!subjectId || known.has(customer.id)) continue;
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
