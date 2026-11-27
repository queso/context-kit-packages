import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { assertSubjectId, ensureCustomer, getCustomerId } from "../customers";
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
    expect(req?.params.name).toBeUndefined();
    expect(req?.idempotencyKey).toBe("context-kit-billing:customer:12345");

    const rows = await ctx.db.select().from(billingCustomer);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subjectId: "12345", stripeCustomerId: id, livemode: false });
  });

  test("creates with stable parameters only and applies name and email in an update", async () => {
    const id = await ensureCustomer(ctx, "12", { name: "octo-org", email: "a@example.com" });
    const [create] = customerCreates();
    expect(create?.params).toEqual({ metadata: { subject_id: "12" } });
    const update = fake.requests.find((r) => r.method === "POST" && r.path === `/v1/customers/${id}`);
    expect(update?.params).toEqual({ name: "octo-org", email: "a@example.com" });
    expect(fake.customers.get(id)).toMatchObject({ name: "octo-org", email: "a@example.com" });
  });

  test("makes no update call when no details are given", async () => {
    await ensureCustomer(ctx, "13");
    expect(fake.requests.filter((r) => r.path.startsWith("/v1/customers/") && r.method === "POST")).toHaveLength(0);
  });

  test("a failing update propagates after the mapping is stored", async () => {
    fake.failNext((r) => r.method === "POST" && /^\/v1\/customers\/cus_/.test(r.path), 400);
    await expect(ensureCustomer(ctx, "14", { name: "x" })).rejects.toThrow();
    expect(await ctx.db.select().from(billingCustomer)).toHaveLength(1);
  });

  test("a retry with different details after a lost create response ends with one customer", async () => {
    fake.loseNextResponse((r) => r.method === "POST" && r.path === "/v1/customers", 400);
    await expect(ensureCustomer(ctx, "15", { name: "first" })).rejects.toThrow();
    const id = await ensureCustomer(ctx, "15", { name: "second" });
    expect(fake.customers.size).toBe(1);
    expect(await getCustomerId(ctx.db, "15")).toBe(id);
    expect(fake.customers.get(id)?.name).toBe("second");
  });

  test("recovers from a create 500 by finding the customer that Stripe did create", async () => {
    fake.loseNextResponse((r) => r.method === "POST" && r.path === "/v1/customers", 500);
    const id = await ensureCustomer(ctx, "16");
    expect([...fake.customers.keys()]).toEqual([id]);
    expect(await getCustomerId(ctx.db, "16")).toBe(id);
    expect(fake.requests.some((r) => r.path === "/v1/customers/search")).toBe(true);
  });

  test("after a create 500 with nothing found anywhere, creates again under a new idempotency key", async () => {
    fake.failNext((r) => r.method === "POST" && r.path === "/v1/customers", 500);
    const id = await ensureCustomer(ctx, "17");
    const creates = customerCreates();
    expect(creates).toHaveLength(2);
    expect(creates[0]?.idempotencyKey).toBe("context-kit-billing:customer:17");
    expect(creates[1]?.idempotencyKey).toMatch(/^context-kit-billing:customer:17:retry:\d+$/);
    expect(await getCustomerId(ctx.db, "17")).toBe(id);
    expect(fake.customers.size).toBe(1);
  });

  test("after a cached create 500 with no customer anywhere, creates under a new key and stores it", async () => {
    fake.failAndCache((r) => r.method === "POST" && r.path === "/v1/customers", 500);
    const id = await ensureCustomer(ctx, "17c");
    const creates = customerCreates();
    expect(creates).toHaveLength(2);
    expect(creates[0]?.idempotencyKey).toBe("context-kit-billing:customer:17c");
    expect(creates[1]?.idempotencyKey).toMatch(/^context-kit-billing:customer:17c:retry:\d+$/);
    expect(fake.customers.size).toBe(1);
    expect(await getCustomerId(ctx.db, "17c")).toBe(id);
  });

  test("after a network error with no customer anywhere, rethrows and creates nothing else", async () => {
    fake.failNetwork((r) => r.method === "POST" && r.path === "/v1/customers");
    await expect(ensureCustomer(ctx, "17d")).rejects.toThrow();
    expect(customerCreates()).toHaveLength(1);
    expect(fake.customers.size).toBe(0);
    expect(await ctx.db.select().from(billingCustomer)).toHaveLength(0);

    // The next call retries with the same key, which is safe if the first create is still in flight.
    const id = await ensureCustomer(ctx, "17d");
    const creates = customerCreates();
    expect(creates).toHaveLength(2);
    expect(creates[1]?.idempotencyKey).toBe("context-kit-billing:customer:17d");
    expect(await getCustomerId(ctx.db, "17d")).toBe(id);
  });

  test("after a network error where Stripe did create the customer, finds and stores it", async () => {
    fake.failNetwork((r) => r.method === "POST" && r.path === "/v1/customers", true);
    const id = await ensureCustomer(ctx, "17e");
    expect(customerCreates()).toHaveLength(1);
    expect([...fake.customers.keys()]).toEqual([id]);
    expect(await getCustomerId(ctx.db, "17e")).toBe(id);
  });

  test("two concurrent calls after a cached 500 end with one customer and one mapping", async () => {
    fake.failAndCache((r) => r.method === "POST" && r.path === "/v1/customers", 500);
    // Distinct retry keys per call, so only the lock can prevent two creates.
    const realNow = Date.now;
    let tick = realNow();
    Date.now = () => ++tick;
    try {
      const [a, b] = await Promise.all([ensureCustomer(ctx, "17f"), ensureCustomer(ctx, "17f")]);
      expect(a).toBe(b);
    } finally {
      Date.now = realNow;
    }
    expect(fake.customers.size).toBe(1);
    expect(await ctx.db.select().from(billingCustomer)).toHaveLength(1);
    // The second caller waits for the first and finds its mapping: the cached
    // failure and the one retry are the only creates.
    expect(customerCreates()).toHaveLength(2);
  });

  test("propagates the error when the second create fails too, storing nothing", async () => {
    fake.failNext((r) => r.method === "POST" && r.path === "/v1/customers", 500, 2);
    await expect(ensureCustomer(ctx, "17b")).rejects.toThrow(/fake failure/);
    expect(await ctx.db.select().from(billingCustomer)).toHaveLength(0);
  });

  test("finds the customer by listing when search lags, without creating again", async () => {
    fake.putCustomer("cus_lagging", { subject_id: "20" });
    fake.failNext((r) => r.path === "/v1/customers/search", 200, 1, {
      object: "search_result",
      data: [],
      has_more: false,
    });
    fake.failNext((r) => r.method === "POST" && r.path === "/v1/customers", 500);
    const id = await ensureCustomer(ctx, "20");
    expect(id).toBe("cus_lagging");
    expect(customerCreates()).toHaveLength(1);
    expect(await getCustomerId(ctx.db, "20")).toBe("cus_lagging");
  });

  test("throws naming the customers when the list scan finds several", async () => {
    fake.putCustomer("cus_a", { subject_id: "21" });
    fake.putCustomer("cus_b", { subject_id: "21" });
    fake.failNext((r) => r.path === "/v1/customers/search", 200, 1, {
      object: "search_result",
      data: [],
      has_more: false,
    });
    fake.failNext((r) => r.method === "POST" && r.path === "/v1/customers", 500);
    await expect(ensureCustomer(ctx, "21")).rejects.toThrow(/cus_a.*cus_b|cus_b.*cus_a/);
    expect(await ctx.db.select().from(billingCustomer)).toHaveLength(0);
  });

  test("a retry applies the details when the mapping exists but the first update failed", async () => {
    fake.failNext((r) => r.method === "POST" && /^\/v1\/customers\/cus_/.test(r.path), 400);
    await expect(ensureCustomer(ctx, "22", { name: "n", email: "e@example.com" })).rejects.toThrow();
    const id = await ensureCustomer(ctx, "22", { name: "n", email: "e@example.com" });
    expect(fake.customers.get(id)).toMatchObject({ name: "n", email: "e@example.com" });
    expect(customerCreates()).toHaveLength(1);
  });

  test("throws naming the customers when the search finds several", async () => {
    fake.putCustomer("cus_a", { subject_id: "18" });
    fake.putCustomer("cus_b", { subject_id: "18" });
    fake.failNext((r) => r.method === "POST" && r.path === "/v1/customers", 500);
    await expect(ensureCustomer(ctx, "18")).rejects.toThrow(/cus_a.*cus_b|cus_b.*cus_a/);
    expect(await ctx.db.select().from(billingCustomer)).toHaveLength(0);
  });

  test("does not look for a customer after a 4xx create error", async () => {
    fake.putCustomer("cus_a", { subject_id: "19" });
    fake.failNext((r) => r.method === "POST" && r.path === "/v1/customers", 400);
    await expect(ensureCustomer(ctx, "19")).rejects.toThrow();
    expect(fake.requests.some((r) => r.path === "/v1/customers/search")).toBe(false);
  });

  test("escapes quotes in the subject id for the search query", async () => {
    fake.failNext((r) => r.method === "POST" && r.path === "/v1/customers", 500);
    await ensureCustomer(ctx, "o'brien");
    const search = fake.requests.find((r) => r.path === "/v1/customers/search");
    expect(search?.params.query).toBe("metadata['subject_id']:'o\\'brien'");
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
    fake.failNext((r) => r.method === "POST" && r.path === "/v1/customers", 500, 2);
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

describe("FakeStripe idempotency", () => {
  const isCreate = (r: { method: string; path: string }) => r.method === "POST" && r.path === "/v1/customers";

  test("a saved response is replayed even when a failNext matcher matches", async () => {
    const first = await ctx.stripe.customers.create({ metadata: { subject_id: "i1" } }, { idempotencyKey: "k1" });
    fake.failNext(isCreate, 500);
    const replay = await ctx.stripe.customers.create({ metadata: { subject_id: "i1" } }, { idempotencyKey: "k1" });
    expect(replay.id).toBe(first.id);
    // The failure was not spent on the replay: it still fails the next new request.
    await expect(ctx.stripe.customers.create({ metadata: {} }, { idempotencyKey: "k2" })).rejects.toThrow(/fake failure/);
  });

  test("failAndCache saves the failure under the key, so the same key replays it", async () => {
    fake.failAndCache(isCreate, 500);
    await expect(ctx.stripe.customers.create({ metadata: {} }, { idempotencyKey: "k3" })).rejects.toThrow(/fake failure/);
    // Nothing is armed any more, yet the same key still fails.
    await expect(ctx.stripe.customers.create({ metadata: {} }, { idempotencyKey: "k3" })).rejects.toThrow(/fake failure/);
    expect(fake.customers.size).toBe(0);
    // A new key is a new request.
    const ok = await ctx.stripe.customers.create({ metadata: {} }, { idempotencyKey: "k4" });
    expect(ok.id).toMatch(/^cus_/);
  });

  test("a plain failNext failure is not saved under the key", async () => {
    fake.failNext(isCreate, 500);
    await expect(ctx.stripe.customers.create({ metadata: {} }, { idempotencyKey: "k5" })).rejects.toThrow();
    const ok = await ctx.stripe.customers.create({ metadata: {} }, { idempotencyKey: "k5" });
    expect(ok.id).toMatch(/^cus_/);
  });
});

describe("assertSubjectId", () => {
  test.each(["\n", "\t", "\u0000", "a\nb", "ab\u007f", "a\u0085b"])("rejects control characters: %j", (id) => {
    expect(() => assertSubjectId(id)).toThrow(/subjectId/);
  });
  test.each(["12345", "org:acme", "o'brien"])("accepts %s", (id) => {
    expect(() => assertSubjectId(id)).not.toThrow();
  });
});
