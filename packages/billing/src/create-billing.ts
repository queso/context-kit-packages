import Stripe from "stripe";
import { createCheckoutSession } from "./checkout.js";
import { changePlan, cancelSubscription, reactivateSubscription } from "./manage.js";
import { getSubscription } from "./subscription.js";
import type {
  BillingConfig,
  BillingInstance,
  CancelParams,
  ChangePlanParams,
  CheckoutSessionParams,
  PlanDefinition,
} from "./types.js";
import { InvalidConfigError } from "./types.js";
import { checkUsage, recordUsage } from "./usage.js";

/**
 * Creates a configured billing instance wired to Prisma and Stripe.
 *
 * Validates required configuration, reads env-var fallbacks for
 * STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET, validates plan definitions,
 * and returns a ready-to-use BillingInstance.
 */
export function createBilling(config: BillingConfig): BillingInstance {
  // Validate prisma
  if (!config.prisma) {
    throw new InvalidConfigError(
      "A Prisma client instance is required. Pass your PrismaClient as the `prisma` option."
    );
  }

  // Resolve Stripe secret key
  const stripeSecretKey = config.stripeSecretKey ?? process.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    throw new InvalidConfigError(
      "A Stripe secret key is required. Set STRIPE_SECRET_KEY as an environment variable or pass `stripeSecretKey` in config."
    );
  }

  // Resolve Stripe webhook secret
  const stripeWebhookSecret =
    config.stripeWebhookSecret ?? process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripeWebhookSecret) {
    throw new InvalidConfigError(
      "A Stripe webhook secret is required. Set STRIPE_WEBHOOK_SECRET as an environment variable or pass `stripeWebhookSecret` in config."
    );
  }

  // Validate plans array
  if (!Array.isArray(config.plans) || config.plans.length === 0) {
    throw new InvalidConfigError(
      "At least one plan definition is required. Pass a non-empty `plans` array in config."
    );
  }

  // Validate each plan and build lookup map
  const planMap = new Map<string, PlanDefinition>();

  for (const plan of config.plans) {
    if (!plan.id) {
      throw new InvalidConfigError(
        `Plan is missing a required 'id' field. Each plan must have a non-empty id.`
      );
    }
    if (!plan.name) {
      throw new InvalidConfigError(
        `Plan "${plan.id}" is missing a required 'name' field.`
      );
    }
    if (!plan.isFree && !plan.stripePriceId && !plan.stripePriceIds) {
      throw new InvalidConfigError(
        `Plan "${plan.id}" must have 'stripePriceId' or 'stripePriceIds' unless 'isFree' is true.`
      );
    }
    planMap.set(plan.id, plan);
  }

  // Add synthetic free plan from freeTier config if provided
  if (config.freeTier) {
    const { planId, name, usageCaps } = config.freeTier;
    if (!planMap.has(planId)) {
      planMap.set(planId, {
        id: planId,
        name,
        isFree: true,
        usageCaps,
      });
    }
  }

  // Initialize Stripe client
  const stripe = new Stripe(stripeSecretKey);

  // Expose stripe and config context for future method implementations
  const ctx = {
    prisma: config.prisma,
    stripe,
    stripeWebhookSecret,
    planMap,
  };

  return {
    getPlan(planId: string): PlanDefinition {
      const plan = ctx.planMap.get(planId);
      if (!plan) {
        throw new InvalidConfigError(`Plan "${planId}" not found.`);
      }
      return plan;
    },

    // biome-ignore lint/suspicious/noExplicitAny: module returns SubscriptionData|null; interface contracts non-null
    async getSubscription(userId: string): Promise<any> {
      return getSubscription(userId, { prisma: ctx.prisma, plans: ctx.planMap, freeTier: config.freeTier });
    },

    async checkUsage(userId: string, feature: string) {
      return checkUsage(userId, feature, { prisma: ctx.prisma, plans: ctx.planMap, freeTier: config.freeTier });
    },

    // biome-ignore lint/suspicious/noExplicitAny: module returns UsageResult|void; interface contracts void
    async recordUsage(userId: string, feature: string, quantity: number): Promise<any> {
      return recordUsage(userId, feature, quantity, { prisma: ctx.prisma, plans: ctx.planMap, freeTier: config.freeTier });
    },

    async createCheckoutSession(params: CheckoutSessionParams) {
      return createCheckoutSession(params, { prisma: ctx.prisma, stripe: ctx.stripe, plans: ctx.planMap });
    },

    async changePlan(userId: string, params: ChangePlanParams) {
      return changePlan(userId, params, { prisma: ctx.prisma, stripe: ctx.stripe, plans: ctx.planMap });
    },

    async cancelSubscription(userId: string, params?: CancelParams) {
      return cancelSubscription(userId, params ?? {}, { prisma: ctx.prisma, stripe: ctx.stripe, plans: ctx.planMap });
    },

    async reactivateSubscription(userId: string) {
      return reactivateSubscription(userId, { prisma: ctx.prisma, stripe: ctx.stripe, plans: ctx.planMap });
    },
  };
}
