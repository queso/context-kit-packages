import { eq } from "drizzle-orm";
import { billingSubscription } from "./schema/postgres.js";
import type { BillingConfig, BillingContext } from "./types.js";

export type SubscriptionRow = typeof billingSubscription.$inferSelect;

export type EntitlementReason =
  /** A paying subscription in good standing (active or trialing). */
  | "subscription"
  /** past_due, still inside the grace period. */
  | "grace"
  /** past_due and the grace period has ended: free limits apply. */
  | "grace_expired"
  /** unpaid, canceled, incomplete, incomplete_expired or paused. */
  | "inactive"
  /** A live subscription whose price is not a plan in the config. */
  | "unknown_plan"
  | "no_subscription";

export interface Entitlement {
  subjectId: string;
  /** The plan whose limits apply right now. */
  plan: string;
  includedUnits: number;
  /** True when a paid plan applies (including inside the grace period). */
  paid: boolean;
  reason: EntitlementReason;
  /** The subscription the answer is based on, if any. */
  subscription: {
    id: string;
    status: string;
    planKey: string | null;
    currentPeriodStart: Date | null;
    currentPeriodEnd: Date | null;
    cancelAt: Date | null;
    trialEnd: Date | null;
    /** For past_due: when the paid plan stops applying. */
    graceEndsAt: Date | null;
  } | null;
}

const DAY_MS = 86_400_000;
const GOOD_STANDING = new Set(["active", "trialing"]);

interface Candidate {
  row: SubscriptionRow;
  reason: EntitlementReason;
  plan: string | null;
  graceEndsAt: Date | null;
}

function evaluate(config: BillingConfig, row: SubscriptionRow, now: Date): Candidate {
  // Without a recorded start, the period start bounds the grace period. It does
  // not move on a re-sync, unlike syncedAt, which is the last resort so a
  // past_due row never gets unlimited grace.
  const graceStart = row.pastDueSince ?? row.currentPeriodStart ?? row.syncedAt;
  const graceEndsAt =
    row.status === "past_due" ? new Date(graceStart.getTime() + config.gracePeriodDays * DAY_MS) : null;
  const known = row.planKey !== null && row.planKey in config.plans;

  let reason: EntitlementReason;
  if (GOOD_STANDING.has(row.status)) reason = "subscription";
  else if (row.status === "past_due") {
    reason = graceEndsAt !== null && now < graceEndsAt ? "grace" : "grace_expired";
  } else reason = "inactive";

  if ((reason === "subscription" || reason === "grace") && !known) reason = "unknown_plan";
  const paid = reason === "subscription" || reason === "grace";
  return { row, reason, plan: paid ? row.planKey : null, graceEndsAt };
}

/**
 * Decides which plan's limits apply to a subject, from its stored subscription
 * rows. Pure, so it can be tested and reused without a database.
 *
 * It only answers what the limits are now. It never stops work already
 * running: an app gates new work on this answer and lets running work finish.
 */
export function resolveEntitlement(
  config: BillingConfig,
  subjectId: string,
  rows: SubscriptionRow[],
  now: Date
): Entitlement {
  const free = config.plans[config.freePlan]!;
  const candidates = rows.map((r) => evaluate(config, r, now));
  const paid = candidates
    .filter((c) => c.plan !== null)
    .sort(
      (a, b) =>
        config.plans[b.plan!]!.includedUnits - config.plans[a.plan!]!.includedUnits ||
        (b.row.currentPeriodEnd?.getTime() ?? 0) - (a.row.currentPeriodEnd?.getTime() ?? 0)
    );

  // With no paid candidate, report the most relevant unpaid one so the app can
  // say why (grace ended, canceled, unknown price).
  const order: EntitlementReason[] = ["unknown_plan", "grace_expired", "inactive"];
  const chosen =
    paid[0] ??
    [...candidates].sort(
      (a, b) =>
        order.indexOf(a.reason) - order.indexOf(b.reason) ||
        b.row.syncedAt.getTime() - a.row.syncedAt.getTime()
    )[0];

  if (!chosen) {
    return {
      subjectId,
      plan: config.freePlan,
      includedUnits: free.includedUnits,
      paid: false,
      reason: "no_subscription",
      subscription: null,
    };
  }

  const plan = chosen.plan ?? config.freePlan;
  return {
    subjectId,
    plan,
    includedUnits: config.plans[plan]!.includedUnits,
    paid: chosen.plan !== null,
    reason: chosen.reason,
    subscription: {
      id: chosen.row.stripeSubscriptionId,
      status: chosen.row.status,
      planKey: chosen.row.planKey,
      currentPeriodStart: chosen.row.currentPeriodStart,
      currentPeriodEnd: chosen.row.currentPeriodEnd,
      cancelAt: chosen.row.cancelAt,
      trialEnd: chosen.row.trialEnd,
      graceEndsAt: chosen.graceEndsAt,
    },
  };
}

/**
 * The plan-gating read: which plan applies to the subject now. Reads only the
 * local tables, never Stripe, so it is cheap enough to call on every request.
 */
export async function getEntitlement(ctx: BillingContext, subjectId: string): Promise<Entitlement> {
  const rows = await ctx.db
    .select()
    .from(billingSubscription)
    .where(eq(billingSubscription.subjectId, subjectId));
  return resolveEntitlement(ctx.config, subjectId, rows, ctx.now?.() ?? new Date());
}
