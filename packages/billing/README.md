# @context-kit/billing

Stripe billing for Next.js App Router apps on Postgres and Drizzle: subscriptions through hosted Checkout, the Customer Portal, webhooks that keep a local copy of each subscription, a plan-gating read, and metered overage reported to a Stripe Billing Meter exactly once per usage record.

The design, with the Stripe documentation it relies on, is in [issue #7](https://github.com/queso/context-kit-packages/issues/7).

## Model

- **Subject.** The package bills a *subject*: an opaque string id the app chooses for whatever pays (a team, an org, a GitHub account). It has no notion of users. Deciding whether the signed-in person may act for a subject is the app's job, inside every Server Action.
- **Plans.** Stripe holds products and amounts. The app's config maps each plan to a price `lookup_key` and the units it includes per period.
- **Overage.** One metered per-unit price, shared by every plan, fed by a Billing Meter. The app decides how much of each usage record is above the allowance (`computeOverage`) and enqueues it; a reporter sends it to Stripe.
- **State.** Webhooks never apply their payload. Each event names an object; the package fetches it from Stripe and replaces the stored row, so repeated and out-of-order deliveries converge on Stripe's current state.

Stripe API version: `2026-10-28.endive`, pinned to match stripe-node 23.1.0.

## Installation

The package is not published to a registry yet (see "How apps consume it" in issue #7). Until it is, install a built tarball or a workspace link, and pin the exact version.

Peer dependency: `drizzle-orm >= 0.41`. Postgres only.

## 1. Add the tables

```ts
// db/schema.ts (or db/schema/postgres.ts)
export * from "@context-kit/billing/schema/postgres";
```

Then generate and apply the migration with your usual Drizzle Kit commands. Your app owns the migration history; a package upgrade that changes a table shows up as a generated migration.

| Table | Holds |
|-------|-------|
| `billing_customer` | subject to Stripe Customer |
| `billing_subscription` | last fetched state of each subscription |
| `billing_webhook_event` | every delivered event id, so repeats are skipped |
| `billing_usage_report` | the meter-event outbox, one row per usage record |

## 2. Configure

```ts
// lib/billing.ts
import { createBilling } from "@context-kit/billing";
import { db } from "@/db";

export const billing = createBilling({
  db,
  secretKey: process.env.STRIPE_SECRET_KEY!,          // a restricted key (rk_...) is recommended
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,   // whsec_..., enables billing.webhookHandler
  config: {
    plans: {
      free: { includedUnits: 50 },
      pro: { includedUnits: 250, priceLookupKey: "okm_pro_monthly" },
      team: { includedUnits: 750, priceLookupKey: "okm_team_monthly" },
      fleet: { includedUnits: 2000, priceLookupKey: "okm_fleet_monthly" },
    },
    freePlan: "free",
    overage: { priceLookupKey: "okm_credit_overage", meterEventName: "okm_credits" },
    gracePeriodDays: 7,
    invoiceGraceHours: 24,   // match the account's invoice finalization grace period
  },
});
```

`createBilling` validates the config and throws on a bad plan table, so a typo fails at startup.

## 3. Set up Stripe

**Catalog.** Create the meter, products and prices once per sandbox and once in live mode. `bootstrapCatalog` finds existing objects by lookup key and event name, so it is safe to re-run:

```ts
import { bootstrapCatalog } from "@context-kit/billing";

await bootstrapCatalog(billing.stripe, billing.config, {
  currency: "usd",
  plans: {
    pro: { productName: "OKtoMerge Pro", unitAmount: 2900 },
    team: { productName: "OKtoMerge Team", unitAmount: 7900 },
    fleet: { productName: "OKtoMerge Fleet", unitAmount: 19900 },
  },
  overage: { productName: "OKtoMerge credits", unitAmount: 12, meterDisplayName: "Credits" },
});
```

Prices are created without `tax_behavior`, so Stripe Tax can be turned on later without replacing them.

**Price changes.** Create the new price with `transfer_lookup_key: true` and `metadata.plan_key` set to the plan. New checkouts use it at once; existing subscribers keep their price until you migrate them. The plan key in metadata keeps old prices recognisable.

**Webhook endpoint.** Create a snapshot endpoint pointing at `/api/billing/webhook`, with its API version set to `2026-10-28.endive`, subscribed to:

```
checkout.session.completed
checkout.session.async_payment_succeeded
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
customer.subscription.paused
customer.subscription.resumed
invoice.paid
invoice.payment_failed
```

**Account settings to decide.**
- *Invoice finalization grace period* (Billing settings). Usage reported after an invoice finalizes is never billed. Raise it (up to 72 hours) and set `invoiceGraceHours` to the same value.
- *What happens after the last failed retry* (cancel, mark unpaid, or leave past due). The package handles all three; `gracePeriodDays` decides when a `past_due` subject drops to free limits.
- *Customer Portal*: enable payment method updates, invoice history and cancellation. The portal cannot change a subscription that has a metered price, so do not offer plan switching there.

## 4. Wire up Next.js

**Webhook Route Handler.** Do not export `runtime` or `dynamic`; the handler reads the raw body with `request.text()` as signature verification requires.

```ts
// app/api/billing/webhook/route.ts
import { billing } from "@/lib/billing";

export const POST = billing.webhookHandler!;
```

**Checkout and portal from Server Actions.** Server Actions can be called by direct POST, so authorize inside each one. Call `redirect` after any `try/catch`, because it works by throwing.

```ts
// app/billing/actions.ts
"use server";
import { redirect } from "next/navigation";
import { billing } from "@/lib/billing";
import { requireAccountAdmin } from "@/lib/auth"; // your own check

export async function startCheckout(formData: FormData) {
  const account = await requireAccountAdmin(formData.get("accountId"));
  const plan = String(formData.get("plan"));
  const { url } = await billing.createCheckoutSession({
    subjectId: String(account.id),
    plan,
    successUrl: `${process.env.SITE_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${process.env.SITE_URL}/billing`,
    customer: { name: account.login },
  });
  redirect(url);
}

export async function openPortal(formData: FormData) {
  const account = await requireAccountAdmin(formData.get("accountId"));
  const { url } = await billing.createPortalSession({
    subjectId: String(account.id),
    returnUrl: `${process.env.SITE_URL}/billing`,
  });
  redirect(url);
}
```

```tsx
<form action={startCheckout}>
  <input type="hidden" name="accountId" value={account.id} />
  <button name="plan" value="pro">Upgrade to Pro</button>
</form>
```

Checkout renews subscriptions on the 1st of each month at 00:00 UTC (`anchorToMonthStart`, default true), so Stripe's billing period matches a calendar-month usage ledger. The first invoice is prorated. Within 24 hours of a month start the session expires at the anchor, and in the last 30 minutes of a month the anchor moves to the following month start, since Stripe sessions live at least 30 minutes.

**Success page.** Stripe advises fulfilling from the landing page as well as the webhook, since the webhook can be late. Both run the same idempotent sync:

```ts
await billing.completeCheckout(searchParams.session_id, { subjectId: String(account.id) });
```

## 5. Gate on the plan

```ts
const ent = await billing.getEntitlement(String(account.id));
// { plan: "pro", includedUnits: 250, paid: true, reason: "subscription", subscription: { status, currentPeriodStart, currentPeriodEnd, graceEndsAt, ... } }
```

It reads only the local tables, never Stripe. Rules:

| Subscription status | Limits |
|---------------------|--------|
| `active`, `trialing` | the paid plan |
| `past_due` | the paid plan until `graceEndsAt` (oldest unpaid invoice finalized + `gracePeriodDays`; a renewal while past due does not restart it), then free |
| `unpaid`, `canceled`, `incomplete`, `incomplete_expired`, `paused`, none | free |

The answer is about new work only. The package never stops work already running; gate new runs on `getEntitlement` and let running ones finish.

With Cache Components on, do not wrap `getEntitlement` in `"use cache"` without the subject id as an argument and a tag you invalidate from the webhook; uncached reads are per request and cannot leak between accounts.

## 6. Report overage

Enqueue in the same transaction that writes your own usage record, so both commit or neither does:

```ts
import { computeOverage } from "@context-kit/billing";

await db.transaction(async (tx) => {
  const usedBefore = await creditsThisPeriod(tx, accountId);    // your ledger, rows before this one
  await tx.insert(usageRecords).values(run);
  const ent = await billing.getEntitlement(String(accountId));
  const overage = ent.paid ? computeOverage({ includedUnits: ent.includedUnits, usedBefore, units: run.credits }) : 0;
  await billing.enqueueUsage(
    { sourceId: run.runId, subjectId: String(accountId), value: overage, occurredAt: run.receivedAt },
    tx
  );
});
```

Then send pending rows on a schedule (every minute) or from `after()`:

```ts
await billing.reportPendingUsage(); // { sent, retry, failed, late, needsReview }
```

How each row is reported once:
- `source_id` is the primary key, so a repeated usage record is a no-op (`duplicate`), and a changed one is refused (`conflict`).
- The meter event carries the source id as its `identifier`. A retry after a lost response is dropped by Stripe, which deduplicates identifiers for at least 24 hours. Each attempt uses a fresh idempotency key, because Stripe replays a key's saved result, including a 500.
- Rows are locked with `FOR UPDATE SKIP LOCKED`, so concurrent reporters never send the same row.
- A row still unsent 20 hours after its first attempt becomes `needs_review` instead of being resent, since Stripe's dedup window may have passed.
- Usage from a period whose invoice is already finalized becomes `late` and is not sent: Stripe would accept it without ever billing it.
- Usage that arrives before the subject's subscription is synced stays pending. Usage after a canceled subscription's last period, or for a subscription without the overage price, is marked `failed`.

A 200 from Stripe does not mean the event was billed; Stripe validates meter events asynchronously and reports errors as the thin events `v1.billing.meter.error_report_triggered` and `v1.billing.meter.no_meter_found`. Handling those is not in this version (see "Not built yet").

## 7. Repair

`billing.reconcile()` re-fetches every stored customer's subscriptions with the list API and replaces the rows. `reconcile({ repairCustomers: true })` also restores missing `billing_customer` rows from the customers' `metadata.subject_id`. Run it on a schedule or whenever the tables look wrong.

## Testing

```bash
bun --filter @context-kit/billing test        # offline: fake Stripe + PGlite
```

- **Offline.** A stateful fake of the Stripe API, reached through stripe-node's own HTTP client, serves objects built from Stripe's published fixtures (`src/__tests__/fixtures/stripe/SOURCE.md`). Webhooks are signed with stripe-node's test signer. Tables live in PGlite.
- **stripe-mock.** `src/__tests__/stripe-mock.test.ts` sends the package's real request parameters to Stripe's official mock, which rejects anything that does not match Stripe's OpenAPI spec. Run `docker run --rm -p 12111:12111 stripe/stripe-mock` and set `STRIPE_MOCK_URL=http://localhost:12111`. CI runs it with `REQUIRE_STRIPE_MOCK=1`.
- **Postgres.** `src/__tests__/postgres.test.ts` checks concurrent reporters and concurrent webhook deliveries on a real server. Set `DATABASE_URL`. CI runs it with `REQUIRE_POSTGRES=1`.

### Live Stripe tests

`src/__live__/stripe-live.test.ts` runs against a real Stripe sandbox through `bun run test:live` when `STRIPE_TEST_SECRET_KEY` is set, and prints a warning and skips otherwise. A plain `bun test` never calls Stripe, even with the key in your shell. It refuses live-mode keys. It covers catalog bootstrap, Checkout Session creation, a subscription lifecycle on a test clock, a metered event on the upcoming invoice, a failed renewal and the grace rule, and webhook delivery through `stripe listen` (skipped when the Stripe CLI is not installed).

```bash
STRIPE_TEST_SECRET_KEY=rk_test_... bun --filter @context-kit/billing test:live
```

To run it, create a **sandbox** in the Stripe Dashboard (Stripe recommends separate sandboxes for local development and CI) and, in that sandbox, a **restricted key** with:

| Resource | Permission |
|----------|------------|
| Customers | Write |
| Checkout Sessions | Write |
| Customer portal | Write |
| Subscriptions | Write |
| Invoices | Write |
| Prices | Write |
| Products | Write |
| Payment Methods | Write |
| Billing Meters | Write |
| Meter Events | Write |
| Test clocks | Write |
| Events | Read |
| Webhook Endpoints | Write |

Store it as `STRIPE_TEST_SECRET_KEY` in your secrets manager, and as a GitHub Actions secret of the same name to run the suite in CI. The webhook test also needs the Stripe CLI on `PATH`; it receives the key through `STRIPE_API_KEY` in its environment.

## Not built yet

- Plan changes between paid plans (`previewPlanChange`, `changePlan`), needed because the portal cannot update a subscription with a metered price.
- Handling the meter error thin events.
- Storage for a customer-set spending cap, and trials: both wait on decisions recorded in issue #7.
