import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { ensureCustomer, getCustomerId } from "../customers";
import { billingCustomer } from "../schema/postgres";
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
});
afterEach(() => close());

const customerCreates = () =>
  fake.requests.filter((r) => r.method === "POST" && r.path === "/v1/customers");

describe("ensureCustomer", () => {
  test("creates a Stripe customer tagged with the subject and stores the mapping", async () => {
    const id = await ensureCustomer(ctx, "12345", { name: "octo-org" });

    expect(id).toMatch(/^cus_/);
    const [req] = customerCreates();
    expect(req?.params.metadata).toEqual({ subject_id: "12345" });
    expect(req?.params.name).toBe("octo-org");
    expect(req?.idempotencyKey).toBe("context-kit-billing:customer:12345");

    const rows = await ctx.db.select().from(billingCustomer);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subjectId: "12345", stripeCustomerId: id, livemode: false });
  });

  test("returns the stored customer without calling Stripe again", async () => {
    const first = await ensureCustomer(ctx, "12345");
    const second = await ensureCustomer(ctx, "12345");
    expect(second).toBe(first);
    expect(customerCreates()).toHaveLength(1);
  });

  test("two concurrent first calls end with one Stripe customer and one row", async () => {
    const [a, b] = await Promise.all([ensureCustomer(ctx, "777"), ensureCustomer(ctx, "777")]);
    expect(a).toBe(b);
    // Both calls may reach Stripe, but they share an idempotency key, so Stripe
    // returns the same customer to both.
    expect(new Set(fake.customers.keys()).size).toBe(1);
    const rows = await ctx.db.select().from(billingCustomer).where(eq(billingCustomer.subjectId, "777"));
    expect(rows).toHaveLength(1);
  });

  test("stores nothing when Stripe fails, so the next call retries", async () => {
    fake.failNext((r) => r.path === "/v1/customers", 500);
    await expect(ensureCustomer(ctx, "42")).rejects.toThrow();
    expect(await ctx.db.select().from(billingCustomer)).toHaveLength(0);

    const id = await ensureCustomer(ctx, "42");
    expect(id).toMatch(/^cus_/);
  });

  test.each(["", " ", "x".repeat(201)])("rejects subject id %p", async (bad) => {
    await expect(ensureCustomer(ctx, bad)).rejects.toThrow(/subjectId/);
    expect(customerCreates()).toHaveLength(0);
  });
});

describe("getCustomerId", () => {
  test("is null for a subject that never checked out", async () => {
    expect(await getCustomerId(ctx.db, "nobody")).toBeNull();
  });

  test("returns the mapped customer", async () => {
    const id = await ensureCustomer(ctx, "9");
    expect(await getCustomerId(ctx.db, "9")).toBe(id);
  });
});
