# PRD-0003: @context-kit/billing — Phase 1: Core Billing Engine

**Author:** Josh
**Date:** 2026-02-22
**Status:** Draft
**Package:** `@context-kit/billing`

## Problem Statement

Every SaaS project built on context-kit needs subscription billing. Today, developers wire up Stripe manually: creating customers, managing webhooks, syncing subscription state to the database, handling plan changes, and dealing with edge cases like failed payments or trial expirations. This takes days to get right and is the #1 source of subtle bugs (stale subscription state, missed webhooks, race conditions between Stripe and the local DB). There's no reusable package that provides a working Stripe billing backend for the context-kit stack.

## Business Context

Billing is the second critical infrastructure piece after auth. Most context-kit projects will charge money, and a broken or incomplete billing integration directly impacts revenue. A working `bun add @context-kit/billing` that handles Stripe subscriptions, webhook sync, and usage caps eliminates the most error-prone part of SaaS development and validates the package model for high-value infrastructure.

## Goals & Success Metrics

| Goal | Metric | Target |
|------|--------|--------|
| Fast time-to-billing | Time from `bun add` to working subscription flow | <15 minutes |
| Reliable sync | Subscription state drift between Stripe and DB | Zero under normal webhook delivery |
| Flexible plan model | Supports flat plans with optional usage caps and seat limits | Configurable per-plan |

## User Stories

- **As a** context-kit developer, **I want** to define my pricing plans in config and have the package manage Stripe products/prices **so that** I don't manually create them in the Stripe dashboard.
- **As a** context-kit developer, **I want** webhook handling that keeps my DB in sync with Stripe **so that** subscription status is always accurate without polling.
- **As a** context-kit developer, **I want** a resync CLI command **so that** I can reconcile my DB with Stripe if webhooks were missed or during initial setup.
- **As a** context-kit developer, **I want** to check a user's current plan, usage, and seat count server-side **so that** I can enforce limits and gate features.
- **As a** context-kit developer, **I want** an optional free tier that doesn't touch Stripe **so that** I can offer a free plan without creating Stripe subscriptions for non-paying users.
- **As a** context-kit developer, **I want** to record usage events against a subscription **so that** I can enforce caps (API calls, storage, etc.) defined on the plan.

## Scope

### In Scope

- Prisma schema extension with tables: `Customer`, `Subscription`, `Plan`, `Price`, `UsageRecord`
- `createBilling` factory that accepts config (Stripe keys, plan definitions, free tier config) and returns a billing instance
- Stripe customer lifecycle: create customer on first checkout, link to auth user
- Stripe Checkout Session creation for embedded checkout (SCA/3DS handled by Stripe)
- Subscription management: create, update (plan change with proration), cancel, reactivate
- Webhook route handler for Next.js (`/api/billing/webhook`) handling: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`
- Server-side helpers: `getSubscription(userId)`, `getPlan(userId)`, `checkUsage(userId, feature)`, `recordUsage(userId, feature, quantity)`
- Free tier logic: configurable "free" plan that exists only in the DB (no Stripe subscription); `getPlan` returns the free plan for users without a subscription
- Plan definitions in config with: name, Stripe price IDs (monthly/yearly), usage caps (keyed by feature name), seat limit
- Resync CLI: `bunx @context-kit/billing resync` to fetch all Stripe subscriptions and reconcile with local DB
- TypeScript types for all public APIs

### Out of Scope

- **UI components** — pricing page, checkout form, subscription management UI are in Phase 2 and Phase 3 (`@context-kit/billing-ui`)
- **Metered/usage-based billing through Stripe** — usage caps are enforced locally, not via Stripe's metered billing; Stripe usage reporting may come later
- **One-time payments / lifetime deals** — subscriptions only for v1
- **Multiple subscriptions per user** — one active subscription per user
- **Tax calculation** — consumers configure tax in Stripe directly (Stripe Tax or manual)
- **Coupon/promotion code management** — consumers create these in Stripe; the checkout session can accept a promo code but the package doesn't manage them
- **Invoicing for custom/enterprise plans** — standard self-serve subscriptions only
- **Pages Router support** — App Router only

## Requirements

### Functional Requirements

1. The package shall export a `createBilling` function that accepts a config object and returns a configured billing instance.
2. `createBilling` shall accept the consumer's `PrismaClient`, Stripe secret key, Stripe webhook secret, and plan definitions.
3. The package shall read `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` from environment variables, falling back to explicit config.
4. Plan definitions shall specify: `id` (string slug), `name`, `stripePriceId` (or `monthly`/`yearly` price IDs), `usageCaps` (optional record of feature → limit), `seatLimit` (optional number), and `isFree` (boolean, default false).
5. The package shall export a `toWebhookHandler` that returns a Next.js Route Handler (`POST`) for Stripe webhook events.
6. The webhook handler shall process: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`.
7. The webhook handler shall verify the Stripe signature before processing any event.
8. The package shall export `getSubscription(userId)` returning the current subscription with plan details, or `null` if none.
9. The package shall export `getPlan(userId)` returning the user's current plan. If no subscription exists and a free tier is configured, it shall return the free plan. If no subscription and no free tier, it shall return `null`.
10. The package shall export `checkUsage(userId, feature)` returning `{ used, limit, remaining, allowed }` for a given feature's usage cap in the current billing period.
11. The package shall export `recordUsage(userId, feature, quantity?)` to increment a usage counter. It shall throw if the usage would exceed the cap (unless the plan has no cap for that feature).
12. The package shall export `createCheckoutSession({ userId, planId, interval, successUrl, cancelUrl })` to create a Stripe embedded checkout session.
13. The package shall export `changePlan(userId, newPlanId, interval?)` to upgrade or downgrade. Proration shall be enabled by default (configurable).
14. The package shall export `cancelSubscription(userId, { immediate? })` to cancel at period end (default) or immediately.
15. The package shall export `reactivateSubscription(userId)` to undo a pending cancellation.
16. Usage records shall reset at the start of each billing period (tracked via subscription `currentPeriodStart`/`currentPeriodEnd`).
17. The resync CLI shall iterate all Stripe subscriptions, match them to local customers by Stripe customer ID, and update local subscription state.

### Non-Functional Requirements

1. The package shall depend on `stripe` (official Node SDK) as its only runtime dependency beyond peer deps.
2. The package shall be tree-shakeable — unused entry points shall not increase bundle size.
3. The package shall ship ESM only, matching other context-kit packages.
4. Webhook processing shall be idempotent — receiving the same event twice shall not corrupt state.
5. The package shall not log or expose Stripe keys, webhook secrets, or payment details in errors.

## Prisma Schema

The package shall document the following tables for consumers to add to their Prisma schema:

```prisma
model Customer {
  id               String        @id @default(cuid())
  userId           String        @unique
  stripeCustomerId String        @unique
  createdAt        DateTime      @default(now())
  updatedAt        DateTime      @updatedAt
  subscription     Subscription?
  user             User          @relation(fields: [userId], references: [id], onDelete: Cascade)
}

model Subscription {
  id                   String        @id @default(cuid())
  customerId           String        @unique
  stripeSubscriptionId String        @unique
  stripePriceId        String
  planId               String
  status               String        // active, trialing, past_due, canceled, unpaid
  interval             String        // monthly, yearly
  currentPeriodStart   DateTime
  currentPeriodEnd     DateTime
  cancelAtPeriodEnd    Boolean       @default(false)
  createdAt            DateTime      @default(now())
  updatedAt            DateTime      @updatedAt
  customer             Customer      @relation(fields: [customerId], references: [id], onDelete: Cascade)
  usageRecords         UsageRecord[]
}

model UsageRecord {
  id             String       @id @default(cuid())
  subscriptionId String
  feature        String
  used           Int          @default(0)
  periodStart    DateTime
  periodEnd      DateTime
  subscription   Subscription @relation(fields: [subscriptionId], references: [id], onDelete: Cascade)

  @@unique([subscriptionId, feature, periodStart])
}
```

## Edge Cases & Error States

- **Missing env vars:** `createBilling` shall throw a clear error at init if `STRIPE_SECRET_KEY` is missing and not provided in config.
- **Webhook signature invalid:** The handler shall return 400 and log a warning, not process the event.
- **Duplicate webhook events:** Idempotent processing — re-processing the same subscription update results in the same DB state.
- **User without Customer record:** `getSubscription` and `getPlan` shall handle gracefully (return free plan or null).
- **Usage cap exceeded:** `recordUsage` shall throw a typed `UsageCapExceededError` with the current usage and limit.
- **Plan change during past_due:** `changePlan` shall throw if the subscription is past due (consumer should resolve payment first).
- **Cancel already-canceled subscription:** `cancelSubscription` on a subscription already set to cancel at period end shall be a no-op.
- **Resync with deleted Stripe subscriptions:** The resync CLI shall mark local subscriptions as `canceled` if they no longer exist in Stripe.

## Dependencies

- **stripe** (`^17.0.0`) — Stripe Node SDK, runtime dependency
- **@prisma/client** (`>=5.0.0`) — peer dependency, provided by consumer
- **next** (`>=14.0.0`) — optional peer dependency for webhook route handler
- **tsup** — build tool (dev only)
- **TypeScript** — type checking (dev only)

## Risks & Open Questions

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Stripe SDK breaking changes | Low | Build breaks | Pin to `^17.x`, test against updates |
| Webhook delivery gaps | Medium | Stale subscription state | Resync CLI as safety net; document Stripe retry behavior |
| Complex proration edge cases | Medium | Incorrect billing on plan changes | Use Stripe's default proration; surface proration preview in Phase 3 UI |

### Resolved Questions

- [x] **Plan storage:** Code config only. Plans defined in `createBilling()` config — simple, version-controlled, no DB migration needed for plan changes.
- [x] **Stripe sync:** Auto-create with sync command. A CLI command (`bunx @context-kit/billing sync-plans`) creates/updates Stripe products and prices from config. Not auto-on-startup to avoid accidental production changes.
- [x] **Usage caps:** Hard limits by default, configurable. `recordUsage()` throws `UsageCapExceededError` by default; consumers can pass `{ soft: true }` to allow over-limit and handle it themselves.
- [x] **Past due behavior:** Return plan with status flag. `getPlan()` returns the plan object with subscription status included so the consumer can decide whether to gate features.
- [x] **Trial periods:** Deferred to a later version. Keeps v1 scope smaller. Developers can configure trials directly in Stripe if needed in the meantime.
