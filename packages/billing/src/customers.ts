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

function errorStatus(err: unknown): number | undefined {
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === "number" ? status : undefined;
}

/**
 * Stripe saves the response under an idempotency key, 500s included, so a
 * failed create would replay forever. Before giving up, look for a customer
 * Stripe did create for this subject.
 */
async function findCreatedCustomer(ctx: BillingContext, subjectId: string, original: unknown) {
  const escaped = subjectId.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const found = await ctx.stripe.customers.search({ query: `metadata['subject_id']:'${escaped}'` });
  if (found.data.length === 0) throw original;
  if (found.data.length > 1) {
    throw new Error(
      `Several Stripe customers carry subject_id ${subjectId}: ${found.data.map((c) => c.id).join(", ")}. Remove the duplicates.`
    );
  }
  return found.data[0]!;
}

/**
 * Returns the subject's Stripe customer, creating it on first use.
 *
 * The create call carries an idempotency key derived from the subject, so two
 * concurrent first calls get the same customer back from Stripe. Stripe keeps
 * idempotency keys for at least 24 hours; after that, the unique primary key on
 * `billing_customer.subject_id` is what prevents a second mapping.
 *
 * The create sends only stable parameters (the subject metadata). Name and
 * email are applied afterwards with an update, because Stripe rejects or
 * replays a reused key whose parameters changed. An update error propagates
 * after the mapping is stored, so a retry skips the create.
 */
export async function ensureCustomer(
  ctx: BillingContext,
  subjectId: string,
  details: CustomerDetails = {}
): Promise<string> {
  assertSubjectId(subjectId);
  const existing = await getCustomerId(ctx.db, subjectId);
  if (existing) return existing;

  let customer;
  try {
    customer = await ctx.stripe.customers.create(
      { metadata: { subject_id: subjectId } },
      { idempotencyKey: `context-kit-billing:customer:${subjectId}` }
    );
  } catch (err) {
    const status = errorStatus(err);
    if (status !== undefined && status < 500) throw err;
    customer = await findCreatedCustomer(ctx, subjectId, err);
  }

  await ctx.db
    .insert(billingCustomer)
    .values({ subjectId, stripeCustomerId: customer.id, livemode: customer.livemode })
    .onConflictDoNothing({ target: billingCustomer.subjectId });

  // Re-read: a concurrent call may have inserted first. Both hold the same id.
  const stored = (await getCustomerId(ctx.db, subjectId)) ?? customer.id;

  if (details.name || details.email) {
    await ctx.stripe.customers.update(stored, {
      ...(details.name ? { name: details.name } : {}),
      ...(details.email ? { email: details.email } : {}),
    });
  }
  return stored;
}
