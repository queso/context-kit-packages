import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { syncSubscription, syncCustomerSubscriptions } from "../subscriptions";
import { billingCustomer, billingSubscription } from "../schema/postgres";
import { createTestDb } from "./helpers/db";
import { FakeStripe } from "./helpers/fake-stripe";
import { testConfig } from "./helpers/config";
import type { BillingContext } from "../types";

let fake: FakeStripe;
let ctx: BillingContext;
let close: () => Promise<void>;
const NOW = new Date("2026-01-10T12:00:00Z");

beforeEach(async () => {
  fake = new FakeStripe();
  const t = await createTestDb();
  close = t.close;
  ctx = { db: t.db, stripe: fake.client(), config: testConfig, now: () => NOW };
  fake.addPrice({ id: "price_pro", lookupKey: "test_pro_monthly" });
  fake.addPrice({ id: "price_team", lookupKey: "test_team_monthly" });
  fake.addPrice({ id: "price_old_pro", lookupKey: null, metadata: { plan_key: "pro" } });
  fake.addPrice({ id: "price_over", lookupKey: "test_credit_overage", usageType: "metered", unitAmount: 12 });
  fake.addPrice({ id: "price_unknown", lookupKey: "someone_elses_price" });
});
afterEach(() => close());

async function rows() {
  return ctx.db.select().from(billingSubscription);
}

describe("syncSubscription", () => {
  test("stores the plan, prices, period and status fetched from Stripe", async () => {
    fake.putSubscription({
      id: "sub_1",
      customer: "cus_1",
      status: "active",
      priceIds: ["price_pro", "price_over"],
      metadata: { subject_id: "100" },
      periodStart: Date.parse("2026-01-01T00:00:00Z") / 1000,
      periodEnd: Date.parse("2026-02-01T00:00:00Z") / 1000,
    });

    const result = await syncSubscription(ctx, "sub_1");

    expect(result).toEqual({ outcome: "synced", subjectId: "100", subscriptionId: "sub_1" });
    const [row] = await rows();
    expect(row).toMatchObject({
      stripeSubscriptionId: "sub_1",
      subjectId: "100",
      stripeCustomerId: "cus_1",
      status: "active",
      planKey: "pro",
      basePriceId: "price_pro",
      overagePriceId: "price_over",
      billingInterval: "month",
      billingIntervalCount: 1,
      currentPeriodStart: new Date("2026-01-01T00:00:00Z"),
      currentPeriodEnd: new Date("2026-02-01T00:00:00Z"),
      pastDueSince: null,
      syncedAt: NOW,
    });
  });

  test("does not bind an unrelated metered add-on as the overage price", async () => {
    fake.addPrice({ id: "price_addon_a", lookupKey: "addon_a", usageType: "metered" });
    fake.addPrice({ id: "price_addon_b", lookupKey: "addon_b", usageType: "metered" });
    fake.putSubscription({
      id: "sub_two",
      customer: "cus_1",
      status: "active",
      priceIds: ["price_pro", "price_addon_a", "price_addon_b"],
      metadata: { subject_id: "100" },
    });
    await syncSubscription(ctx, "sub_two");
    expect((await rows())[0]).toMatchObject({ basePriceId: "price_pro", overagePriceId: null });
  });

  test("with only metered items there is no base item: no plan, no base price", async () => {
    fake.addPrice({ id: "price_addon_a", lookupKey: "addon_a", usageType: "metered" });
    fake.addPrice({ id: "price_addon_b", lookupKey: "addon_b", usageType: "metered" });
    fake.putSubscription({
      id: "sub_metered",
      customer: "cus_1",
      status: "active",
      priceIds: ["price_addon_a", "price_addon_b"],
      metadata: { subject_id: "100" },
    });
    await syncSubscription(ctx, "sub_metered");
    expect((await rows())[0]).toMatchObject({ planKey: null, basePriceId: null, overagePriceId: null });
  });

  test("uses the only metered item as overage when it has another lookup key", async () => {
    fake.addPrice({ id: "price_grandfathered", lookupKey: "old_overage", usageType: "metered" });
    fake.putSubscription({
      id: "sub_old",
      customer: "cus_1",
      status: "active",
      priceIds: ["price_pro", "price_grandfathered"],
      metadata: { subject_id: "100" },
    });
    await syncSubscription(ctx, "sub_old");
    expect((await rows())[0]).toMatchObject({ basePriceId: "price_pro", overagePriceId: "price_grandfathered" });
  });

  test("finds the subject through billing_customer when metadata is missing", async () => {
    await ctx.db.insert(billingCustomer).values({ subjectId: "200", stripeCustomerId: "cus_2", livemode: false });
    fake.putSubscription({ id: "sub_2", customer: "cus_2", status: "active", priceIds: ["price_team"] });

    const result = await syncSubscription(ctx, "sub_2");
    expect(result.outcome).toBe("synced");
    expect((await rows())[0]?.subjectId).toBe("200");
  });

  test("reports an unknown subject instead of guessing", async () => {
    fake.putSubscription({ id: "sub_3", customer: "cus_nobody", status: "active", priceIds: ["price_pro"] });
    expect(await syncSubscription(ctx, "sub_3")).toEqual({
      outcome: "unknown_subject",
      subscriptionId: "sub_3",
    });
    expect(await rows()).toHaveLength(0);
  });

  test("recognises a grandfathered price by its plan_key metadata", async () => {
    fake.putSubscription({
      id: "sub_4",
      customer: "cus_4",
      status: "active",
      priceIds: ["price_old_pro", "price_over"],
      metadata: { subject_id: "400" },
    });
    await syncSubscription(ctx, "sub_4");
    expect((await rows())[0]?.planKey).toBe("pro");
  });

  test("stores a null plan for a price the app does not know", async () => {
    fake.putSubscription({
      id: "sub_5",
      customer: "cus_5",
      status: "active",
      priceIds: ["price_unknown"],
      metadata: { subject_id: "500" },
    });
    await syncSubscription(ctx, "sub_5");
    expect((await rows())[0]?.planKey).toBeNull();
  });

  test("takes past_due_since from the unpaid invoice's finalization time", async () => {
    const finalized = Date.parse("2026-01-02T03:04:05Z") / 1000;
    fake.putSubscription({
      id: "sub_6",
      customer: "cus_6",
      status: "past_due",
      priceIds: ["price_pro", "price_over"],
      metadata: { subject_id: "600" },
      latestInvoiceFinalizedAt: finalized,
    });
    await syncSubscription(ctx, "sub_6");
    expect((await rows())[0]?.pastDueSince).toEqual(new Date("2026-01-02T03:04:05Z"));
  });

  test("a renewal invoice does not restart the grace period: it counts from the oldest open invoice", async () => {
    const oct = Date.parse("2025-10-01T01:00:00Z") / 1000;
    const nov = Date.parse("2025-11-01T01:00:00Z") / 1000;
    fake.putSubscription({
      id: "sub_g",
      customer: "cus_g",
      status: "past_due",
      priceIds: ["price_pro", "price_over"],
      metadata: { subject_id: "g" },
      openInvoicesFinalizedAt: [nov, oct],
      latestInvoiceFinalizedAt: nov,
    });
    await syncSubscription(ctx, "sub_g");
    expect((await rows())[0]?.pastDueSince).toEqual(new Date("2025-10-01T01:00:00Z"));
  });

  test("keeps the stored past_due_since when Stripe no longer shows an open invoice for it", async () => {
    const jan2 = Date.parse("2026-01-02T00:00:00Z") / 1000;
    fake.putSubscription({ id: "sub_k", customer: "cus_k", status: "past_due", priceIds: ["price_pro"], metadata: { subject_id: "k" }, latestInvoiceFinalizedAt: jan2 });
    await syncSubscription(ctx, "sub_k");
    // The renewal is still a draft and the old invoice was marked uncollectible.
    fake.putSubscription({ id: "sub_k", customer: "cus_k", status: "past_due", priceIds: ["price_pro"], metadata: { subject_id: "k" }, latestInvoiceFinalizedAt: jan2 + 86_400 * 30, latestInvoiceStatus: "draft" });
    await syncSubscription(ctx, "sub_k");
    expect((await rows())[0]?.pastDueSince).toEqual(new Date("2026-01-02T00:00:00Z"));
  });

  test("a past_due subscription always gets a past_due_since, so the grace period cannot be unlimited", async () => {
    fake.putSubscription({ id: "sub_n", customer: "cus_n", status: "past_due", priceIds: ["price_pro"], metadata: { subject_id: "n" } });
    await syncSubscription(ctx, "sub_n");
    expect((await rows())[0]?.pastDueSince).toEqual(NOW);
  });

  test("a payment after the stored date ends that unpaid stretch, even if the recovery sync was missed", async () => {
    const jan2 = Date.parse("2026-01-02T00:00:00Z") / 1000;
    fake.putSubscription({ id: "sub_r", customer: "cus_r", status: "past_due", priceIds: ["price_pro"], metadata: { subject_id: "r" }, latestInvoiceFinalizedAt: jan2 });
    await syncSubscription(ctx, "sub_r");
    // The customer paid on Feb 3 (that active sync never arrived) and went past
    // due again with the Mar 2 invoice.
    const feb3 = Date.parse("2026-02-03T00:00:00Z") / 1000;
    const mar2 = Date.parse("2026-03-02T00:00:00Z") / 1000;
    fake.putSubscription({
      id: "sub_r",
      customer: "cus_r",
      status: "past_due",
      priceIds: ["price_pro"],
      metadata: { subject_id: "r" },
      paidInvoicesPaidAt: [feb3],
      latestInvoiceFinalizedAt: mar2,
    });
    await syncSubscription(ctx, "sub_r");
    expect((await rows())[0]?.pastDueSince).toEqual(new Date("2026-03-02T00:00:00Z"));
  });

  test("unpaid gets no grace start: it is on free limits by design", async () => {
    fake.putSubscription({ id: "sub_u", customer: "cus_u", status: "unpaid", priceIds: ["price_pro"], metadata: { subject_id: "u" }, latestInvoiceFinalizedAt: Date.parse("2026-01-02T00:00:00Z") / 1000 });
    await syncSubscription(ctx, "sub_u");
    expect((await rows())[0]?.pastDueSince).toBeNull();
  });

  test("the stored customer mapping wins over subscription metadata", async () => {
    await ctx.db.insert(billingCustomer).values({ subjectId: "real", stripeCustomerId: "cus_m", livemode: false });
    fake.putSubscription({ id: "sub_m", customer: "cus_m", status: "active", priceIds: ["price_pro"], metadata: { subject_id: "real" } });
    expect(await syncSubscription(ctx, "sub_m")).toMatchObject({ outcome: "synced", subjectId: "real" });
  });

  test("metadata naming a different subject than the customer mapping is refused, not stored", async () => {
    await ctx.db.insert(billingCustomer).values({ subjectId: "real", stripeCustomerId: "cus_m", livemode: false });
    fake.putSubscription({ id: "sub_m", customer: "cus_m", status: "active", priceIds: ["price_pro"], metadata: { subject_id: "someone_else" } });
    expect(await syncSubscription(ctx, "sub_m")).toEqual({ outcome: "subject_mismatch", subscriptionId: "sub_m" });
    expect(await rows()).toHaveLength(0);
  });

  test("an unmapped customer's subject_id metadata attributes a subscription that has none of its own", async () => {
    fake.putCustomer("cus_c", { subject_id: "cm1" });
    fake.putSubscription({ id: "sub_c", customer: "cus_c", status: "active", priceIds: ["price_pro"] });
    expect(await syncSubscription(ctx, "sub_c")).toMatchObject({ outcome: "synced", subjectId: "cm1" });
    expect(await rows()).toEqual([expect.objectContaining({ stripeSubscriptionId: "sub_c", subjectId: "cm1", stripeCustomerId: "cus_c" })]);
  });

  test("retrieves the subscription with the customer expanded", async () => {
    fake.putCustomer("cus_c", { subject_id: "cm1" });
    fake.putSubscription({ id: "sub_c", customer: "cus_c", status: "active", priceIds: ["price_pro"] });
    await syncSubscription(ctx, "sub_c");
    const get = fake.requests.find((r) => r.method === "GET" && r.path === "/v1/subscriptions/sub_c");
    expect(get?.params.expand).toEqual(["latest_invoice", "customer"]);
  });

  test("subscription and customer metadata that disagree, with no mapping, are refused", async () => {
    fake.putCustomer("cus_c", { subject_id: "cm1" });
    fake.putSubscription({ id: "sub_c", customer: "cus_c", status: "active", priceIds: ["price_pro"], metadata: { subject_id: "cm2" } });
    expect(await syncSubscription(ctx, "sub_c")).toEqual({ outcome: "subject_mismatch", subscriptionId: "sub_c" });
    expect(await rows()).toHaveLength(0);
  });

  test("customer metadata that disagrees with the stored mapping is refused", async () => {
    await ctx.db.insert(billingCustomer).values({ subjectId: "real", stripeCustomerId: "cus_c", livemode: false });
    fake.putCustomer("cus_c", { subject_id: "other" });
    fake.putSubscription({ id: "sub_c", customer: "cus_c", status: "active", priceIds: ["price_pro"] });
    expect(await syncSubscription(ctx, "sub_c")).toEqual({ outcome: "subject_mismatch", subscriptionId: "sub_c" });
    expect(await rows()).toHaveLength(0);
  });

  test("customer metadata that agrees with the stored mapping is accepted", async () => {
    await ctx.db.insert(billingCustomer).values({ subjectId: "real", stripeCustomerId: "cus_c", livemode: false });
    fake.putCustomer("cus_c", { subject_id: "real" });
    fake.putSubscription({ id: "sub_c", customer: "cus_c", status: "active", priceIds: ["price_pro"] });
    expect(await syncSubscription(ctx, "sub_c")).toMatchObject({ outcome: "synced", subjectId: "real" });
  });

  test("a deleted customer contributes no subject, leaving the subscription unknown", async () => {
    fake.putCustomer("cus_gone", { subject_id: "cm1" });
    Object.assign(fake.customers.get("cus_gone")!, { deleted: true, metadata: undefined });
    fake.putSubscription({ id: "sub_c", customer: "cus_gone", status: "canceled", priceIds: ["price_pro"] });
    expect(await syncSubscription(ctx, "sub_c")).toEqual({ outcome: "unknown_subject", subscriptionId: "sub_c" });
  });

  test("clears past_due_since once the subscription is active again", async () => {
    fake.putSubscription({
      id: "sub_7",
      customer: "cus_7",
      status: "past_due",
      priceIds: ["price_pro"],
      metadata: { subject_id: "700" },
      latestInvoiceFinalizedAt: Date.parse("2026-01-02T00:00:00Z") / 1000,
    });
    await syncSubscription(ctx, "sub_7");
    fake.putSubscription({
      id: "sub_7",
      customer: "cus_7",
      status: "active",
      priceIds: ["price_pro"],
      metadata: { subject_id: "700" },
    });
    await syncSubscription(ctx, "sub_7");
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: "active", pastDueSince: null });
  });

  test("is safe to run twice and converges on Stripe's current state", async () => {
    fake.putSubscription({ id: "sub_8", customer: "cus_8", status: "active", priceIds: ["price_pro"], metadata: { subject_id: "800" } });
    await syncSubscription(ctx, "sub_8");
    await syncSubscription(ctx, "sub_8");
    expect(await rows()).toHaveLength(1);

    // A plan change in Stripe overwrites the whole row on the next sync,
    // whichever event triggered it.
    fake.putSubscription({ id: "sub_8", customer: "cus_8", status: "active", priceIds: ["price_team"], metadata: { subject_id: "800" } });
    await syncSubscription(ctx, "sub_8");
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]?.planKey).toBe("team");
  });

  test("stores cancel_at and trial_end", async () => {
    fake.putSubscription({
      id: "sub_9",
      customer: "cus_9",
      status: "trialing",
      priceIds: ["price_pro"],
      metadata: { subject_id: "900" },
      cancelAt: Date.parse("2026-02-01T00:00:00Z") / 1000,
      trialEnd: Date.parse("2026-01-15T00:00:00Z") / 1000,
    });
    await syncSubscription(ctx, "sub_9");
    expect((await rows())[0]).toMatchObject({
      cancelAt: new Date("2026-02-01T00:00:00Z"),
      trialEnd: new Date("2026-01-15T00:00:00Z"),
    });
  });

  test("asks Stripe for the latest invoice and customer in the same request", async () => {
    fake.putSubscription({ id: "sub_10", customer: "cus_10", status: "active", priceIds: ["price_pro"], metadata: { subject_id: "1000" } });
    await syncSubscription(ctx, "sub_10");
    const req = fake.requests.find((r) => r.path === "/v1/subscriptions/sub_10");
    expect(req?.params.expand).toEqual(["latest_invoice", "customer"]);
  });
});

describe("syncCustomerSubscriptions", () => {
  test("syncs every subscription of the customer, canceled ones included", async () => {
    await ctx.db.insert(billingCustomer).values({ subjectId: "300", stripeCustomerId: "cus_3", livemode: false });
    fake.putSubscription({ id: "sub_a", customer: "cus_3", status: "canceled", priceIds: ["price_pro"] });
    fake.putSubscription({ id: "sub_b", customer: "cus_3", status: "active", priceIds: ["price_team"] });
    fake.putSubscription({ id: "sub_other", customer: "cus_other", status: "active", priceIds: ["price_team"] });

    const results = await syncCustomerSubscriptions(ctx, "cus_3");

    expect(results.map((r) => r.subscriptionId).sort()).toEqual(["sub_a", "sub_b"]);
    const req = fake.requests.find((r) => r.path === "/v1/subscriptions" && r.method === "GET");
    expect(req?.params).toMatchObject({ customer: "cus_3", status: "all" });
    expect((await rows()).map((r) => r.stripeSubscriptionId).sort()).toEqual(["sub_a", "sub_b"]);
  });
});
