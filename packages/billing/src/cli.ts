#!/usr/bin/env node

// biome-ignore lint/suspicious/noExplicitAny: structural duck-typing for injected clients
type PrismaClientLike = any;
// biome-ignore lint/suspicious/noExplicitAny: structural duck-typing for injected clients
type StripeClientLike = any;

type ResyncOptions = {
  prisma: PrismaClientLike;
  stripe: StripeClientLike | undefined;
  exitOnComplete?: boolean;
};

type ResyncSummary = {
  synced: number;
  errors: number;
  canceled: number;
  skipped: number;
};

export async function runResync({
  prisma,
  stripe: stripeParam,
  exitOnComplete = false,
}: ResyncOptions): Promise<ResyncSummary> {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey && !stripeParam) {
    console.error("Error: STRIPE_SECRET_KEY environment variable is required.");
    process.exit(1);
  }

  // If no stripe client was injected, construct one from the env key.
  let stripe = stripeParam;
  if (!stripe) {
    const Stripe = (await import("stripe")).default;
    stripe = new Stripe(stripeKey as string);
  }

  const summary: ResyncSummary = { synced: 0, errors: 0, canceled: 0, skipped: 0 };
  const syncedStripeSubIds = new Set<string>();

  try {
    // Paginate through all Stripe subscriptions
    let hasMore = true;
    let startingAfter: string | undefined;

    while (hasMore) {
      const params: Record<string, unknown> = { limit: 100, status: "all" };
      if (startingAfter) params.starting_after = startingAfter;

      const response = await stripe.subscriptions.list(params);
      const stripeSubs: any[] = response.data;
      hasMore = response.has_more;

      if (stripeSubs.length > 0) {
        startingAfter = stripeSubs[stripeSubs.length - 1].id;
      }

      for (const stripeSub of stripeSubs) {
        // Skip canceled subscriptions — don't create new local records for them
        if (stripeSub.status === "canceled") {
          continue;
        }

        // Find local customer by Stripe customer ID
        const localCustomer = await prisma.customer.findUnique({
          where: { stripeCustomerId: stripeSub.customer },
        });

        if (!localCustomer) {
          summary.skipped += 1;
          continue;
        }

        syncedStripeSubIds.add(stripeSub.id);

        const item = stripeSub.items?.data?.[0];
        const priceId = item?.price?.id ?? null;
        const interval = item?.recurring?.interval === "year" ? "yearly" : "monthly";
        const planId = stripeSub.metadata?.planId ?? null;

        try {
          await prisma.subscription.upsert({
            where: { stripeSubscriptionId: stripeSub.id },
            create: {
              customerId: localCustomer.id,
              stripeSubscriptionId: stripeSub.id,
              stripePriceId: priceId,
              planId: planId ?? "unknown",
              status: stripeSub.status,
              interval,
              currentPeriodStart: new Date(stripeSub.current_period_start * 1000),
              currentPeriodEnd: new Date(stripeSub.current_period_end * 1000),
              cancelAtPeriodEnd: stripeSub.cancel_at_period_end ?? false,
            },
            update: {
              stripePriceId: priceId,
              planId: planId ?? "unknown",
              status: stripeSub.status,
              interval,
              currentPeriodStart: new Date(stripeSub.current_period_start * 1000),
              currentPeriodEnd: new Date(stripeSub.current_period_end * 1000),
              cancelAtPeriodEnd: stripeSub.cancel_at_period_end ?? false,
            },
          });
          summary.synced += 1;
        } catch (err) {
          console.error(`Error upserting subscription ${stripeSub.id}:`, err);
          summary.errors += 1;
        }
      }
    }

    // Mark local active subscriptions not present in Stripe response as canceled
    const cancelResult = await prisma.subscription.updateMany({
      where: {
        status: { in: ["active", "trialing", "past_due", "unpaid", "incomplete"] },
        stripeSubscriptionId: { notIn: Array.from(syncedStripeSubIds) },
      },
      data: { status: "canceled" },
    });
    summary.canceled = cancelResult.count ?? 0;

  } catch (err) {
    console.error("Fatal error during resync:", err);
    summary.errors += 1;

    console.log(`Resync complete — synced: ${summary.synced}, canceled: ${summary.canceled}, skipped: ${summary.skipped}, errors: ${summary.errors}`);

    if (exitOnComplete) process.exit(1);
    return summary;
  }

  console.log(`Resync complete — synced: ${summary.synced}, canceled: ${summary.canceled}, skipped: ${summary.skipped}, errors: ${summary.errors}`);

  if (exitOnComplete) {
    if (summary.errors > 0) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  }

  return summary;
}

// CLI entry point
if (import.meta.main) {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    console.error("Error: STRIPE_SECRET_KEY environment variable is required.");
    process.exit(1);
  }

  console.error(
    "Error: The billing CLI requires a PrismaClient instance that cannot be auto-detected.\n" +
    "Use the programmatic API instead:\n\n" +
    '  import { runResync } from "@context-kit/billing/cli";\n' +
    "  await runResync({ prisma, stripe });\n",
  );
  process.exit(1);
}
