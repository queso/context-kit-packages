import { getOrCreateCustomer } from "./customer";
import { resolvePriceId } from "./pricing";
import type { PlanDefinition } from "./types";
import { BillingError } from "./types";

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

function validateUrl(url: string, fieldName: string): void {
  try {
    new URL(url);
  } catch {
    throw new BillingError(
      `Invalid ${fieldName}: "${url}" is not a valid URL.`
    );
  }
}

export async function createCheckoutSession(
  { userId, planId, interval, successUrl, cancelUrl }: CheckoutParams,
  { prisma, stripe, plans }: CheckoutDeps
): Promise<{ sessionId: string; url: string }> {
  validateUrl(successUrl, "successUrl");
  validateUrl(cancelUrl, "cancelUrl");

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
