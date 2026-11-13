import { eq } from "drizzle-orm";
import { billingLock } from "./locks.js";
import { billingCustomer } from "./schema/postgres.js";
import type { BillingContext, BillingDb } from "./types.js";

const MAX_SUBJECT_ID_LENGTH = 200;
// Unicode category Cc. These would reach error messages and the Stripe search query.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

export function assertSubjectId(subjectId: string): void {
  if (
    typeof subjectId !== "string" ||
    subjectId.trim() === "" ||
    subjectId.length > MAX_SUBJECT_ID_LENGTH ||
    CONTROL_CHARS.test(subjectId)
  ) {
    throw new Error(`subjectId must be a non-empty string of at most ${MAX_SUBJECT_ID_LENGTH} characters, without control characters`);
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

function duplicatesError(subjectId: string, ids: string[]): Error {
  return new Error(`Several Stripe customers carry subject_id ${subjectId}: ${ids.join(", ")}. Remove the duplicates.`);
}

/**
 * Stripe saves the response under an idempotency key, 500s included, so a
 * failed create would replay forever. Before giving up on the key, look for a
 * customer Stripe did create for this subject. Search can lag behind writes, so
 * an empty search is followed by a scan of the list API, which is
 * read-after-write consistent. Returns null only when the create provably did
 * not happen.
 */
async function findCreatedCustomer(ctx: BillingContext, subjectId: string) {
  const escaped = subjectId.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const found = await ctx.stripe.customers.search({ query: `metadata['subject_id']:'${escaped}'` });
  let matches = found.data;
  if (matches.length === 0) {
    matches = [];
    for await (const customer of ctx.stripe.customers.list({ limit: 100 })) {
      if (customer.metadata?.subject_id === subjectId) matches.push(customer);
    }
  }
  if (matches.length > 1) throw duplicatesError(subjectId, matches.map((c) => c.id));
  return matches[0] ?? null;
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
 * after the mapping is stored; a retry skips the create and applies the update
 * again.
 *
 * Everything from "no mapping found" to storing the mapping runs in a
 * transaction holding an advisory lock keyed on the subject, so concurrent
 * callers take turns and the later one finds the mapping. The lock is held
 * across the Stripe calls (a create, a search and a list scan; bounded by the
 * client's timeout and retries).
 *
 * When a create fails, what happens next depends on what the client saw:
 * - A 5xx response: Stripe answered and saved the failure under the key, so it
 *   would replay forever. Search, then scan the list for a customer Stripe did
 *   create. Only if both find nothing is the create repeated under a fresh key.
 * - No status (network error or timeout): the create may still be completing,
 *   so an empty search cannot rule it out. If a customer is found it is stored;
 *   otherwise the original error is rethrown and the next call retries with
 *   the same key, as Stripe advises for network failures.
 */
export async function ensureCustomer(
  ctx: BillingContext,
  subjectId: string,
  details: CustomerDetails = {}
): Promise<string> {
  assertSubjectId(subjectId);
  const existing = await getCustomerId(ctx.db, subjectId);
  const customerId = existing ?? (await ctx.db.transaction(async (tx) => {
    await billingLock(tx, "customer:" + subjectId);
    // Another caller may have stored the mapping while this one waited.
    return (await getCustomerId(tx, subjectId)) ?? (await createCustomer({ ...ctx, db: tx }, subjectId));
  }));
  if (details.name || details.email) {
    await ctx.stripe.customers.update(customerId, {
      ...(details.name ? { name: details.name } : {}),
      ...(details.email ? { email: details.email } : {}),
    });
  }
  return customerId;
}

async function createCustomer(ctx: BillingContext, subjectId: string): Promise<string> {
  const params = { metadata: { subject_id: subjectId } };
  let customer;
  try {
    customer = await ctx.stripe.customers.create(params, {
      idempotencyKey: `context-kit-billing:customer:${subjectId}`,
    });
  } catch (err) {
    const status = errorStatus(err);
    if (status !== undefined && status < 500) throw err;
    const found = await findCreatedCustomer(ctx, subjectId);
    if (found) {
      customer = found;
    } else if (status === undefined) {
      throw err;
    } else {
      customer = await ctx.stripe.customers.create(params, {
        idempotencyKey: `context-kit-billing:customer:${subjectId}:retry:${Date.now()}`,
      });
    }
  }

  await ctx.db
    .insert(billingCustomer)
    .values({ subjectId, stripeCustomerId: customer.id, livemode: customer.livemode })
    .onConflictDoNothing({ target: billingCustomer.subjectId });

  // Re-read: a concurrent call may have inserted first. Both hold the same id.
  return (await getCustomerId(ctx.db, subjectId)) ?? customer.id;
}
