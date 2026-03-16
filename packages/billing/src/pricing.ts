import type { PlanDefinition } from "./types";
import { BillingError } from "./types";

export function resolvePriceId(
  plan: PlanDefinition,
  interval?: string
): string {
  if (interval && plan.stripePriceIds) {
    const key = interval as keyof typeof plan.stripePriceIds;
    const priceId = plan.stripePriceIds[key];
    if (priceId) return priceId;
    throw new BillingError(
      `Plan "${plan.id}" has no price for interval "${interval}".`
    );
  }

  if (plan.stripePriceId) return plan.stripePriceId;

  if (plan.stripePriceIds) {
    const key = "monthly" as keyof typeof plan.stripePriceIds;
    const priceId = plan.stripePriceIds[key];
    if (priceId) return priceId;
    throw new BillingError(
      `Plan "${plan.id}" has no price for interval "monthly".`
    );
  }

  throw new BillingError(`Plan "${plan.id}" has no Stripe price configured.`);
}
