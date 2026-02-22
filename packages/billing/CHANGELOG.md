# Changelog

All notable changes to `@context-kit/billing` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-02-22

### Added

- `createBilling()` factory function that wires Stripe and Prisma together with config validation, env-var fallbacks for `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`, and plan definition validation (#WI-151)
- `BillingInstance` interface with fully typed methods: `getSubscription`, `getPlan`, `checkUsage`, `recordUsage`, `createCheckoutSession`, `changePlan`, `cancelSubscription`, `reactivateSubscription` (#WI-159)
- TypeScript error class hierarchy: `BillingError`, `UsageCapExceededError`, `InvalidConfigError`, `WebhookVerificationError`, `SubscriptionStateError` — all extend `Error` with correct prototype chain (#WI-149)
- Full domain type definitions: `BillingConfig`, `PlanDefinition`, `FreeTierConfig`, `SubscriptionData`, `UsageResult`, `CheckoutSessionParams`, `CancelParams`, `ChangePlanParams`, `SubscriptionStatus` (#WI-149)
- Stripe customer lifecycle: `getOrCreateCustomer` with idempotent creation and Prisma `P2002` race condition recovery (#WI-152)
- `getSubscription()` and `getPlan()` query helpers with free-tier fallback and calendar-month period boundaries for free users (#WI-153)
- Usage tracking with per-feature caps, billing period scoping, soft mode (record beyond cap without throwing), and `UsageCapExceededError` for hard enforcement (#WI-154)
- Stripe Checkout Session creation with SCA/3DS support, automatic customer creation, and interval-aware price resolution (#WI-155)
- Subscription management: `changePlan` with proration control, `cancelSubscription` with immediate or end-of-period modes, `reactivateSubscription` for pending-cancel subscriptions (#WI-156)
- Webhook handler (`toWebhookHandler`) handling 6 Stripe event types — `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed` — with signature verification and idempotent upserts (#WI-157)
- Resync CLI (`billing resync`) that paginates all Stripe subscriptions, upserts matching local records, and marks stale local subscriptions as canceled (#WI-158)
- Reference Prisma schema with `Customer`, `Subscription`, and `UsageRecord` models ready to copy into a consumer application (#WI-150)
- Three package entry points: `@context-kit/billing` (core), `@context-kit/billing/webhook` (webhook handler), `@context-kit/billing/cli` (resync command) (#WI-148)
- tsup build config producing ESM bundles with TypeScript declarations and sourcemaps; `dist/index.js` (17 KB), `dist/webhook.js`, `dist/cli.js` (#WI-148)
- Bun test infrastructure with 112 tests across 11 test files covering all modules (#WI-148)
