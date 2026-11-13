import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
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

  test("with repairCustomers, moves an empty mapping to the other customer that holds the live subscription", async () => {
    await ctx.db.insert(billingCustomer).values({ subjectId: "90", stripeCustomerId: "cus_empty", livemode: false });
    fake.putCustomer("cus_empty", { subject_id: "90" });
    fake.putCustomer("cus_paying", { subject_id: "90" });
    fake.putSubscription({ id: "sub_paid", customer: "cus_paying", status: "active", priceIds: ["price_pro"] });

    const summary = await reconcile(ctx, { repairCustomers: true });

    expect(summary.duplicateSubjects).toBe(1);
    expect(await ctx.db.select().from(billingCustomer)).toEqual([
      expect.objectContaining({ subjectId: "90", stripeCustomerId: "cus_paying" }),
    ]);
    expect(await ctx.db.select().from(billingSubscription)).toEqual([
      expect.objectContaining({ stripeSubscriptionId: "sub_paid", subjectId: "90", planKey: "pro" }),
    ]);
  });

  test("with repairCustomers and several live customers, keeps the mapping and syncs every subscription", async () => {
    await ctx.db.insert(billingCustomer).values({ subjectId: "91", stripeCustomerId: "cus_a", livemode: false });
    fake.putCustomer("cus_a", { subject_id: "91" });
    fake.putCustomer("cus_b", { subject_id: "91" });
    fake.putSubscription({ id: "sub_a", customer: "cus_a", status: "active", priceIds: ["price_pro"], metadata: { subject_id: "91" } });
    fake.putSubscription({ id: "sub_b", customer: "cus_b", status: "active", priceIds: ["price_team"], metadata: { subject_id: "91" } });

    const summary = await reconcile(ctx, { repairCustomers: true });

    expect(summary.duplicateSubjects).toBe(1);
    expect((await ctx.db.select().from(billingCustomer))[0]?.stripeCustomerId).toBe("cus_a");
    const subs = await ctx.db.select().from(billingSubscription);
    expect(subs.map((r) => r.stripeSubscriptionId).sort()).toEqual(["sub_a", "sub_b"]);
    expect(subs.every((r) => r.subjectId === "91")).toBe(true);
  });

  test("syncs a duplicate customer's subscription that has no metadata of its own, using the customer's tag", async () => {
    await ctx.db.insert(billingCustomer).values({ subjectId: "92", stripeCustomerId: "cus_a", livemode: false });
    fake.putCustomer("cus_a", { subject_id: "92" });
    fake.putCustomer("cus_b", { subject_id: "92" });
    fake.putSubscription({ id: "sub_a", customer: "cus_a", status: "active", priceIds: ["price_pro"] });
    fake.putSubscription({ id: "sub_b", customer: "cus_b", status: "active", priceIds: ["price_team"] });

    const summary = await reconcile(ctx, { repairCustomers: true });

    expect(summary.unknownSubject).toBe(0);
    const subs = await ctx.db.select().from(billingSubscription);
    expect(subs.map((r) => [r.stripeSubscriptionId, r.subjectId]).sort()).toEqual([["sub_a", "92"], ["sub_b", "92"]]);
  });

  test("when it moves a mapping, it also syncs the previously mapped customer so its canceled subscriptions are not stale", async () => {
    await ctx.db.insert(billingCustomer).values({ subjectId: "93", stripeCustomerId: "cus_empty", livemode: false });
    fake.putCustomer("cus_empty", { subject_id: "93" });
    fake.putCustomer("cus_paying", { subject_id: "93" });
    fake.putSubscription({ id: "sub_old", customer: "cus_empty", status: "canceled", priceIds: ["price_pro"] });
    fake.putSubscription({ id: "sub_new", customer: "cus_paying", status: "active", priceIds: ["price_pro"] });
    await ctx.db.insert(billingSubscription).values({
      stripeSubscriptionId: "sub_old",
      subjectId: "93",
      stripeCustomerId: "cus_empty",
      status: "active",
      planKey: "pro",
      livemode: false,
      syncedAt: new Date(0),
    });

    await reconcile(ctx, { repairCustomers: true });

    expect((await ctx.db.select().from(billingCustomer))[0]?.stripeCustomerId).toBe("cus_paying");
    const subs = await ctx.db.select().from(billingSubscription);
    expect(subs.find((r) => r.stripeSubscriptionId === "sub_old")?.status).toBe("canceled");
    expect(subs.find((r) => r.stripeSubscriptionId === "sub_new")?.status).toBe("active");
  });

  test("finds a live subscription that is beyond the first page of a customer's subscriptions", async () => {
    fake.putCustomer("cus_old", { subject_id: "94" });
    fake.putCustomer("cus_busy", { subject_id: "94" });
    fake.customers.get("cus_old")!.created = 100;
    fake.customers.get("cus_busy")!.created = 300;
    for (let i = 0; i < 100; i++) {
      fake.putSubscription({ id: `sub_dead${i}`, customer: "cus_busy", status: "canceled", priceIds: ["price_pro"] });
    }
    fake.putSubscription({ id: "sub_live", customer: "cus_busy", status: "active", priceIds: ["price_pro"] });

    await reconcile(ctx, { repairCustomers: true });

    expect((await ctx.db.select().from(billingCustomer))[0]?.stripeCustomerId).toBe("cus_busy");
    const pages = fake.requests.filter(
      (r) => r.path === "/v1/subscriptions" && r.params.customer === "cus_busy" && r.params.starting_after !== undefined
    );
    expect(pages.length).toBeGreaterThan(0);
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

  describe("moving a mapping", () => {
    async function seedMove() {
      await ctx.db.insert(billingCustomer).values({ subjectId: "95", stripeCustomerId: "cus_empty", livemode: false });
      fake.putCustomer("cus_empty", { subject_id: "95" });
      fake.putCustomer("cus_paying", { subject_id: "95" });
      fake.putSubscription({ id: "sub_paid", customer: "cus_paying", status: "active", priceIds: ["price_pro"] });
    }

    // Runs a hook once, just before the first update or transaction (the move), and records every tx.execute.
    function spyDb(beforeMove?: () => Promise<void>) {
      let hooked = false;
      const hook = async () => {
        if (hooked) return;
        hooked = true;
        await beforeMove?.();
      };
      const executed: string[] = [];
      const db = new Proxy(ctx.db, {
        get(target, prop, receiver) {
          if (prop === "update") {
            return (...a: unknown[]) => {
              const builder = (target as any).update(...a);
              return new Proxy(builder, {
                get(t, p, r) {
                  if (p !== "set") return Reflect.get(t, p, r);
                  return (...sa: unknown[]) => {
                    const q = t.set(...sa);
                    return new Proxy(q, {
                      get(t2, p2, r2) {
                        if (p2 !== "where") return Reflect.get(t2, p2, r2);
                        return async (...wa: unknown[]) => {
                          await hook();
                          return t2.where(...wa);
                        };
                      },
                    });
                  };
                },
              });
            };
          }
          if (prop !== "transaction") return Reflect.get(target, prop, receiver);
          return async (fn: (tx: any) => Promise<unknown>, ...rest: unknown[]) => {
            await hook();
            return (target as any).transaction(async (tx: any) => {
              const spied = new Proxy(tx, {
                get(t, p, r) {
                  if (p !== "execute") return Reflect.get(t, p, r);
                  return (q: any, ...a: unknown[]) => {
                    executed.push(JSON.stringify(q?.queryChunks ?? q));
                    return t.execute(q, ...a);
                  };
                },
              });
              return fn(spied);
            }, ...rest);
          };
        },
      }) as typeof ctx.db;
      return { db, executed };
    }

    test("takes the customer advisory lock while moving the mapping", async () => {
      await seedMove();
      const { db, executed } = spyDb();
      await reconcile({ ...ctx, db }, { repairCustomers: true });
      expect((await ctx.db.select().from(billingCustomer))[0]?.stripeCustomerId).toBe("cus_paying");
      expect(executed.some((q) => q.includes("pg_advisory_xact_lock") && q.includes("customer:95"))).toBe(true);
    });

    test("does not overwrite a mapping that changed after the decision", async () => {
      await seedMove();
      const { db } = spyDb(async () => {
        await ctx.db.update(billingCustomer).set({ stripeCustomerId: "cus_other" }).where(eq(billingCustomer.subjectId, "95"));
      });
      await reconcile({ ...ctx, db }, { repairCustomers: true });
      expect((await ctx.db.select().from(billingCustomer))[0]?.stripeCustomerId).toBe("cus_other");
    });
  });
});
