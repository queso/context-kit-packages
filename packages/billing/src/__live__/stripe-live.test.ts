import { describe, test, expect, afterAll } from "bun:test";
import { and, eq, isNotNull } from "drizzle-orm";
import type Stripe from "stripe";
import { createStripeClient } from "../stripe-client";
import { bootstrapCatalog, type Catalog } from "../bootstrap";
import { createCheckoutSession } from "../checkout";
import { syncSubscription } from "../subscriptions";
import { getEntitlement } from "../entitlement";
import { enqueueUsage, isDuplicateIdentifierError, reportPendingUsage } from "../usage";
import { createWebhookHandler } from "../webhooks";
import { billingCustomer, billingSubscription, billingWebhookEvent } from "../schema/postgres";
import { createTestDb } from "../__tests__/helpers/db";
import type { BillingConfig, BillingContext } from "../types";

/**
 * End-to-end checks against a real Stripe sandbox (or test mode). They run only
 * when STRIPE_TEST_SECRET_KEY holds a test key (sk_test_ or rk_test_) and are
 * skipped, with a warning, otherwise. A live-mode key is refused outright.
 *
 * Covered: catalog bootstrap, Checkout Session creation, a subscription
 * lifecycle on a test clock, a metered event reaching the upcoming invoice, a
 * failed renewal payment and the grace rule, and webhook delivery through the
 * Stripe CLI (skipped separately when the `stripe` binary is not installed).
 *
 * Everything is created under fixed `ckb_live_` lookup keys and an event name
 * that bootstrap reuses, and customers and test clocks are deleted afterwards.
 */

const key = process.env.STRIPE_TEST_SECRET_KEY ?? "";
// Only `bun run test:live` sets BILLING_LIVE, so a developer with the key in
// their shell does not call Stripe on every unit-test run.
const requested = process.env.BILLING_LIVE === "1";
const enabled = requested && /^(sk|rk)_test_/.test(key);

if (requested && key && !enabled) {
  // Never echo the key: this message can end up in CI logs.
  throw new Error("STRIPE_TEST_SECRET_KEY must be a sandbox or test-mode key (sk_test_ or rk_test_); refusing to run");
}
if (requested && process.env.REQUIRE_STRIPE_LIVE && !enabled) {
  throw new Error("REQUIRE_STRIPE_LIVE is set but STRIPE_TEST_SECRET_KEY is missing");
}
if (!requested) {
  console.warn("\n[billing] live Stripe suite skipped: run `bun run test:live` with STRIPE_TEST_SECRET_KEY set.\n");
} else if (!enabled) {
  console.warn(
    [
      "",
      "################################################################################",
      "# [billing] LIVE STRIPE SUITE SKIPPED: STRIPE_TEST_SECRET_KEY is not set.      #",
      "# Checkout, test-clock lifecycle, metered usage on the upcoming invoice, failed #",
      "# payment and webhook delivery were NOT checked against Stripe in this run.     #",
      "# See packages/billing/README.md, \"Live Stripe tests\".                          #",
      "################################################################################",
      "",
    ].join("\n")
  );
}

const config: BillingConfig = {
  plans: {
    free: { includedUnits: 50 },
    pro: { includedUnits: 250, priceLookupKey: "ckb_live_pro_monthly" },
    team: { includedUnits: 750, priceLookupKey: "ckb_live_team_monthly" },
    fleet: { includedUnits: 2000, priceLookupKey: "ckb_live_fleet_monthly" },
  },
  freePlan: "free",
  overage: { priceLookupKey: "ckb_live_credit_overage", meterEventName: "ckb_live_credits" },
  gracePeriodDays: 7,
};

const catalog: Catalog = {
  currency: "usd",
  plans: {
    pro: { productName: "context-kit billing live test: Pro", unitAmount: 2900 },
    team: { productName: "context-kit billing live test: Team", unitAmount: 7900 },
    fleet: { productName: "context-kit billing live test: Fleet", unitAmount: 19900 },
  },
  overage: { productName: "context-kit billing live test: credits", unitAmount: 12, meterDisplayName: "ckb live test credits" },
};

const LONG = 240_000;
const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const cleanups: (() => Promise<unknown>)[] = [];

afterAll(async () => {
  // Failures are logged so leaked sandbox objects are visible; the message is
  // Stripe's, which never contains the key.
  for (const fn of cleanups.reverse()) {
    await fn().catch((err: unknown) =>
      console.warn(`[billing] live-test cleanup failed: ${err instanceof Error ? err.message : String(err)}`)
    );
  }
});

let stripeClient: Stripe | undefined;
function stripe(): Stripe {
  stripeClient ??= createStripeClient(key, { maxNetworkRetries: 2 });
  return stripeClient;
}

async function context(): Promise<BillingContext> {
  const { db } = await createTestDb();
  return { db, stripe: stripe(), config };
}

async function poll<T>(what: string, fn: () => Promise<T | undefined | null | false>, timeoutMs = 120_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

async function advanceClock(clockId: string, to: number) {
  await stripe().testHelpers.testClocks.advance(clockId, { frozen_time: to });
  await poll("test clock to be ready", async () => {
    const c = await stripe().testHelpers.testClocks.retrieve(clockId);
    return c.status === "ready";
  });
}

/** A customer with a working card, optionally on a test clock, mapped to a fresh subject. */
async function customerWithCard(ctx: BillingContext, opts: { testClock?: string } = {}) {
  const subjectId = `live-${runId}-${Math.random().toString(36).slice(2, 8)}`;
  const customer = await stripe().customers.create({
    metadata: { subject_id: subjectId },
    ...(opts.testClock ? { test_clock: opts.testClock } : {}),
  });
  if (!opts.testClock) cleanups.push(() => stripe().customers.del(customer.id));
  const pm = await stripe().paymentMethods.attach("pm_card_visa", { customer: customer.id });
  await stripe().customers.update(customer.id, { invoice_settings: { default_payment_method: pm.id } });
  await ctx.db.insert(billingCustomer).values({ subjectId, stripeCustomerId: customer.id, livemode: false });
  return { subjectId, customerId: customer.id };
}

async function subscribe(customerId: string, subjectId: string, prices: Record<string, string>, plan = "pro") {
  return stripe().subscriptions.create({
    customer: customerId,
    items: [{ price: prices[plan]! }, { price: prices.overage! }],
    metadata: { subject_id: subjectId },
  });
}

let catalogPrices: Record<string, string> | undefined;
async function prices(): Promise<Record<string, string>> {
  catalogPrices ??= (await bootstrapCatalog(stripe(), config, catalog)).prices;
  return catalogPrices;
}

describe.skipIf(!enabled)("live Stripe sandbox", () => {
  test("bootstrap creates the catalog once and finds it on the next run", async () => {
    await prices();
    const again = await bootstrapCatalog(stripe(), config, catalog);
    expect(again.created).toEqual([]);
    expect(Object.keys(again.prices).sort()).toEqual(["fleet", "overage", "pro", "team"]);
  }, LONG);

  test("creates a hosted Checkout Session with the plan and the metered overage price", async () => {
    await prices();
    const ctx = await context();
    const session = await createCheckoutSession(ctx, {
      subjectId: `live-${runId}-checkout`,
      plan: "pro",
      successUrl: "https://example.com/success?session_id={CHECKOUT_SESSION_ID}",
      cancelUrl: "https://example.com/cancel",
    });
    cleanups.push(() => stripe().checkout.sessions.expire(session.id));
    const [row] = await ctx.db.select().from(billingCustomer);
    cleanups.push(() => stripe().customers.del(row!.stripeCustomerId));

    expect(session.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const retrieved = await stripe().checkout.sessions.retrieve(session.id);
    expect(retrieved).toMatchObject({ mode: "subscription", status: "open", client_reference_id: `live-${runId}-checkout` });
    const lines = await stripe().checkout.sessions.listLineItems(session.id);
    expect(lines.data.map((l) => l.price?.lookup_key).sort()).toEqual(["ckb_live_credit_overage", "ckb_live_pro_monthly"]);
  }, LONG);

  test("subscription lifecycle on a test clock: start, renew, cancel", async () => {
    const p = await prices();
    const ctx = await context();
    const start = Math.floor(Date.now() / 1000);
    const clock = await stripe().testHelpers.testClocks.create({ frozen_time: start, name: `ckb live ${runId}` });
    cleanups.push(() => stripe().testHelpers.testClocks.del(clock.id));
    const { subjectId, customerId } = await customerWithCard(ctx, { testClock: clock.id });

    const sub = await subscribe(customerId, subjectId, p);
    await syncSubscription(ctx, sub.id);
    let ent = await getEntitlement(ctx, subjectId);
    expect(ent).toMatchObject({ plan: "pro", paid: true, reason: "subscription" });
    const firstPeriodEnd = ent.subscription!.currentPeriodEnd!;

    await advanceClock(clock.id, Math.floor(firstPeriodEnd.getTime() / 1000) + 2 * 3600);
    await syncSubscription(ctx, sub.id);
    ent = await getEntitlement(ctx, subjectId);
    expect(ent.subscription?.status).toBe("active");
    expect(ent.subscription!.currentPeriodStart!.getTime()).toBe(firstPeriodEnd.getTime());

    await stripe().subscriptions.cancel(sub.id);
    await syncSubscription(ctx, sub.id);
    expect(await getEntitlement(ctx, subjectId)).toMatchObject({ plan: "free", paid: false, reason: "inactive" });
  }, LONG);

  test("a reported overage event shows up once on the upcoming invoice, even when Stripe already held its identifier", async () => {
    const p = await prices();
    const ctx = await context();
    const { subjectId, customerId } = await customerWithCard(ctx);
    const sub = await subscribe(customerId, subjectId, p);
    cleanups.push(() => stripe().subscriptions.cancel(sub.id));
    await syncSubscription(ctx, sub.id);

    // Stripe gets the event directly first, as if an earlier reporter attempt
    // reached Stripe and its response was lost. The reporter then sends the same
    // identifier under a new idempotency key.
    const identifier = `run_${runId}_1`;
    await stripe().billing.meterEvents.create(
      { event_name: config.overage.meterEventName, identifier, payload: { stripe_customer_id: customerId, value: "7" } },
      { idempotencyKey: `ckb-live-first-${identifier}` }
    );

    // What Stripe answers to the repeat, checked against the classifier the
    // reporter uses. A reworded refusal fails here instead of wedging rows.
    const repeat = await stripe()
      .billing.meterEvents.create(
        { event_name: config.overage.meterEventName, identifier, payload: { stripe_customer_id: customerId, value: "7" } },
        { idempotencyKey: `ckb-live-repeat-${identifier}` }
      )
      .then(() => null, (err: unknown) => err);
    if (repeat) {
      const e = repeat as { statusCode?: number; code?: string; message?: string };
      console.warn(`[billing] Stripe refused a repeated identifier: ${e.statusCode} ${e.code ?? "(no code)"} "${e.message}"`);
      expect(isDuplicateIdentifierError(repeat, identifier)).toBe(true);
    } else {
      console.warn("[billing] Stripe accepted a repeated identifier with 200 (dropped as a duplicate)");
    }

    expect(await enqueueUsage(ctx, { sourceId: identifier, subjectId, value: 7, occurredAt: new Date() })).toBe("enqueued");
    expect((await reportPendingUsage(ctx)).sent).toBe(1);

    const quantity = await poll(
      "the metered usage to appear on the upcoming invoice",
      async () => {
        const preview = await stripe().invoices.createPreview({ customer: customerId, subscription: sub.id });
        const line = preview.lines.data.find((l) => {
          const price = l.pricing?.price_details?.price;
          return (typeof price === "string" ? price : price?.id) === p.overage;
        });
        return line && (line.quantity ?? 0) > 0 ? line.quantity : undefined;
      },
      180_000
    );
    expect(quantity).toBe(7);
  }, LONG);

  test("a failed renewal makes the subscription past_due and starts the grace period", async () => {
    const p = await prices();
    const ctx = await context();
    const start = Math.floor(Date.now() / 1000);
    const clock = await stripe().testHelpers.testClocks.create({ frozen_time: start, name: `ckb live fail ${runId}` });
    cleanups.push(() => stripe().testHelpers.testClocks.del(clock.id));
    const { subjectId, customerId } = await customerWithCard(ctx, { testClock: clock.id });
    const sub = await subscribe(customerId, subjectId, p);
    await syncSubscription(ctx, sub.id);
    const periodEnd = (await getEntitlement(ctx, subjectId)).subscription!.currentPeriodEnd!;

    // Stripe's test card that attaches fine and then fails every charge.
    const failing = await stripe().paymentMethods.attach("pm_card_chargeCustomerFail", { customer: customerId });
    await stripe().customers.update(customerId, { invoice_settings: { default_payment_method: failing.id } });
    await stripe().subscriptions.update(sub.id, { default_payment_method: failing.id });

    await advanceClock(clock.id, Math.floor(periodEnd.getTime() / 1000) + 3 * 3600);
    await poll("the subscription to go past_due", async () => {
      const s = await stripe().subscriptions.retrieve(sub.id);
      return s.status === "past_due";
    });

    await syncSubscription(ctx, sub.id);
    const [row] = await ctx.db.select().from(billingSubscription).where(eq(billingSubscription.stripeSubscriptionId, sub.id));
    expect(row?.status).toBe("past_due");
    expect(row?.pastDueSince).toBeInstanceOf(Date);

    const inGrace = await getEntitlement(ctx, subjectId);
    expect(inGrace).toMatchObject({ plan: "pro", paid: true, reason: "grace" });
    const afterGrace = await getEntitlement(
      { ...ctx, now: () => new Date(row!.pastDueSince!.getTime() + 8 * 86_400_000) },
      subjectId
    );
    expect(afterGrace).toMatchObject({ plan: "free", paid: false, reason: "grace_expired" });
  }, LONG);

  const hasCli = Bun.which("stripe") !== null;
  if (!hasCli) {
    console.warn("[billing] live webhook-delivery test SKIPPED: the Stripe CLI (`stripe`) is not on PATH.");
  }

  test.skipIf(!hasCli)("Stripe delivers webhooks that the handler verifies and stores", async () => {
    const p = await prices();
    const ctx = await context();

    // The key goes to the CLI through its environment, not argv, so it does not
    // show up in the process list.
    const cliEnv = { ...process.env, STRIPE_API_KEY: key };
    const secretProc = Bun.spawnSync(["stripe", "listen", "--print-secret"], { stdout: "pipe", stderr: "pipe", env: cliEnv });
    // stderr does not carry the key, but redact key-shaped strings anyway.
    const secretStderr = secretProc.stderr.toString().replace(/(sk|rk)_(test|live)_[A-Za-z0-9]+/g, "[redacted]");
    expect(secretProc.exitCode, `stripe listen --print-secret failed: ${secretStderr.trim()}`).toBe(0);
    const secret = secretProc.stdout.toString().trim();
    expect(secret).toMatch(/^whsec_/);

    const handler = createWebhookHandler(ctx, { secret });
    const server = Bun.serve({ port: 0, fetch: (req) => handler(req) });
    cleanups.push(async () => server.stop(true));

    const listener = Bun.spawn(
      [
        "stripe", "listen", "--latest",
        "--events", "customer.subscription.created,customer.subscription.updated,invoice.paid,invoice.payment_failed",
        "--forward-to", `http://localhost:${server.port}/webhook`,
      ],
      { stdout: "pipe", stderr: "pipe", env: cliEnv }
    );
    cleanups.push(async () => listener.kill());

    try {
      // `stripe listen` prints "Ready!" on stderr once it is forwarding. The
      // reader is always released, and stderr keeps draining after Ready so the
      // CLI never blocks on a full pipe.
      let output = "";
      const reader = listener.stderr.getReader();
      try {
        await poll("stripe listen to print Ready", async () => {
          const { value, done } = await Promise.race([
            reader.read(),
            new Promise<{ value: undefined; done: false }>((r) => setTimeout(() => r({ value: undefined, done: false }), 1_000)),
          ]);
          if (value) output += new TextDecoder().decode(value);
          if (done) throw new Error("stripe listen exited before it was ready");
          return output.includes("Ready");
        }, 60_000);
      } catch (err) {
        reader.releaseLock();
        throw err;
      }
      void (async () => {
        try {
          while (!(await reader.read()).done) {}
        } catch {
          // The listener was killed.
        } finally {
          reader.releaseLock();
        }
      })();

      const { subjectId, customerId } = await customerWithCard(ctx);
      const sub = await subscribe(customerId, subjectId, p);
      cleanups.push(() => stripe().subscriptions.cancel(sub.id));

      await poll("the webhook to be delivered and processed", async () => {
        const [ev] = await ctx.db
          .select()
          .from(billingWebhookEvent)
          .where(and(eq(billingWebhookEvent.objectId, sub.id), isNotNull(billingWebhookEvent.processedAt)));
        return ev;
      }, 120_000);
      // The subscription row was written by the webhook path, not by a direct sync.
      const [row] = await ctx.db.select().from(billingSubscription).where(eq(billingSubscription.stripeSubscriptionId, sub.id));
      expect(row).toMatchObject({ subjectId, planKey: "pro" });
    } finally {
      listener.kill();
    }
  }, LONG);
});
