import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { billingCustomer, billingWebhookEvent } from "./schema/postgres.js";
import { syncSubscription, type SyncResult } from "./subscriptions.js";
import type { BillingContext } from "./types.js";

export interface WebhookHandlerOptions {
  /** The endpoint's signing secret (`whsec_...`). */
  secret: string;
  /** Signature timestamp tolerance in seconds. Defaults to stripe-node's 300. Never 0, which disables the check. */
  tolerance?: number;
}

export type EventOutcome = "processed" | "duplicate" | "ignored" | "unknown_subject";

const SUBSCRIPTION_EVENTS = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "customer.subscription.trial_will_end",
]);
const CHECKOUT_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
]);
const INVOICE_EVENTS = new Set([
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_action_required",
  "invoice.finalized",
]);

const idOf = (v: string | { id: string } | null | undefined): string | null =>
  v == null ? null : typeof v === "string" ? v : v.id;

function isResourceMissing(err: unknown): boolean {
  const e = err as { statusCode?: number; code?: string };
  return e.statusCode === 404 && e.code === "resource_missing";
}

function objectId(event: Stripe.Event): string | null {
  const obj = event.data.object as { id?: unknown };
  return typeof obj.id === "string" ? obj.id : null;
}

/**
 * Handles one verified event. Never applies the payload: it only learns which
 * object changed and re-fetches it, so delivery order does not matter and a
 * second run writes the same rows.
 */
async function handleEvent(ctx: BillingContext, event: Stripe.Event): Promise<SyncResult | null> {
  if (SUBSCRIPTION_EVENTS.has(event.type)) {
    const id = objectId(event);
    return id ? syncSubscription(ctx, id) : null;
  }

  if (CHECKOUT_EVENTS.has(event.type)) {
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.mode !== "subscription") return null;
    const subscriptionId = idOf(session.subscription);
    const customerId = idOf(session.customer);
    if (session.client_reference_id && customerId) {
      // The app passed its subject as client_reference_id. Normally the
      // customer row already exists (ensureCustomer runs before checkout);
      // this covers a customer Checkout created itself.
      await ctx.db
        .insert(billingCustomer)
        .values({
          subjectId: session.client_reference_id,
          stripeCustomerId: customerId,
          livemode: session.livemode,
        })
        .onConflictDoNothing();
    }
    return subscriptionId ? syncSubscription(ctx, subscriptionId) : null;
  }

  if (INVOICE_EVENTS.has(event.type)) {
    const invoice = event.data.object as Stripe.Invoice;
    const subscriptionId = idOf(invoice.parent?.subscription_details?.subscription);
    return subscriptionId ? syncSubscription(ctx, subscriptionId) : null;
  }

  return null;
}

/**
 * Records and processes a verified event exactly once. Exposed for apps that
 * verify signatures themselves; most apps use `createWebhookHandler`.
 */
export async function processEvent(ctx: BillingContext, event: Stripe.Event): Promise<EventOutcome> {
  await ctx.db
    .insert(billingWebhookEvent)
    .values({ stripeEventId: event.id, type: event.type, objectId: objectId(event) })
    .onConflictDoNothing({ target: billingWebhookEvent.stripeEventId });

  const [stored] = await ctx.db
    .select({ processedAt: billingWebhookEvent.processedAt })
    .from(billingWebhookEvent)
    .where(eq(billingWebhookEvent.stripeEventId, event.id));
  if (stored?.processedAt) return "duplicate";

  let result: SyncResult | null;
  try {
    result = await handleEvent(ctx, event);
  } catch (err) {
    if (isResourceMissing(err)) {
      // The object is gone (a deleted test clock takes its customers and
      // subscriptions with it). Retrying cannot succeed, so record and acknowledge.
      await ctx.db
        .update(billingWebhookEvent)
        .set({ processedAt: ctx.now?.() ?? new Date(), lastError: "resource_missing" })
        .where(eq(billingWebhookEvent.stripeEventId, event.id));
      return "ignored";
    }
    const message = err instanceof Error ? err.message : String(err);
    await ctx.db
      .update(billingWebhookEvent)
      .set({ lastError: message.slice(0, 1000) })
      .where(eq(billingWebhookEvent.stripeEventId, event.id));
    throw err;
  }

  const unknown = result?.outcome === "unknown_subject";
  await ctx.db
    .update(billingWebhookEvent)
    .set({ processedAt: ctx.now?.() ?? new Date(), lastError: unknown ? "unknown_subject" : null })
    .where(eq(billingWebhookEvent.stripeEventId, event.id));

  if (unknown) return "unknown_subject";
  return result ? "processed" : "ignored";
}

/**
 * Builds a Next.js Route Handler for Stripe webhooks:
 *
 * ```ts
 * // app/api/billing/webhook/route.ts
 * export const POST = billing.webhookHandler;
 * ```
 *
 * It reads the raw body with `request.text()`, which signature verification
 * needs, verifies with `constructEventAsync` (works with Node and Web Crypto),
 * and answers 400 for a bad signature, 500 when processing fails (so Stripe
 * retries), and 200 otherwise.
 */
export function createWebhookHandler(
  ctx: BillingContext,
  options: WebhookHandlerOptions
): (request: Request) => Promise<Response> {
  if (!options.secret) throw new Error("createWebhookHandler needs the endpoint's signing secret");
  if (options.tolerance === 0) throw new Error("A tolerance of 0 disables Stripe's timestamp check");

  return async (request) => {
    const signature = request.headers.get("stripe-signature");
    if (!signature) return Response.json({ error: "missing signature" }, { status: 400 });

    const raw = await request.text();
    let event: Stripe.Event;
    try {
      event = await ctx.stripe.webhooks.constructEventAsync(raw, signature, options.secret, options.tolerance);
    } catch {
      return Response.json({ error: "invalid signature" }, { status: 400 });
    }

    try {
      const outcome = await processEvent(ctx, event);
      return Response.json({ received: true, outcome });
    } catch {
      return Response.json({ error: "processing failed" }, { status: 500 });
    }
  };
}
