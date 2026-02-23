import type { PlanDefinition } from "./types";

// biome-ignore lint/suspicious/noExplicitAny: structural duck-typing for Prisma client
type PrismaClientLike = any;
// biome-ignore lint/suspicious/noExplicitAny: structural duck-typing for Stripe client
type StripeClientLike = any;

type WebhookHandlerDeps = {
  stripe: StripeClientLike;
  prisma: PrismaClientLike;
  plans: Map<string, PlanDefinition>;
  webhookSecret: string;
};

type StripeSubscriptionObject = {
  id: string;
  customer: string;
  status: string;
  items: {
    data: Array<{
      price: { id: string };
      recurring?: { interval: string };
    }>;
  };
  current_period_start: number;
  current_period_end: number;
  cancel_at_period_end: boolean;
  metadata?: Record<string, string>;
};

type StripeCheckoutSession = {
  id: string;
  customer: string;
  subscription: string;
  metadata?: Record<string, string>;
  mode: string;
  payment_status: string;
};

type StripeInvoice = {
  id: string;
  customer: string;
  subscription: string;
  status: string;
};

type StripeEvent = {
  id: string;
  type: string;
  data: { object: unknown };
};

function resolveInterval(stripeSub: StripeSubscriptionObject): string {
  const firstItem = stripeSub.items.data[0];
  const rawInterval = firstItem?.recurring?.interval ?? "";
  // Stripe uses "month"/"year", normalize to "monthly"/"yearly"
  if (rawInterval === "month") return "monthly";
  if (rawInterval === "year") return "yearly";
  return rawInterval;
}

function resolvePlanId(
  stripeSub: StripeSubscriptionObject,
  plans: Map<string, PlanDefinition>,
): string {
  // Prefer planId from metadata if set
  if (stripeSub.metadata?.planId) return stripeSub.metadata.planId;

  // Fall back to finding a matching plan by price ID
  const priceId = stripeSub.items.data[0]?.price.id;
  for (const [id, plan] of plans) {
    if (plan.stripePriceId === priceId) return id;
    if (plan.stripePriceIds) {
      for (const pid of Object.values(plan.stripePriceIds)) {
        if (pid === priceId) return id;
      }
    }
  }

  if (!priceId) {
    throw new Error(
      `resolvePlanId: subscription "${stripeSub.id}" has no price ID and no planId metadata.`,
    );
  }

  throw new Error(
    `resolvePlanId: no plan found for subscription "${stripeSub.id}" with price ID "${priceId}".`,
  );
}

async function upsertSubscriptionFromStripe(
  stripeSub: StripeSubscriptionObject,
  prisma: PrismaClientLike,
  plans: Map<string, PlanDefinition>,
): Promise<void> {
  const customer = await prisma.customer.findUnique({
    where: { stripeCustomerId: stripeSub.customer },
  });
  if (!customer) return;

  const priceId = stripeSub.items.data[0]?.price.id ?? null;
  const planId = resolvePlanId(stripeSub, plans);
  const interval = resolveInterval(stripeSub);

  await prisma.subscription.upsert({
    where: { stripeSubscriptionId: stripeSub.id },
    create: {
      customerId: customer.id,
      stripeSubscriptionId: stripeSub.id,
      stripePriceId: priceId,
      planId,
      status: stripeSub.status,
      interval,
      currentPeriodStart: new Date(stripeSub.current_period_start * 1000),
      currentPeriodEnd: new Date(stripeSub.current_period_end * 1000),
      cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
    },
    update: {
      stripePriceId: priceId,
      planId,
      status: stripeSub.status,
      interval,
      currentPeriodStart: new Date(stripeSub.current_period_start * 1000),
      currentPeriodEnd: new Date(stripeSub.current_period_end * 1000),
      cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
    },
  });
}

async function handleCheckoutSessionCompleted(
  session: StripeCheckoutSession,
  prisma: PrismaClientLike,
  plans: Map<string, PlanDefinition>,
): Promise<void> {
  if (session.mode !== "subscription" || !session.subscription) return;

  const customer = await prisma.customer.findUnique({
    where: { stripeCustomerId: session.customer },
  });
  if (!customer) return;

  const planId = session.metadata?.planId ?? "unknown";

  await prisma.subscription.upsert({
    where: { stripeSubscriptionId: session.subscription },
    create: {
      customerId: customer.id,
      stripeSubscriptionId: session.subscription,
      stripePriceId: null,
      planId,
      status: "active",
      interval: null,
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(),
      cancelAtPeriodEnd: false,
    },
    update: {
      planId,
      status: "active",
    },
  });
}

async function handleSubscriptionDeleted(
  stripeSub: StripeSubscriptionObject,
  prisma: PrismaClientLike,
): Promise<void> {
  const customer = await prisma.customer.findUnique({
    where: { stripeCustomerId: stripeSub.customer },
  });
  if (!customer) return;

  const subscription = await prisma.subscription.findFirst({
    where: {
      customerId: customer.id,
      stripeSubscriptionId: stripeSub.id,
    },
  });
  if (!subscription) return;

  await prisma.subscription.update({
    where: { id: subscription.id },
    data: { status: "canceled" },
  });
}

export function toWebhookHandler(
  { stripe, prisma, plans, webhookSecret }: WebhookHandlerDeps,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const rawBody = await req.text();
    const signature = req.headers.get("stripe-signature") ?? "";

    let event: StripeEvent;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret) as StripeEvent;
    } catch {
      return new Response("Webhook signature verification failed.", { status: 400 });
    }

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object as StripeCheckoutSession;
          await handleCheckoutSessionCompleted(session, prisma, plans);
          break;
        }

        case "customer.subscription.created":
        case "customer.subscription.updated": {
          const sub = event.data.object as StripeSubscriptionObject;
          await upsertSubscriptionFromStripe(sub, prisma, plans);
          break;
        }

        case "customer.subscription.deleted": {
          const sub = event.data.object as StripeSubscriptionObject;
          await handleSubscriptionDeleted(sub, prisma);
          break;
        }

        case "invoice.paid": {
          const invoice = event.data.object as StripeInvoice;
          if (invoice.subscription) {
            const sub = await prisma.subscription.findFirst({
              where: { stripeSubscriptionId: invoice.subscription },
            });
            if (sub && sub.status === "past_due") {
              await prisma.subscription.update({
                where: { id: sub.id },
                data: { status: "active" },
              });
            }
          }
          break;
        }

        case "invoice.payment_failed": {
          const invoice = event.data.object as StripeInvoice;
          if (invoice.subscription) {
            const sub = await prisma.subscription.findFirst({
              where: { stripeSubscriptionId: invoice.subscription },
            });
            // Only mark as past_due if the subscription is still active-ish.
            // Don't overwrite canceled/incomplete_expired status.
            if (sub && sub.status !== "canceled" && sub.status !== "incomplete_expired") {
              await prisma.subscription.update({
                where: { id: sub.id },
                data: { status: "past_due" },
              });
            }
          }
          break;
        }

        default: {
          // Unknown events are gracefully ignored
          break;
        }
      }
    } catch (err) {
      console.error(
        `Webhook error [event.id=${event.id}, event.type=${event.type}]:`,
        err instanceof Error ? err.message : err,
      );
      return new Response("Internal server error processing webhook.", { status: 500 });
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}
