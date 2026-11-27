import type { BillingConfig, PlanDefinition } from "./types.js";

function isNonNegativeInteger(n: number): boolean {
  return Number.isInteger(n) && n >= 0;
}

/**
 * Checks a billing config once at startup. Throws with the offending key so a
 * typo in a plan table fails the deploy rather than a customer's checkout.
 */
export function validateConfig(config: BillingConfig): BillingConfig {
  const plans = Object.entries(config.plans);
  if (!(config.freePlan in config.plans)) {
    throw new Error(`billing config: freePlan "${config.freePlan}" is not one of plans`);
  }

  const lookupKeys = new Map<string, string>();
  lookupKeys.set(config.overage.priceLookupKey, "overage");

  for (const [key, plan] of plans) {
    if (!isNonNegativeInteger(plan.includedUnits)) {
      throw new Error(`billing config: plans.${key}.includedUnits must be a non-negative integer`);
    }
    if (key === config.freePlan) {
      if (plan.priceLookupKey !== undefined) {
        throw new Error(`billing config: the free plan "${key}" must not have a priceLookupKey`);
      }
      continue;
    }
    if (!plan.priceLookupKey) {
      throw new Error(`billing config: paid plan "${key}" needs a priceLookupKey`);
    }
    const clash = lookupKeys.get(plan.priceLookupKey);
    if (clash) {
      throw new Error(
        `billing config: lookup key "${plan.priceLookupKey}" is used by both "${clash}" and "${key}"`
      );
    }
    lookupKeys.set(plan.priceLookupKey, key);
  }

  if (!isNonNegativeInteger(config.gracePeriodDays)) {
    throw new Error("billing config: gracePeriodDays must be a non-negative integer");
  }
  const graceHours = config.invoiceGraceHours ?? 1;
  if (!isNonNegativeInteger(graceHours) || graceHours > 72) {
    throw new Error("billing config: invoiceGraceHours must be an integer from 0 to 72");
  }
  return config;
}

/** The plan key whose `priceLookupKey` matches, or undefined. */
export function planForLookupKey(
  config: BillingConfig,
  lookupKey: string | null | undefined
): string | undefined {
  if (!lookupKey) return undefined;
  return Object.entries(config.plans).find(
    ([, plan]: [string, PlanDefinition]) => plan.priceLookupKey === lookupKey
  )?.[0];
}
