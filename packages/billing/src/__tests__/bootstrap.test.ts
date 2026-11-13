import { describe, test, expect, beforeEach } from "bun:test";
import { bootstrapCatalog, type Catalog } from "../bootstrap";
import { FakeStripe } from "./helpers/fake-stripe";
import { testConfig } from "./helpers/config";
import type { BillingConfig } from "../types";

const catalog: Catalog = {
  currency: "usd",
  plans: {
    pro: { productName: "Test Pro", unitAmount: 2900 },
    team: { productName: "Test Team", unitAmount: 7900 },
    fleet: { productName: "Test Fleet", unitAmount: 19900 },
  },
  overage: { productName: "Test credits", unitAmount: 12, meterDisplayName: "Test credits" },
};

let fake: FakeStripe;
beforeEach(() => {
  fake = new FakeStripe();
});

const posts = (path: string) => fake.requests.filter((r) => r.method === "POST" && r.path === path);

describe("bootstrapCatalog", () => {
  test("creates the meter, one product and price per paid plan, and the metered overage price", async () => {
    const result = await bootstrapCatalog(fake.client(), testConfig, catalog);

    const [meter] = posts("/v1/billing/meters");
    expect(meter?.params).toEqual({
      display_name: "Test credits",
      event_name: "test_credits",
      default_aggregation: { formula: "sum" },
      customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" },
      value_settings: { event_payload_key: "value" },
    });

    const prices = posts("/v1/prices");
    expect(prices).toHaveLength(4);
    const pro = prices.find((p) => p.params.lookup_key === "test_pro_monthly");
    expect(pro?.params).toMatchObject({
      currency: "usd",
      unit_amount: "2900",
      recurring: { interval: "month", usage_type: "licensed" },
      metadata: { plan_key: "pro" },
    });
    // tax_behavior stays unset so Stripe Tax can be turned on later without new prices.
    expect(pro?.params).not.toHaveProperty("tax_behavior");

    const over = prices.find((p) => p.params.lookup_key === "test_credit_overage");
    expect(over?.params).toMatchObject({
      unit_amount: "12",
      recurring: { interval: "month", usage_type: "metered", meter: result.meterId },
    });

    expect(Object.keys(result.prices).sort()).toEqual(["fleet", "overage", "pro", "team"]);
    // The meter, then a product and a price for each of the three plans and the overage.
    expect(result.created).toHaveLength(9);
  });

  test("a second run finds everything by lookup key and creates nothing", async () => {
    const client = fake.client();
    const first = await bootstrapCatalog(client, testConfig, catalog);
    const before = fake.requests.filter((r) => r.method === "POST").length;

    const second = await bootstrapCatalog(client, testConfig, catalog);

    expect(fake.requests.filter((r) => r.method === "POST").length).toBe(before);
    expect(second.prices).toEqual(first.prices);
    expect(second.meterId).toBe(first.meterId);
    expect(second.created).toEqual([]);
  });

  test("refuses a catalog that does not cover every paid plan", async () => {
    const { fleet: _drop, ...plans } = catalog.plans;
    await expect(bootstrapCatalog(fake.client(), testConfig, { ...catalog, plans })).rejects.toThrow(/fleet/);
    expect(fake.requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  test.each([0, -1, 1.5])("refuses unit amount %p", async (bad) => {
    await expect(
      bootstrapCatalog(fake.client(), testConfig, { ...catalog, plans: { ...catalog.plans, pro: { productName: "x", unitAmount: bad } } })
    ).rejects.toThrow(/unitAmount/);
  });

  test("create calls carry idempotency keys, so two runs racing get the same objects", async () => {
    await bootstrapCatalog(fake.client(), testConfig, catalog);
    const keys = fake.requests.filter((r) => r.method === "POST").map((r) => `${r.path} ${r.idempotencyKey}`);
    expect(keys).toContain("/v1/billing/meters context-kit-billing:meter:test_credits");
    expect(keys).toContain("/v1/products context-kit-billing:product:test_pro_monthly");
    expect(keys).toContain("/v1/prices context-kit-billing:price:test_pro_monthly");
    expect(keys).toContain("/v1/prices context-kit-billing:price:test_credit_overage");

    const racing = new FakeStripe();
    const client = racing.client();
    const [a, b] = await Promise.all([
      bootstrapCatalog(client, testConfig, catalog),
      bootstrapCatalog(client, testConfig, catalog),
    ]);
    expect(a.prices).toEqual(b.prices);
    expect(racing.meters.size).toBe(1);
  });

  test("an inactive meter with the event name fails with a clear error instead of a duplicate create", async () => {
    fake.meters.set("mtr_old", { id: "mtr_old", object: "billing.meter", event_name: "test_credits", status: "inactive" });
    await expect(bootstrapCatalog(fake.client(), testConfig, catalog)).rejects.toThrow(/mtr_old.*inactive/);
    expect(fake.requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  test("a lookup key matching two active prices fails loudly instead of picking one", async () => {
    fake.addPrice({ id: "price_a", lookupKey: "test_pro_monthly" });
    fake.addPrice({ id: "price_b", lookupKey: "test_pro_monthly" });
    await expect(bootstrapCatalog(fake.client(), testConfig, catalog)).rejects.toThrow(/test_pro_monthly.*price_a.*price_b|test_pro_monthly.*price_b.*price_a/);
  });

  const goodMeter = {
    id: "mtr_old",
    object: "billing.meter",
    event_name: "test_credits",
    status: "active",
    default_aggregation: { formula: "sum" },
    customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" },
    value_settings: { event_payload_key: "value" },
    event_time_window: null,
  };

  test("reuses an existing meter whose settings are correct", async () => {
    fake.meters.set("mtr_old", { ...goodMeter });
    const result = await bootstrapCatalog(fake.client(), testConfig, catalog);
    expect(result.meterId).toBe("mtr_old");
    expect(posts("/v1/billing/meters")).toHaveLength(0);
  });

  test.each([
    ["aggregates with count", { default_aggregation: { formula: "count" } }, /mtr_old.*default_aggregation/],
    ["aggregates with last", { default_aggregation: { formula: "last" } }, /mtr_old.*default_aggregation/],
    ["maps customers by another type", { customer_mapping: { type: "by_name", event_payload_key: "stripe_customer_id" } }, /mtr_old.*customer_mapping/],
    ["reads the customer from another key", { customer_mapping: { type: "by_id", event_payload_key: "customer" } }, /mtr_old.*customer_mapping/],
    ["reads the value from another key", { value_settings: { event_payload_key: "amount" } }, /mtr_old.*value_settings/],
    ["is pre-aggregated", { event_time_window: "day" }, /mtr_old.*event_time_window/],
  ])("an existing meter that %s is refused before anything is created", async (_name, override, message) => {
    fake.meters.set("mtr_old", { ...goodMeter, ...override });
    await expect(bootstrapCatalog(fake.client(), testConfig, catalog)).rejects.toThrow(message);
    expect(fake.requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  test("more than 10 paid plans bootstrap, and each price lookup sends at most 10 lookup keys", async () => {
    const plans: BillingConfig["plans"] = { free: { includedUnits: 1 } };
    const catalogPlans: Catalog["plans"] = {};
    for (let i = 0; i < 11; i++) {
      plans[`p${i}`] = { includedUnits: 10, priceLookupKey: `many_p${i}` };
      catalogPlans[`p${i}`] = { productName: `P${i}`, unitAmount: 100 + i };
    }
    const config: BillingConfig = { ...testConfig, plans };
    const client = fake.client();

    const first = await bootstrapCatalog(client, config, { ...catalog, plans: catalogPlans });
    expect(Object.keys(first.prices)).toHaveLength(12);
    // A second run must find all 12 through the chunked lookups and create nothing.
    const before = fake.requests.filter((r) => r.method === "POST").length;
    const second = await bootstrapCatalog(client, config, { ...catalog, plans: catalogPlans });
    expect(second.created).toEqual([]);
    expect(second.prices).toEqual(first.prices);
    expect(fake.requests.filter((r) => r.method === "POST").length).toBe(before);

    const lists = fake.requests.filter((r) => r.method === "GET" && r.path === "/v1/prices");
    expect(lists.length).toBeGreaterThan(2);
    for (const l of lists) expect((l.params.lookup_keys as string[]).length).toBeLessThanOrEqual(10);
  });

  test("an existing overage price on a different meter fails naming both meters", async () => {
    fake.meters.set("mtr_old", { ...goodMeter });
    fake.addPrice({ id: "price_over", lookupKey: "test_credit_overage", usageType: "metered" });
    (fake.prices.get("price_over")!.recurring as Record<string, unknown>).meter = "mtr_other";
    const err = await bootstrapCatalog(fake.client(), testConfig, catalog).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/price_over/);
    expect((err as Error).message).toMatch(/mtr_other/);
    expect((err as Error).message).toMatch(/mtr_old/);
    expect(fake.requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });
});
