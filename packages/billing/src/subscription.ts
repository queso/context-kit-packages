import type { PrismaSubscription } from "./prisma";
import type {
  FreeTierConfig,
  PlanDefinition,
  PlanWithPeriod,
  SubscriptionData,
} from "./types";
import { BillingError } from "./types";

const ACTIVE_STATUSES = [
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "incomplete",
];

// biome-ignore lint/suspicious/noExplicitAny: structural duck-typing for Prisma client
type PrismaClientLike = any;

type SubscriptionDeps = {
  prisma: PrismaClientLike;
  plans: Map<string, PlanDefinition>;
  freeTier?: FreeTierConfig;
};

function toSubscriptionData(
  sub: PrismaSubscription,
  plan: PlanDefinition
): SubscriptionData {
  return {
    id: sub.id,
    customerId: sub.customerId,
    stripeSubscriptionId: sub.stripeSubscriptionId,
    stripePriceId: sub.stripePriceId,
    planId: sub.planId,
    plan,
    status: sub.status as SubscriptionData["status"],
    interval: sub.interval,
    currentPeriodStart: sub.currentPeriodStart,
    currentPeriodEnd: sub.currentPeriodEnd,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
  };
}

export async function getSubscription(
  userId: string,
  { prisma, plans }: SubscriptionDeps
): Promise<SubscriptionData | null> {
  const customer = await prisma.customer.findUnique({ where: { userId } });
  if (!customer) return null;

  const subs: PrismaSubscription[] = await prisma.subscription.findMany({
    where: {
      customerId: customer.id,
      status: { in: ACTIVE_STATUSES },
    },
    orderBy: { createdAt: "desc" },
  });

  if (subs.length === 0) return null;

  // Pick most recently created
  const sub = subs.reduce((latest, s) =>
    s.createdAt > latest.createdAt ? s : latest
  );

  const plan = plans.get(sub.planId);
  if (!plan) {
    throw new BillingError(
      `Plan "${sub.planId}" not found in plans configuration.`
    );
  }

  return toSubscriptionData(sub, plan);
}

export async function getPlan(
  userId: string,
  { prisma, plans, freeTier }: SubscriptionDeps
): Promise<PlanWithPeriod | null> {
  const subscription = await getSubscription(userId, {
    prisma,
    plans,
    freeTier,
  });

  if (subscription) {
    return subscription.plan;
  }

  if (freeTier) {
    const freePlan = plans.get(freeTier.planId);
    if (!freePlan) return null;

    const now = new Date();
    const currentPeriodStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    );
    const currentPeriodEnd = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
    );

    return { ...freePlan, currentPeriodStart, currentPeriodEnd };
  }

  return null;
}
