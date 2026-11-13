# Changelog

All notable changes to `@context-kit/billing` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Stripe client wrapper pinned to API version `2026-10-28.endive` (stripe-node 23.1.0), accepting secret or restricted keys
- Drizzle Postgres tables: `billing_customer`, `billing_subscription`, `billing_webhook_event`, `billing_usage_report`
- `ensureCustomer`: one Stripe customer per subject, created with an idempotency key
- Subscription sync from the API (`syncSubscription`, `syncCustomerSubscriptions`) and `reconcile` to rebuild state
- `getEntitlement` / `resolveEntitlement`: the plan-gating read, with a grace period for `past_due`
- Webhook Route Handler with signature verification and an idempotent event store; payloads are never applied, objects are re-fetched
- Meter-event outbox (`enqueueUsage`, `reportPendingUsage`) that reports each usage record once, and `computeOverage`. Rows are claimed with a lease and sent outside any transaction; Stripe's refusal of an identifier it already holds ends a row as sent; credential, permission, meter and unrecognised errors leave rows pending and throw `UsageReportingBlockedError`; monthly subscriptions only
- Hosted Checkout (anchored to the 1st of the month, UTC), success-page fulfilment (`completeCheckout`) and Customer Portal sessions
- `bootstrapCatalog` to create the meter, products and prices by lookup key
- Offline tests (fake Stripe on Stripe's fixtures, PGlite), a stripe-mock request-shape suite, Postgres concurrency tests, and a live sandbox suite that runs when `STRIPE_TEST_SECRET_KEY` is set
