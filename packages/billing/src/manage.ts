import { BillingError, SubscriptionStateError } from "./types";
import type { CancelParams, PlanDefinition } from "./types";
import type { PrismaSubscription } from "./prisma";
import { resolvePriceId } from "./pricing";
import { findActiveSubscription } from "./subscription-helpers";

// biome-ignore lint/suspicious/noExplicitAny: structural duck-typing for Prisma client
type PrismaClientLike = any;
// biome-ignore lint/suspicious/noExplicitAny: structural duck-typing for Stripe client
type StripeClientLike = any;

type ManageDeps = {
  prisma: PrismaClientLike;
  stripe: StripeClientLike;
  plans: Map<string, PlanDefinition>;
};

type ChangePlanParams = {
  planId: string;
  interval?: string;
  prorate?: boolean;
};

export async function changePlan(
  userId: string,
  params: ChangePlanParams,
  { prisma, stripe, plans }: ManageDeps,
): Promise<void> {
  const subscription = await findActiveSubscription(userId, prisma);
  if (!subscription) {
    throw new SubscriptionStateError(`User "${userId}" has no active subscription to change.`);
  }

  if (subscription.status === "past_due") {
    throw new SubscriptionStateError(
      `Subscription is past due. Resolve payment before changing plans.`,
    );
  }

  const targetPlan = plans.get(params.planId);
  if (!targetPlan) {
    throw new BillingError(`Plan "${params.planId}" not found in plans configuration.`);
  }

  if (targetPlan.isFree) {
    throw new BillingError(
      `Cannot change to free plan "${params.planId}" via changePlan. Use cancelSubscription instead.`,
    );
  }

  const newPriceId = resolvePriceId(targetPlan, params.interval);
  const prorate = params.prorate !== false;

  const result = await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
    items: [{ price: newPriceId }],
    proration_behavior: prorate ? "create_prorations" : "none",
  });

  if (result.status === "canceled" || result.status === "incomplete_expired") {
    throw new SubscriptionStateError(
      `Stripe subscription update resulted in unexpected status: ${result.status}`,
    );
  }

  await prisma.subscription.update({
    where: { id: subscription.id },
    data: {
      planId: params.planId,
      stripePriceId: newPriceId,
    },
  });
}

export async function cancelSubscription(
  userId: string,
  params: CancelParams,
  { prisma, stripe, plans: _plans }: ManageDeps,
): Promise<void> {
  const customer = await prisma.customer.findUnique({ where: { userId } });
  if (!customer) {
    throw new SubscriptionStateError(`User "${userId}" has no subscription to cancel.`);
  }

  const subscription: PrismaSubscription | null = await prisma.subscription.findFirst({
    where: { customerId: customer.id },
    orderBy: { createdAt: "desc" },
  });

  if (!subscription) {
    throw new SubscriptionStateError(`User "${userId}" has no subscription to cancel.`);
  }

  const isCanceled = subscription.status === "canceled";

  // No-op if already canceled (applies to both immediate and non-immediate)
  if (isCanceled || (!params.immediate && subscription.cancelAtPeriodEnd)) {
    return;
  }

  if (params.immediate) {
    await stripe.subscriptions.cancel(subscription.stripeSubscriptionId);
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: { status: "canceled" },
    });
    return;
  }

  await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
    cancel_at_period_end: true,
  });

  await prisma.subscription.update({
    where: { id: subscription.id },
    data: { cancelAtPeriodEnd: true },
  });
}

export async function reactivateSubscription(
  userId: string,
  { prisma, stripe, plans: _plans }: ManageDeps,
): Promise<void> {
  const customer = await prisma.customer.findUnique({ where: { userId } });
  if (!customer) {
    throw new SubscriptionStateError(`User "${userId}" has no subscription to reactivate.`);
  }

  const subscription: PrismaSubscription | null = await prisma.subscription.findFirst({
    where: { customerId: customer.id },
    orderBy: { createdAt: "desc" },
  });

  if (!subscription) {
    throw new SubscriptionStateError(`User "${userId}" has no subscription to reactivate.`);
  }

  if (subscription.status === "canceled") {
    throw new SubscriptionStateError(
      `Subscription is fully canceled and cannot be reactivated. Create a new subscription instead.`,
    );
  }

  if (!subscription.cancelAtPeriodEnd) {
    throw new SubscriptionStateError(
      `Subscription is not pending cancellation and does not need reactivation.`,
    );
  }

  await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
    cancel_at_period_end: false,
  });

  await prisma.subscription.update({
    where: { id: subscription.id },
    data: { cancelAtPeriodEnd: false },
  });
}
