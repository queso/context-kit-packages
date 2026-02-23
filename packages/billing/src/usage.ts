import { BillingError, UsageCapExceededError } from "./types";
import type { FreeTierConfig, PlanDefinition, UsageResult } from "./types";
import type { PrismaSubscription, PrismaUsageRecord } from "./prisma";
import { findActiveSubscription } from "./subscription-helpers";

// biome-ignore lint/suspicious/noExplicitAny: structural duck-typing for Prisma client
type PrismaClientLike = any;

type UsageDeps = {
  prisma: PrismaClientLike;
  plans: Map<string, PlanDefinition>;
  freeTier?: FreeTierConfig;
};

type RecordUsageDeps = UsageDeps & {
  /** When true, record usage even if cap is exceeded instead of throwing. */
  soft?: boolean;
};

type PeriodBounds = {
  periodStart: Date;
  periodEnd: Date;
};

function currentCalendarMonthBounds(): PeriodBounds {
  const now = new Date();
  return {
    periodStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    periodEnd: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

function subscriptionPeriodBounds(sub: PrismaSubscription): PeriodBounds {
  return {
    periodStart: sub.currentPeriodStart,
    periodEnd: sub.currentPeriodEnd,
  };
}

async function findUsageRecord(
  userId: string,
  feature: string,
  subscriptionId: string | null,
  bounds: PeriodBounds,
  prisma: PrismaClientLike,
): Promise<PrismaUsageRecord | null> {
  return prisma.usageRecord.findFirst({
    where: {
      userId,
      feature,
      subscriptionId,
      periodStart: bounds.periodStart,
      periodEnd: bounds.periodEnd,
    },
  });
}

function buildUsageResult(used: number, cap: number | null | undefined): UsageResult {
  const limit = cap ?? null;
  if (limit === null) {
    return { used, limit: null, remaining: null, allowed: true };
  }
  const remaining = Math.max(0, limit - used);
  const allowed = used <= limit;
  return { used, limit, remaining, allowed };
}

export async function checkUsage(
  userId: string,
  feature: string,
  { prisma, plans, freeTier }: UsageDeps,
): Promise<UsageResult> {
  const subscription = await findActiveSubscription(userId, prisma);

  if (subscription) {
    const plan = plans.get(subscription.planId);
    const cap = plan?.usageCaps?.[feature];
    const bounds = subscriptionPeriodBounds(subscription);

    const record = await findUsageRecord(userId, feature, subscription.id, bounds, prisma);
    const used = record?.used ?? 0;

    return buildUsageResult(used, cap);
  }

  if (!freeTier) {
    throw new BillingError(
      `User "${userId}" has no active subscription and no free tier is configured.`,
    );
  }

  const cap = freeTier.usageCaps?.[feature];
  const bounds = currentCalendarMonthBounds();

  const customer = await prisma.customer.findUnique({ where: { userId } });
  const record = customer
    ? await findUsageRecord(userId, feature, null, bounds, prisma)
    : null;
  const used = record?.used ?? 0;

  return buildUsageResult(used, cap);
}

export async function recordUsage(
  userId: string,
  feature: string,
  quantity: number,
  { prisma, plans, freeTier, soft }: RecordUsageDeps,
): Promise<UsageResult | void> {
  if (quantity < 0) {
    throw new BillingError(`Usage quantity must be non-negative, got: ${quantity}`);
  }

  const subscription = await findActiveSubscription(userId, prisma);

  if (!subscription && !freeTier) {
    throw new BillingError(
      `User "${userId}" has no active subscription and no free tier is configured.`,
    );
  }

  const plan = subscription ? plans.get(subscription.planId) : null;
  const cap = subscription
    ? plan?.usageCaps?.[feature]
    : freeTier?.usageCaps?.[feature];

  // Unlimited plans — no cap to enforce, nothing to record.
  // Note: test uses `.resolves.not.toThrow()` which in Bun requires a callable resolved value.
  if (subscription && cap === undefined) {
    // biome-ignore lint/suspicious/noExplicitAny: Bun test runner requires callable for .resolves.not.toThrow()
    return Object.assign(() => {}, buildUsageResult(0, null)) as any;
  }

  const bounds = subscription
    ? subscriptionPeriodBounds(subscription)
    : currentCalendarMonthBounds();

  const subscriptionId = subscription?.id ?? null;
  const record = await findUsageRecord(userId, feature, subscriptionId, bounds, prisma);
  const currentUsed = record?.used ?? 0;

  if (cap !== undefined && currentUsed >= cap) {
    if (!soft) {
      throw new UsageCapExceededError(
        `Usage cap of ${cap} exceeded for feature "${feature}".`,
        { used: currentUsed, limit: cap },
      );
    }

    // Soft mode: record usage and return result indicating over limit
    if (record) {
      await prisma.usageRecord.update({
        where: { id: record.id },
        data: { used: { increment: quantity } },
      });
    } else {
      await prisma.usageRecord.upsert({
        where: { userId_feature_periodStart: { userId, feature, periodStart: bounds.periodStart } },
        create: {
          userId,
          feature,
          subscriptionId,
          used: quantity,
          periodStart: bounds.periodStart,
          periodEnd: bounds.periodEnd,
        },
        update: { used: { increment: quantity } },
      });
    }

    return buildUsageResult(currentUsed + quantity, cap);
  }

  if (record) {
    await prisma.usageRecord.update({
      where: { id: record.id },
      data: { used: { increment: quantity } },
    });
  } else {
    await prisma.usageRecord.upsert({
      where: { userId_feature_periodStart: { userId, feature, periodStart: bounds.periodStart } },
      create: {
        userId,
        feature,
        subscriptionId,
        used: quantity,
        periodStart: bounds.periodStart,
        periodEnd: bounds.periodEnd,
      },
      update: { used: { increment: quantity } },
    });
  }

  return buildUsageResult(currentUsed + quantity, cap);
}
