# @context-kit/billing

Stripe billing for Next.js App Router apps on Postgres and Drizzle: subscriptions through hosted Checkout, the Customer Portal, webhooks that keep a local copy of each subscription, a plan-gating read, and metered overage reported to a Stripe Billing Meter exactly once per usage record.

The design, with the Stripe documentation it relies on, is in [issue #7](https://github.com/queso/context-kit-packages/issues/7).

## Model

- **Subject.** The package bills a *subject*: an opaque string id the app chooses for whatever pays (a team, an org, a GitHub account). It has no notion of users. Deciding whether the signed-in person may act for a subject is the app's job, inside every Server Action.
- **Plans.** Stripe holds products and amounts. The app's config maps each plan to a price `lookup_key` and the units it includes per period.
- **Overage.** One metered per-unit price, shared by every plan, fed by a Billing Meter. The app decides how much of each usage record is above the allowance (`computeOverage`) and enqueues it; a reporter sends it to Stripe.
- **State.** Webhooks never apply their payload. Each event names an object; the package fetches it from Stripe and replaces the stored row, so repeated and out-of-order deliveries converge on Stripe's current state. Fetch and store for one subscription run under a Postgres advisory lock keyed on its id, so two concurrent deliveries cannot leave the older state stored.
- **Subject of a subscription.** The `billing_customer` mapping decides it; the subscription's `metadata.subject_id` is only a fallback for a customer not mapped yet. If the two disagree, the subscription is not stored and the event is flagged `subject_mismatch`. An event whose subject is not known yet is answered with 500 and left unprocessed, so Stripe retries it once the customer is mapped.

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

One database pairs with one Stripe mode. `billing_customer` keys on the subject alone, so test-mode and live-mode data must not share a database.

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

Checkout renews subscriptions on the 1st of each month at 00:00 UTC (`anchorToMonthStart`, default true), so Stripe's billing period matches a calendar-month usage ledger. The package sets `subscription_data.billing_cycle_anchor_config` (day 1, 00:00 UTC) and Stripe computes the anchor when the subscription is created, including around short months. The first invoice is prorated.

`createCheckoutSession` expires the subject's other open Checkout Sessions, so a subject has one open session at a time. As a second guard, enable Stripe's "Limit customers to one subscription" setting ([docs](https://docs.stripe.com/payments/checkout/limit-subscriptions)).

`ensureCustomer` creates the Stripe customer with only its subject metadata, then applies `name` and `email` with an update.

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
| `past_due` | the paid plan until `graceEndsAt` (oldest unpaid invoice finalized + `gracePeriodDays`; a renewal while past due does not restart it, and a payment since the stored date starts a new stretch), then free |
| `unpaid`, `canceled`, `incomplete`, `incomplete_expired`, `paused`, none | free |

The answer is about new work only. The package never stops work already running; gate new runs on `getEntitlement` and let running ones finish.

With Cache Components on, do not wrap `getEntitlement` in `"use cache"` without the subject id as an argument and a tag you invalidate from the webhook; uncached reads are per request and cannot leak between accounts.

## 6. Report overage

Enqueue in the same transaction that writes your own usage record, so both commit or neither does. The transaction takes a per-subject advisory lock first: without it, two concurrent runs for one subject can both read the same `usedBefore` and under-report overage.

```ts
import { sql } from "drizzle-orm";
import { computeOverage } from "@context-kit/billing";

await db.transaction(async (tx) => {
  // One run at a time per subject, so two concurrent runs cannot read the same total.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"usage:" + accountId}))`);
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
await billing.reportPendingUsage(); // { sent, retry, failed, late, needsReview, blocked }
```

Run it from a job whose errors reach a person. It throws `UsageReportingBlockedError` when something no single row can fix stops reporting: a rejected key (401), a key without the meter-event permission (403), a missing or archived meter, a Stripe error the package does not recognise, or a subscription that does not renew monthly. Those rows stay pending, with the reason in `last_error`, and go out on the first run after the cause is fixed. `err.reason` and `err.summary` say what happened.

**Monthly subscriptions only.** The reporter decides whether usage can still reach an invoice by stepping back one calendar month from the current period start. It refuses (loudly, as above) subscriptions whose price does not renew every 1 month. The billing interval is stored on `billing_subscription` at sync.

How each row is reported once:
- `source_id` is the primary key, so a repeated usage record is a no-op (`duplicate`), and a changed one is refused (`conflict`).
- The meter event carries the source id as its `identifier`. A retry after a lost response is dropped by Stripe, which deduplicates identifiers for at least 24 hours. Each attempt uses a fresh idempotency key, because Stripe replays a key's saved result, including a 500.
- Rows are claimed with a five-minute lease in one short statement (`FOR UPDATE SKIP LOCKED` inside an UPDATE), so concurrent reporters take disjoint rows. Stripe is called outside any transaction: no connection or row lock is held while Stripe answers. One send takes at most about 95 seconds (30-second timeout, 2 retries with backoff), well inside the lease. A reporter that loses its lease cannot overwrite the new holder's result.
- If Stripe already holds the identifier (an earlier attempt reached Stripe and its response was lost), Stripe refuses the resend. The reporter recognises that refusal and marks the row `sent`. Stripe documents it for v2 as `400 duplicate_meter_event`; on v1 it was observed in test mode as an `invalid_request_error` with the message "An event already exists with identifier <id>.", which only counts when it names the identifier that was sent. The live suite asserts this against Stripe.
- A row is marked `failed` by a Stripe error only when the error is a validation error about that row's own data (for example a timestamp out of range). Timeouts, 409, 429 and 5xx leave it pending for the next run.
- A row still unsent 20 hours after its first attempt becomes `needs_review` instead of being resent, since Stripe's dedup window may have passed.
- Usage from a period whose invoice is already finalized becomes `late` and is not sent: Stripe would accept it without ever billing it.
- Usage that arrives before the subject's subscription is synced stays pending. Usage after a canceled subscription's last period, or for a subscription without the overage price, is marked `failed`.

A 200 from Stripe does not mean the event was billed; Stripe validates meter events asynchronously and reports errors as the thin events `v1.billing.meter.error_report_triggered` and `v1.billing.meter.no_meter_found`. Handling those is not in this version (see "Not built yet").

## 7. Repair

`billing.reconcile()` re-fetches every stored customer's subscriptions with the list API and replaces the rows. `reconcile({ repairCustomers: true })` also restores missing `billing_customer` rows from the customers' `metadata.subject_id`. It counts subjects that have several tagged customers (`duplicateSubjects`) and picks the one with a live subscription, else the oldest. Run it on a schedule or whenever the tables look wrong.

### Pruning `billing_webhook_event`

`billing_webhook_event` keeps every delivered event id and is never pruned by the package. Delete old rows on a schedule:

```sql
delete from billing_webhook_event where processed_at < now() - interval '30 days';
```

Keep at least Stripe's live-mode retry window of three days. A row deleted inside that window means a repeat delivery is no longer recognised and the event is processed again. Rows with a null `processed_at` are events that failed and are still waiting for a retry, so the condition above leaves them alone.

## Testing

```bash
bun --filter @context-kit/billing test        # offline: fake Stripe + PGlite
```

- **Offline.** A stateful fake of the Stripe API, reached through stripe-node's own HTTP client, serves objects built from Stripe's published fixtures (`src/__tests__/fixtures/stripe/SOURCE.md`). Webhooks are signed with stripe-node's test signer. Tables live in PGlite.
- **stripe-mock.** `src/__tests__/stripe-mock.test.ts` sends the package's real request parameters to Stripe's official mock, which rejects anything that does not match Stripe's OpenAPI spec. Run `docker run --rm -p 12111:12111 stripe/stripe-mock` and set `STRIPE_MOCK_URL=http://localhost:12111`. CI runs it with `REQUIRE_STRIPE_MOCK=1`.
- **Postgres.** `src/__tests__/postgres.test.ts` checks concurrent reporters and concurrent webhook deliveries on a real server. The suite drops and recreates the `billing_*` tables in whatever database `BILLING_TEST_DATABASE_URL` names, so point it only at a disposable database. Nothing else in that database is touched: the schema push is limited to `billing_*` tables. It ignores `DATABASE_URL`. It runs only when both variables are set: `BILLING_TEST_DATABASE_URL` (a `postgres://` or `postgresql://` URL) and `BILLING_TEST_ALLOW_DROP=1` (the explicit opt-in to the drop). Without both it skips and the warning names what is missing. CI sets both and `REQUIRE_POSTGRES=1`, which makes a missing variable fail the job without printing the URL.

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

Store it as `STRIPE_TEST_SECRET_KEY` in your secrets manager. To run the suite in CI, add it as a GitHub Actions secret of the same name and set the repository variable `STRIPE_LIVE_ENABLED` to `true`. Until the variable is set, the "Billing against Stripe sandbox" check is skipped, never shown as passing; once it is set, a missing or invalid key fails the check. The webhook test also needs the Stripe CLI on `PATH`; it receives the key through `STRIPE_API_KEY` in its environment.

## Not built yet

- Plan changes between paid plans (`previewPlanChange`, `changePlan`), needed because the portal cannot update a subscription with a metered price.
- Handling the meter error thin events.
- Storage for a customer-set spending cap, and trials: both wait on decisions recorded in issue #7.
