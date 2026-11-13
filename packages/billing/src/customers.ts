import { eq } from "drizzle-orm";
import { billingCustomer } from "./schema/postgres.js";
import type { BillingContext, BillingDb } from "./types.js";

const MAX_SUBJECT_ID_LENGTH = 200;

export function assertSubjectId(subjectId: string): void {
  if (
    typeof subjectId !== "string" ||
    subjectId.trim() === "" ||
    subjectId.length > MAX_SUBJECT_ID_LENGTH
  ) {
    throw new Error(`subjectId must be a non-empty string of at most ${MAX_SUBJECT_ID_LENGTH} characters`);
  }
}

/** The Stripe customer id for a subject, or null if it has never been created. */
export async function getCustomerId(db: BillingDb, subjectId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: billingCustomer.stripeCustomerId })
    .from(billingCustomer)
    .where(eq(billingCustomer.subjectId, subjectId));
  return row?.id ?? null;
}

export interface CustomerDetails {
  name?: string;
  email?: string;
}

/**
 * Returns the subject's Stripe customer, creating it on first use.
 *
 * The create call carries an idempotency key derived from the subject, so two
 * concurrent first calls get the same customer back from Stripe. Stripe keeps
 * idempotency keys for at least 24 hours; after that, the unique primary key on
 * `billing_customer.subject_id` is what prevents a second mapping.
 */
export async function ensureCustomer(
  ctx: BillingContext,
  subjectId: string,
  details: CustomerDetails = {}
): Promise<string> {
  assertSubjectId(subjectId);
  const existing = await getCustomerId(ctx.db, subjectId);
  if (existing) return existing;

  const customer = await ctx.stripe.customers.create(
    {
      metadata: { subject_id: subjectId },
      ...(details.name ? { name: details.name } : {}),
      ...(details.email ? { email: details.email } : {}),
    },
    { idempotencyKey: `context-kit-billing:customer:${subjectId}` }
  );

  await ctx.db
    .insert(billingCustomer)
    .values({ subjectId, stripeCustomerId: customer.id, livemode: customer.livemode })
    .onConflictDoNothing({ target: billingCustomer.subjectId });

  // Re-read: a concurrent call may have inserted first. Both hold the same id.
  const stored = await getCustomerId(ctx.db, subjectId);
  return stored ?? customer.id;
}
