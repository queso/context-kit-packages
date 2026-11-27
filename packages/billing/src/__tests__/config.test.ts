import { describe, test, expect } from "bun:test";
import { validateConfig } from "../config";
import { testConfig } from "./helpers/config";

describe("validateConfig", () => {
  test("accepts the OKtoMerge-shaped config", () => {
    expect(() => validateConfig(testConfig)).not.toThrow();
  });

  test("rejects a free plan that is not in plans", () => {
    expect(() => validateConfig({ ...testConfig, freePlan: "nope" })).toThrow(/freePlan/);
  });

  test("rejects a free plan with a Stripe price", () => {
    expect(() =>
      validateConfig({
        ...testConfig,
        plans: { ...testConfig.plans, free: { includedUnits: 50, priceLookupKey: "x" } },
      })
    ).toThrow(/free plan/i);
  });

  test("rejects a paid plan without a price lookup key", () => {
    expect(() =>
      validateConfig({ ...testConfig, plans: { ...testConfig.plans, pro: { includedUnits: 250 } } })
    ).toThrow(/pro/);
  });

  test("rejects two plans sharing a lookup key", () => {
    expect(() =>
      validateConfig({
        ...testConfig,
        plans: {
          ...testConfig.plans,
          team: { includedUnits: 750, priceLookupKey: testConfig.plans.pro!.priceLookupKey },
        },
      })
    ).toThrow(/lookup key/i);
  });

  test("rejects a plan lookup key equal to the overage lookup key", () => {
    expect(() =>
      validateConfig({
        ...testConfig,
        plans: {
          ...testConfig.plans,
          pro: { includedUnits: 250, priceLookupKey: testConfig.overage.priceLookupKey },
        },
      })
    ).toThrow(/lookup key/i);
  });

  test.each([-1, 2.5, Number.NaN])("rejects includedUnits %p", (bad) => {
    expect(() =>
      validateConfig({ ...testConfig, plans: { ...testConfig.plans, free: { includedUnits: bad } } })
    ).toThrow(/includedUnits/);
  });

  test.each([-1, 1.5])("rejects gracePeriodDays %p", (bad) => {
    expect(() => validateConfig({ ...testConfig, gracePeriodDays: bad })).toThrow(/gracePeriodDays/);
  });

  test.each([-1, 73])("rejects invoiceGraceHours %p (Stripe allows 0 to 72)", (bad) => {
    expect(() => validateConfig({ ...testConfig, invoiceGraceHours: bad })).toThrow(
      /invoiceGraceHours/
    );
  });
});
