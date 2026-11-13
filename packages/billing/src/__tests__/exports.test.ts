import { describe, test, expect, beforeEach } from "bun:test";
import * as pkg from "../index";
import { createTestDb } from "./helpers/db";
import { FakeStripe } from "./helpers/fake-stripe";
import { testConfig } from "./helpers/config";

describe("package entry point", () => {
  test("exports the public API", () => {
    for (const name of [
      "createBilling",
      "createStripeClient",
      "STRIPE_API_VERSION",
      "validateConfig",
      "computeOverage",
      "resolveEntitlement",
      "bootstrapCatalog",
      "nextMonthStartUtc",
      "AlreadySubscribedError",
      "UsageReportingBlockedError",
      "isDuplicateIdentifierError",
    ]) {
      expect(pkg).toHaveProperty(name);
    }
  });

  test("does not export the tables; they come from ./schema/postgres", () => {
    expect(pkg).not.toHaveProperty("billingCustomer");
  });
});

describe("createBilling", () => {
  let fake: FakeStripe;
  beforeEach(() => {
    fake = new FakeStripe();
  });

  test("validates the config up front", async () => {
    const { db } = await createTestDb();
    expect(() => pkg.createBilling({ db, stripe: fake.client(), config: { ...testConfig, freePlan: "x" } })).toThrow(
      /freePlan/
    );
  });

  test("needs a stripe client or a secret key", async () => {
    const { db } = await createTestDb();
    expect(() => pkg.createBilling({ db, config: testConfig } as never)).toThrow(/stripe/);
  });

  test("builds a client from a secret key", async () => {
    const { db } = await createTestDb();
    const billing = pkg.createBilling({ db, secretKey: "rk_test_123", config: testConfig });
    expect(billing.stripe).toBeDefined();
  });

  test("binds every operation to the same context", async () => {
    const { db } = await createTestDb();
    const billing = pkg.createBilling({ db, stripe: fake.client(), config: testConfig });
    const customer = await billing.ensureCustomer("123");
    expect(customer).toMatch(/^cus_/);
    expect((await billing.getEntitlement("123")).plan).toBe("free");
    expect(billing.webhookHandler).toBeUndefined();
  });

  test("exposes a webhook handler when a signing secret is given", async () => {
    const { db } = await createTestDb();
    const billing = pkg.createBilling({ db, stripe: fake.client(), config: testConfig, webhookSecret: "whsec_x" });
    const res = await billing.webhookHandler!(new Request("https://app.test/x", { method: "POST", body: "{}" }));
    expect(res.status).toBe(400);
  });
});
