import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { reconcile } from "../reconcile";
import { billingCustomer, billingSubscription } from "../schema/postgres";
import { createTestDb } from "./helpers/db";
import { FakeStripe } from "./helpers/fake-stripe";
import { testConfig } from "./helpers/config";
import type { BillingContext } from "../types";

let fake: FakeStripe;
let ctx: BillingContext;
let close: () => Promise<void>;

beforeEach(async () => {
  fake = new FakeStripe();
  const t = await createTestDb();
  close = t.close;
  ctx = { db: t.db, stripe: fake.client(), config: testConfig };
  fake.addPrice({ id: "price_pro", lookupKey: "test_pro_monthly" });
  fake.addPrice({ id: "price_team", lookupKey: "test_team_monthly" });
});
afterEach(() => close());

describe("reconcile", () => {
  test("rebuilds every stored customer's subscriptions from Stripe", async () => {
    await ctx.db.insert(billingCustomer).values([
      { subjectId: "1", stripeCustomerId: "cus_1", livemode: false },
      { subjectId: "2", stripeCustomerId: "cus_2", livemode: false },
    ]);
    fake.putSubscription({ id: "sub_1", customer: "cus_1", status: "active", priceIds: ["price_pro"] });
    fake.putSubscription({ id: "sub_2", customer: "cus_2", status: "canceled", priceIds: ["price_team"] });
    // A stale local row that Stripe now disagrees with.
    await ctx.db.insert(billingSubscription).values({
      stripeSubscriptionId: "sub_1",
      subjectId: "1",
      stripeCustomerId: "cus_1",
      status: "past_due",
      planKey: "team",
      livemode: false,
      syncedAt: new Date(0),
    });

    const summary = await reconcile(ctx);

    expect(summary).toEqual({ customers: 2, subscriptions: 2, unknownSubject: 0, repairedCustomers: 0, duplicateSubjects: 0 });
    const rows = await ctx.db.select().from(billingSubscription);
    expect(rows.find((r) => r.stripeSubscriptionId === "sub_1")).toMatchObject({ status: "active", planKey: "pro" });
    expect(rows.find((r) => r.stripeSubscriptionId === "sub_2")?.status).toBe("canceled");
  });

  test("with repairCustomers, restores a lost mapping from the customer's subject_id metadata", async () => {
    fake.putCustomer("cus_lost", { subject_id: "77" });
    fake.putCustomer("cus_foreign", {});
    fake.putSubscription({ id: "sub_lost", customer: "cus_lost", status: "active", priceIds: ["price_pro"] });

    const summary = await reconcile(ctx, { repairCustomers: true });

    expect(summary.repairedCustomers).toBe(1);
    expect(await ctx.db.select().from(billingCustomer)).toEqual([
      expect.objectContaining({ subjectId: "77", stripeCustomerId: "cus_lost" }),
    ]);
    expect((await ctx.db.select().from(billingSubscription))[0]).toMatchObject({ subjectId: "77", planKey: "pro" });
  });

  test("with duplicate customers for a subject, picks the one with a live subscription", async () => {
    // The list is newest first in Stripe; here the empty customer is listed first.
    fake.putCustomer("cus_paying", { subject_id: "88" });
    fake.putCustomer("cus_empty", { subject_id: "88" });
    fake.putSubscription({ id: "sub_dead", customer: "cus_empty", status: "canceled", priceIds: ["price_pro"] });
    fake.putSubscription({ id: "sub_live", customer: "cus_paying", status: "active", priceIds: ["price_pro"] });
    // The empty customer is older, so age alone would pick it.
    fake.customers.get("cus_empty")!.created = 100;
    fake.customers.get("cus_paying")!.created = 300;

    const summary = await reconcile(ctx, { repairCustomers: true });

    expect(summary.duplicateSubjects).toBe(1);
    expect(summary.repairedCustomers).toBe(1);
    expect(await ctx.db.select().from(billingCustomer)).toEqual([
      expect.objectContaining({ subjectId: "88", stripeCustomerId: "cus_paying" }),
    ]);
  });

  test("with duplicates and no live subscription, picks the oldest customer", async () => {
    fake.putCustomer("cus_new", { subject_id: "89" });
    fake.putCustomer("cus_old", { subject_id: "89" });
    fake.customers.get("cus_new")!.created = 500;
    fake.customers.get("cus_old")!.created = 100;

    const summary = await reconcile(ctx, { repairCustomers: true });

    expect(summary.duplicateSubjects).toBe(1);
    expect((await ctx.db.select().from(billingCustomer))[0]?.stripeCustomerId).toBe("cus_old");
  });

  test("never uses the search API, which is not read-after-write", async () => {
    fake.putCustomer("cus_lost", { subject_id: "77" });
    await reconcile(ctx, { repairCustomers: true });
    expect(fake.requests.some((r) => r.path.endsWith("/search"))).toBe(false);
  });

  test("is safe to run twice", async () => {
    await ctx.db.insert(billingCustomer).values({ subjectId: "1", stripeCustomerId: "cus_1", livemode: false });
    fake.putSubscription({ id: "sub_1", customer: "cus_1", status: "active", priceIds: ["price_pro"] });
    await reconcile(ctx);
    await reconcile(ctx);
    expect(await ctx.db.select().from(billingSubscription)).toHaveLength(1);
  });
});
