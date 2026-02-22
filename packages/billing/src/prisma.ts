/**
 * Type aliases for the billing Prisma models.
 *
 * These mirror the shapes defined in prisma/schema.prisma and let package
 * code reference model types without importing generated Prisma client types
 * directly (the generated client lives in the consumer's project, not here).
 */

export type PrismaCustomer = {
  id: string;
  userId: string;
  stripeCustomerId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type PrismaSubscription = {
  id: string;
  customerId: string;
  stripeSubscriptionId: string | null;
  stripePriceId: string | null;
  planId: string;
  status: string;
  interval: string | null;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type PrismaUsageRecord = {
  id: string;
  subscriptionId: string | null;
  userId: string;
  feature: string;
  used: number;
  periodStart: Date;
  periodEnd: Date;
  createdAt: Date;
  updatedAt: Date;
};
