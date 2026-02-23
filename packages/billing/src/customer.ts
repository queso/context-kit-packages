import type { PrismaCustomer } from "./prisma";
import { BillingError } from "./types";

type PrismaClientLike = {
  customer: {
    findUnique: (args: { where: Record<string, string> }) => Promise<PrismaCustomer | null>;
    create: (args: { data: Record<string, string> }) => Promise<PrismaCustomer>;
  };
};

type StripeClientLike = {
  customers: {
    create: (args: { metadata: Record<string, string> }) => Promise<{ id: string }>;
  };
};

type CustomerDeps = {
  prisma: PrismaClientLike;
};

type CustomerAndStripeDeps = {
  prisma: PrismaClientLike;
  stripe: StripeClientLike;
};

export async function getCustomerByUserId(
  userId: string,
  { prisma }: CustomerDeps,
): Promise<PrismaCustomer | null> {
  return prisma.customer.findUnique({ where: { userId } });
}

export async function getCustomerByStripeId(
  stripeCustomerId: string,
  { prisma }: CustomerDeps,
): Promise<PrismaCustomer | null> {
  return prisma.customer.findUnique({ where: { stripeCustomerId } });
}

export async function getOrCreateCustomer(
  userId: string,
  { prisma, stripe }: CustomerAndStripeDeps,
): Promise<PrismaCustomer> {
  const existing = await prisma.customer.findUnique({ where: { userId } });
  if (existing) return existing;

  const stripeCustomer = await stripe.customers.create({ metadata: { userId } });

  try {
    return await prisma.customer.create({
      data: { userId, stripeCustomerId: stripeCustomer.id },
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "P2002") {
      const recovered = await prisma.customer.findUnique({ where: { userId } });
      if (recovered) return recovered;
      throw new BillingError(
        `Failed to create customer for user "${userId}": unique constraint violation occurred but recovery lookup returned null.`,
      );
    }
    throw err;
  }
}
