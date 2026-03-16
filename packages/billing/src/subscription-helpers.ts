import type { PrismaSubscription } from "./prisma";

// biome-ignore lint/suspicious/noExplicitAny: structural duck-typing for Prisma client
type PrismaClientLike = any;

export const ACTIVE_STATUSES = [
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "incomplete",
];

export async function findActiveSubscription(
  userId: string,
  prisma: PrismaClientLike
): Promise<PrismaSubscription | null> {
  const customer = await prisma.customer.findUnique({ where: { userId } });
  if (!customer) return null;

  return prisma.subscription.findFirst({
    where: {
      customerId: customer.id,
      status: { in: ACTIVE_STATUSES },
    },
    orderBy: { createdAt: "desc" },
  });
}
