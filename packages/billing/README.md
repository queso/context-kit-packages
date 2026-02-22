# @context-kit/billing

Stripe billing backend for [context-kit](https://github.com/queso/context-kit) projects. Provides subscription management, usage tracking, webhook handling, and a resync CLI — wired to your existing Prisma client.

## Requirements

- Node.js 18+ or Bun
- Next.js 14+ (optional — only needed for Route Handler integration)
- Prisma 5+
- A Stripe account with products and prices configured

## Installation

```bash
npm install @context-kit/billing stripe
# or
bun add @context-kit/billing stripe
```

## Prisma Schema

Copy the three models from `prisma/schema.prisma` into your application's schema file, then run:

```bash
npx prisma migrate dev --name add_billing
```

The models are:

- **Customer** — links your app user to a Stripe Customer ID
- **Subscription** — tracks the active (or canceled) Stripe subscription per customer
- **UsageRecord** — per-feature usage counters scoped to a billing period

## Environment Variables

```bash
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

Both can also be passed directly to `createBilling()` via the config object.

## Quick Start

```typescript
// lib/billing.ts
import { createBilling } from "@context-kit/billing";
import { prisma } from "@/lib/prisma";

export const billing = createBilling({
  prisma,
  plans: [
    {
      id: "starter",
      name: "Starter",
      stripePriceIds: {
        monthly: "price_starter_monthly",
        yearly: "price_starter_yearly",
      },
      usageCaps: { ai_requests: 100 },
    },
    {
      id: "pro",
      name: "Pro",
      stripePriceIds: {
        monthly: "price_pro_monthly",
        yearly: "price_pro_yearly",
      },
      usageCaps: { ai_requests: 1000 },
    },
  ],
  freeTier: {
    planId: "free",
    name: "Free",
    usageCaps: { ai_requests: 10 },
  },
});
```

## API Reference

### `createBilling(config)`

Creates a fully configured `BillingInstance`. Throws `InvalidConfigError` if required config is missing or invalid.

```typescript
interface BillingConfig {
  prisma: PrismaClient;
  stripeSecretKey?: string;       // falls back to STRIPE_SECRET_KEY env var
  stripeWebhookSecret?: string;   // falls back to STRIPE_WEBHOOK_SECRET env var
  plans: PlanDefinition[];
  freeTier?: FreeTierConfig;
}
```

#### Plan Definition

```typescript
interface PlanDefinition {
  id: string;
  name: string;
  stripePriceId?: string;         // single price
  stripePriceIds?: {
    monthly?: string;
    yearly?: string;
  };
  usageCaps?: Record<string, number>;  // per-feature limits
  seatLimit?: number;
  isFree?: boolean;               // skip Stripe for this plan
}
```

#### Free Tier

```typescript
interface FreeTierConfig {
  planId: string;   // synthetic plan ID for free users
  name: string;
  usageCaps?: Record<string, number>;
}
```

Free-tier users have no Stripe subscription. Usage periods are scoped to calendar months (UTC).

---

### `billing.getSubscription(userId)`

Returns the user's active subscription, or `null` if none exists.

```typescript
const sub = await billing.getSubscription(userId);
// sub.planId, sub.status, sub.currentPeriodEnd, sub.cancelAtPeriodEnd, ...
```

Returns `null` when the user has no active subscription (active, trialing, past_due, unpaid, or incomplete).

---

### `billing.getPlan(planId)`

Looks up a plan definition by ID. Throws `InvalidConfigError` if the plan is not found.

```typescript
const plan = billing.getPlan("pro");
// plan.id, plan.name, plan.usageCaps, ...
```

---

### `billing.checkUsage(userId, feature)`

Returns the user's current usage for a feature within their billing period.

```typescript
const result = await billing.checkUsage(userId, "ai_requests");
// { used: 42, limit: 100, remaining: 58, allowed: true }
```

```typescript
interface UsageResult {
  used: number;
  limit: number | null;    // null means unlimited
  remaining: number | null;
  allowed: boolean;
}
```

For free-tier users, the period is the current calendar month (UTC). Throws `BillingError` if the user has no subscription and no free tier is configured.

---

### `billing.recordUsage(userId, feature, amount)`

Records usage for a feature. Throws `UsageCapExceededError` when the cap is reached (hard enforcement by default).

```typescript
await billing.recordUsage(userId, "ai_requests", 1);
```

`UsageCapExceededError` includes `used` and `limit` fields for error handling:

```typescript
try {
  await billing.recordUsage(userId, "ai_requests", 1);
} catch (err) {
  if (err instanceof UsageCapExceededError) {
    return Response.json({ error: "limit_reached", used: err.used, limit: err.limit }, { status: 429 });
  }
  throw err;
}
```

---

### `billing.createCheckoutSession(params)`

Creates a Stripe Checkout Session and returns the redirect URL. Automatically creates a Stripe Customer if one does not exist.

```typescript
const { url } = await billing.createCheckoutSession({
  userId,
  planId: "pro",
  successUrl: "https://example.com/billing/success",
  cancelUrl: "https://example.com/billing/cancel",
});

redirect(url);
```

---

### `billing.changePlan(userId, params)`

Changes the user's subscription to a different plan immediately via Stripe. Prorates by default.

```typescript
await billing.changePlan(userId, { planId: "pro", prorate: true });
```

Throws `SubscriptionStateError` if the subscription is past due. Cannot be used to switch to a free plan — use `cancelSubscription` instead.

---

### `billing.cancelSubscription(userId, params?)`

Cancels the user's subscription. Defaults to canceling at the end of the current period.

```typescript
// Cancel at period end (default)
await billing.cancelSubscription(userId);

// Cancel immediately
await billing.cancelSubscription(userId, { immediate: true });
```

---

### `billing.reactivateSubscription(userId)`

Removes a pending cancellation from a subscription (reverses a non-immediate cancel).

```typescript
await billing.reactivateSubscription(userId);
```

Throws `SubscriptionStateError` if the subscription is already fully canceled or not pending cancellation.

---

## Webhook Handler

Wire `toWebhookHandler` into a Next.js Route Handler to keep local subscription state in sync with Stripe.

```typescript
// app/api/webhooks/stripe/route.ts
import { toWebhookHandler } from "@context-kit/billing/webhook";
import { billing } from "@/lib/billing";
import { prisma } from "@/lib/prisma";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;

const handler = toWebhookHandler({
  stripe,
  prisma,
  plans: new Map(billing.plans.map((p) => [p.id, p])),
  webhookSecret,
});

export const POST = handler;
```

Handled events:

| Event | Action |
|---|---|
| `checkout.session.completed` | Upsert subscription from session metadata |
| `customer.subscription.created` | Upsert subscription record |
| `customer.subscription.updated` | Upsert subscription record |
| `customer.subscription.deleted` | Mark subscription as canceled |
| `invoice.paid` | Restore `past_due` subscription to `active` |
| `invoice.payment_failed` | Mark subscription as `past_due` |

All writes are idempotent upserts. Unknown events are ignored gracefully.

---

## Resync CLI

Use the resync command to reconcile your local database with Stripe's subscription state. Useful after downtime, data migrations, or bulk imports.

```bash
npx billing resync
# or
bunx billing resync
```

The resync command:
1. Paginates through all Stripe subscriptions (all statuses, 100 per page)
2. Upserts matching local subscription records
3. Marks any local active/trialing/past_due subscriptions not present in Stripe as canceled
4. Skips subscriptions whose Stripe customer has no matching local Customer record

Exits with code 0 on success, code 1 if any errors occurred.

---

## Error Classes

All errors extend `BillingError` which extends `Error`.

| Class | When thrown |
|---|---|
| `BillingError` | Base class for all billing errors |
| `InvalidConfigError` | Missing or invalid `createBilling()` config, unknown plan ID |
| `UsageCapExceededError` | `recordUsage` called when cap is reached (hard mode) |
| `WebhookVerificationError` | Stripe webhook signature verification failed |
| `SubscriptionStateError` | Invalid subscription state for the requested operation |

`UsageCapExceededError` includes `used: number` and `limit: number` properties.

---

## Entry Points

| Import | Contents |
|---|---|
| `@context-kit/billing` | `createBilling`, all types, all error classes |
| `@context-kit/billing/webhook` | `toWebhookHandler` |
| `@context-kit/billing/cli` | `runResync` (programmatic access to the CLI logic) |

---

## License

MIT
