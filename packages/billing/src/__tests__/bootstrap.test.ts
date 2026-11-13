import { describe, test, expect, beforeEach } from "bun:test";
import { bootstrapCatalog, type Catalog } from "../bootstrap";
import { FakeStripe } from "./helpers/fake-stripe";
import { testConfig } from "./helpers/config";

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
});
