import { BillingError } from "./types";
import type { PlanDefinition } from "./types";
import { getOrCreateCustomer } from "./customer";

// biome-ignore lint/suspicious/noExplicitAny: structural duck-typing
type PrismaClientLike = any;
// biome-ignore lint/suspicious/noExplicitAny: structural duck-typing
type StripeClientLike = any;

type CheckoutParams = {
  userId: string;
  planId: string;
  interval?: string;
  successUrl: string;
  cancelUrl: string;
};

type CheckoutDeps = {
  prisma: PrismaClientLike;
  stripe: StripeClientLike;
  plans: Map<string, PlanDefinition>;
};

function resolvePriceId(plan: PlanDefinition, interval?: string): string {
  // When an interval is explicitly requested and stripePriceIds is present, prefer it.
  if (interval && plan.stripePriceIds) {
    const key = interval as keyof typeof plan.stripePriceIds;
    const priceId = plan.stripePriceIds[key];
    if (priceId) return priceId;
    throw new BillingError(
      `Plan "${plan.id}" has no price for interval "${interval}".`
    );
  }

  if (plan.stripePriceId) return plan.stripePriceId;

  if (plan.stripePriceIds) {
    const key = "monthly" as keyof typeof plan.stripePriceIds;
    const priceId = plan.stripePriceIds[key];
    if (priceId) return priceId;
    throw new BillingError(
      `Plan "${plan.id}" has no price for interval "monthly".`
    );
  }

  throw new BillingError(
    `Plan "${plan.id}" has no Stripe price configured.`
  );
}

export async function createCheckoutSession(
  { userId, planId, interval, successUrl, cancelUrl }: CheckoutParams,
  { prisma, stripe, plans }: CheckoutDeps,
): Promise<{ sessionId: string; url: string }> {
  const plan = plans.get(planId);
  if (!plan) {
    throw new BillingError(`Plan "${planId}" not found.`);
  }
  if (plan.isFree) {
    throw new BillingError("Cannot checkout a free plan");
  }

  const priceId = resolvePriceId(plan, interval);

  const customer = await getOrCreateCustomer(userId, { prisma, stripe });

  const session = await stripe.checkout.sessions.create({
    customer: customer.stripeCustomerId,
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    subscription_data: {
      metadata: { userId, planId },
    },
  });

  return { sessionId: session.id, url: session.url };
}
