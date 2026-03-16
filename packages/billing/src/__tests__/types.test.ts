import { describe, expect, test } from "bun:test";
import type {
  BillingConfig,
  BillingInstance,
  ChangePlanParams,
  CheckoutSessionParams,
  FreeTierConfig,
  PlanDefinition,
  SubscriptionData,
  SubscriptionStatus,
  UsageResult,
} from "../types";
import {
  BillingError,
  InvalidConfigError,
  SubscriptionStateError,
  UsageCapExceededError,
  WebhookVerificationError,
} from "../types";

describe("billing error classes", () => {
  test("BillingError is a proper Error subclass", () => {
    const err = new BillingError("base error");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(BillingError);
    expect(err.message).toBe("base error");
    expect(err.name).toBe("BillingError");
  });

  test("error subclasses are instances of BillingError and Error", () => {
    const usageErr = new UsageCapExceededError("usage exceeded", {
      used: 10,
      limit: 5,
    });
    const configErr = new InvalidConfigError("bad config");
    const webhookErr = new WebhookVerificationError("bad signature");
    const stateErr = new SubscriptionStateError("wrong state");

    expect(usageErr).toBeInstanceOf(BillingError);
    expect(usageErr).toBeInstanceOf(Error);
    expect(configErr).toBeInstanceOf(BillingError);
    expect(webhookErr).toBeInstanceOf(BillingError);
    expect(stateErr).toBeInstanceOf(BillingError);
  });

  test("UsageCapExceededError carries used and limit fields", () => {
    const err = new UsageCapExceededError("cap exceeded", {
      used: 100,
      limit: 50,
    });
    expect(err.used).toBe(100);
    expect(err.limit).toBe(50);
    expect(err.name).toBe("UsageCapExceededError");
  });
});

describe("BillingInstance interface shape", () => {
  test("mock object satisfying BillingInstance has all expected methods", () => {
    // This verifies the interface has the expected method surface at runtime
    const mockBilling: BillingInstance = {
      getSubscription: async (_userId: string) => ({}) as SubscriptionData,
      getPlan: (_planId: string) => ({}) as PlanDefinition,
      checkUsage: async (_userId: string, _metric: string) =>
        ({}) as UsageResult,
      recordUsage: async (
        _userId: string,
        _metric: string,
        _amount: number
      ) => {},
      createCheckoutSession: async (_params: CheckoutSessionParams) => ({
        url: "https://checkout.stripe.com/session",
      }),
      changePlan: async (_userId: string, _params: ChangePlanParams) => {},
      cancelSubscription: async (
        _userId: string,
        _params?: { immediate?: boolean }
      ) => {},
      reactivateSubscription: async (_userId: string) => {},
    };

    const methods = [
      "getSubscription",
      "getPlan",
      "checkUsage",
      "recordUsage",
      "createCheckoutSession",
      "changePlan",
      "cancelSubscription",
      "reactivateSubscription",
    ];

    for (const method of methods) {
      expect(typeof mockBilling[method as keyof BillingInstance]).toBe(
        "function"
      );
    }
  });
});

// Type-level compile checks — these never run but ensure the type shapes are valid
// If the types.ts file has wrong shapes, TypeScript compilation of this test file will fail.
declare const _config: BillingConfig;
declare const _plan: PlanDefinition;
declare const _freeTier: FreeTierConfig;
declare const _subscription: SubscriptionData;
declare const _status: SubscriptionStatus;
declare const _usage: UsageResult;
declare const _checkout: CheckoutSessionParams;
declare const _change: ChangePlanParams;

// Ensure SubscriptionStatus is a union of the expected string literals
const _validStatus: SubscriptionStatus = "active";
const _validStatus2: SubscriptionStatus = "past_due";
const _validStatus3: SubscriptionStatus = "canceled";
