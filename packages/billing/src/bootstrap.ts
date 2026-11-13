import type Stripe from "stripe";
import type { BillingConfig } from "./types.js";

/** Amounts and names for the Stripe catalog. Amounts are in the currency's smallest unit (cents). */
export interface Catalog {
  currency: string;
  /** One entry per paid plan in the config. */
  plans: Record<string, { productName: string; unitAmount: number }>;
  overage: { productName: string; unitAmount: number; meterDisplayName: string };
}

export interface BootstrapResult {
  meterId: string;
  /** Price id per paid plan key, plus `overage`. */
  prices: Record<string, string>;
  /** What this run created, for logging. Empty on a re-run. */
  created: string[];
}

function assertAmount(name: string, n: number) {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name}.unitAmount must be a positive integer`);
}

/**
 * Creates the Billing Meter, products and prices the config refers to, in a
 * sandbox or live mode, if they do not exist yet. Everything is found by
 * lookup key (prices) or event name (meter), so re-running it creates nothing.
 *
 * Prices are created without `tax_behavior`, so they follow the account's
 * default tax behavior and Stripe Tax can be turned on later without replacing
 * them. Every plan price carries `metadata.plan_key`, which keeps it
 * recognisable after a newer price takes over its lookup key.
 */
export async function bootstrapCatalog(
  stripe: Stripe,
  config: BillingConfig,
  catalog: Catalog
): Promise<BootstrapResult> {
  const paid = Object.entries(config.plans).filter(([key]) => key !== config.freePlan);
  for (const [key] of paid) {
    const entry = catalog.plans[key];
    if (!entry) throw new Error(`catalog.plans has no entry for paid plan "${key}"`);
    assertAmount(`catalog.plans.${key}`, entry.unitAmount);
  }
  assertAmount("catalog.overage", catalog.overage.unitAmount);

  const created: string[] = [];

  let meter: Stripe.Billing.Meter | undefined;
  for await (const m of stripe.billing.meters.list({ status: "active", limit: 100 })) {
    if (m.event_name === config.overage.meterEventName) {
      meter = m;
      break;
    }
  }
  if (!meter) {
    meter = await stripe.billing.meters.create({
      display_name: catalog.overage.meterDisplayName,
      event_name: config.overage.meterEventName,
      default_aggregation: { formula: "sum" },
      customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" },
      value_settings: { event_payload_key: "value" },
    });
    created.push(`meter ${meter.id}`);
  }

  const lookupKeys = [...paid.map(([, p]) => p.priceLookupKey!), config.overage.priceLookupKey];
  const existing = await stripe.prices.list({ lookup_keys: lookupKeys, active: true, limit: 10 });
  const byKey = new Map(existing.data.map((p) => [p.lookup_key, p.id]));
  const prices: Record<string, string> = {};

  for (const [key, plan] of paid) {
    const lookupKey = plan.priceLookupKey!;
    const found = byKey.get(lookupKey);
    if (found) {
      prices[key] = found;
      continue;
    }
    const product = await stripe.products.create({ name: catalog.plans[key]!.productName, metadata: { plan_key: key } });
    const price = await stripe.prices.create({
      product: product.id,
      currency: catalog.currency,
      unit_amount: catalog.plans[key]!.unitAmount,
      recurring: { interval: "month", usage_type: "licensed" },
      lookup_key: lookupKey,
      metadata: { plan_key: key },
    });
    created.push(`product ${product.id}`, `price ${price.id} (${lookupKey})`);
    prices[key] = price.id;
  }

  const overageFound = byKey.get(config.overage.priceLookupKey);
  if (overageFound) {
    prices.overage = overageFound;
  } else {
    const product = await stripe.products.create({ name: catalog.overage.productName });
    const price = await stripe.prices.create({
      product: product.id,
      currency: catalog.currency,
      unit_amount: catalog.overage.unitAmount,
      recurring: { interval: "month", usage_type: "metered", meter: meter.id },
      lookup_key: config.overage.priceLookupKey,
    });
    created.push(`product ${product.id}`, `price ${price.id} (${config.overage.priceLookupKey})`);
    prices.overage = price.id;
  }

  return { meterId: meter.id, prices, created };
}
