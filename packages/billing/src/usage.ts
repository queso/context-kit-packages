import { and, asc, desc, eq, notInArray, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { billingCustomer, billingSubscription, billingUsageReport } from "./schema/postgres.js";
import type { BillingContext } from "./types.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Stripe: "Must be within the past 35 calendar days". */
const STRIPE_MAX_EVENT_AGE_MS = 35 * DAY_MS;
/**
 * Stripe enforces identifier uniqueness "within a rolling period of at least 24
 * hours". A row unsent for this long since its first attempt is not resent
 * automatically, because a resend might no longer be deduplicated.
 */
const RESEND_WINDOW_MS = 20 * HOUR_MS;
/** Stripe's maximum `identifier` length. */
const MAX_SOURCE_ID_LENGTH = 100;
/** Statuses after which a subscription bills nothing new. */
const ENDED_STATUSES = new Set(["canceled", "incomplete_expired"]);

function assertNonNegativeInteger(name: string, n: number): void {
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got ${n}`);
}

/**
 * The part of one usage record that falls above the period's allowance.
 *
 * `usedBefore` is the subject's total for the period from records before this
 * one, in ledger order. Summed over a period's records in order, the results
 * equal `max(0, total - includedUnits)`, so each unit is billed once.
 */
export function computeOverage(input: { includedUnits: number; usedBefore: number; units: number }): number {
  assertNonNegativeInteger("includedUnits", input.includedUnits);
  assertNonNegativeInteger("usedBefore", input.usedBefore);
  assertNonNegativeInteger("units", input.units);
  const over = (n: number) => Math.max(0, n - input.includedUnits);
  return over(input.usedBefore + input.units) - over(input.usedBefore);
}

export interface UsageRecord {
  /** Unique id of the usage source, e.g. the ledger's run id. Becomes the meter event identifier. */
  sourceId: string;
  subjectId: string;
  /** Units to bill (the overage part, for the overage meter). A non-negative integer. */
  value: number;
  /** When the usage happened. Sent as the meter event timestamp, so it lands in the matching period. */
  occurredAt: Date;
}

export type EnqueueResult = "enqueued" | "skipped" | "duplicate" | "conflict";

/**
 * Adds a usage record to the outbox. Call it inside the same transaction that
 * writes the app's own usage record (pass `{ ...ctx, db: tx }`), so the two
 * commit or roll back together.
 *
 * - `enqueued`: a pending row was added.
 * - `skipped`: value 0, stored so the source still has exactly one row.
 * - `duplicate`: the source was already recorded with the same value.
 * - `conflict`: the source was recorded with a different value; the first row stands.
 */
export async function enqueueUsage(ctx: BillingContext, record: UsageRecord): Promise<EnqueueResult> {
  if (!record.sourceId || record.sourceId.length > MAX_SOURCE_ID_LENGTH) {
    throw new Error(`sourceId must be 1 to ${MAX_SOURCE_ID_LENGTH} characters`);
  }
  assertNonNegativeInteger("value", record.value);

  const status = record.value === 0 ? "skipped" : "pending";
  const inserted = await ctx.db
    .insert(billingUsageReport)
    .values({
      sourceId: record.sourceId,
      subjectId: record.subjectId,
      eventName: ctx.config.overage.meterEventName,
      value: record.value,
      occurredAt: record.occurredAt,
      status,
    })
    .onConflictDoNothing({ target: billingUsageReport.sourceId })
    .returning({ sourceId: billingUsageReport.sourceId });

  if (inserted.length > 0) return status === "skipped" ? "skipped" : "enqueued";

  const [existing] = await ctx.db
    .select({ value: billingUsageReport.value, subjectId: billingUsageReport.subjectId })
    .from(billingUsageReport)
    .where(eq(billingUsageReport.sourceId, record.sourceId));
  return existing?.value === record.value && existing.subjectId === record.subjectId
    ? "duplicate"
    : "conflict";
}

export interface ReportSummary {
  sent: number;
  /** Transient failures left pending for the next run. */
  retry: number;
  failed: number;
  late: number;
  needsReview: number;
}

type Row = typeof billingUsageReport.$inferSelect;

/** The meter event for one outbox row, separated out so its shape can be checked against stripe-mock. */
export function buildMeterEventParams(
  row: Pick<Row, "eventName" | "sourceId" | "occurredAt" | "value">,
  stripeCustomerId: string
): Stripe.Billing.MeterEventCreateParams {
  return {
    event_name: row.eventName,
    identifier: row.sourceId,
    timestamp: Math.floor(row.occurredAt.getTime() / 1000),
    payload: { stripe_customer_id: stripeCustomerId, value: String(row.value) },
  };
}
type Outcome = keyof ReportSummary;

function isPermanentStripeError(err: unknown): boolean {
  const status = (err as { statusCode?: number }).statusCode;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 409 && status !== 429;
}

async function reportOne(ctx: BillingContext, tx: BillingContext["db"], row: Row, now: Date): Promise<Outcome> {
  const finish = (set: Partial<Row>) =>
    tx.update(billingUsageReport).set(set).where(eq(billingUsageReport.sourceId, row.sourceId));

  const [customer] = await tx
    .select({ id: billingCustomer.stripeCustomerId })
    .from(billingCustomer)
    .where(eq(billingCustomer.subjectId, row.subjectId));
  if (!customer) {
    await finish({ status: "failed", lastError: "no_customer" });
    return "failed";
  }

  if (row.firstAttemptAt && now.getTime() - row.firstAttemptAt.getTime() >= RESEND_WINDOW_MS) {
    await finish({ status: "needs_review", lastError: row.lastError ?? "unsent past the resend window" });
    return "needsReview";
  }

  const subs = await tx
    .select({
      start: billingSubscription.currentPeriodStart,
      end: billingSubscription.currentPeriodEnd,
      status: billingSubscription.status,
      overagePriceId: billingSubscription.overagePriceId,
    })
    .from(billingSubscription)
    .where(eq(billingSubscription.subjectId, row.subjectId))
    .orderBy(desc(billingSubscription.currentPeriodStart));
  const live = subs.find((s) => !ENDED_STATUSES.has(s.status));
  const sub = live ?? subs[0];
  if (!sub?.start) {
    // Usage written right after Checkout can arrive before the subscription is
    // synced. Wait; a row stuck this way reaches needs_review after the resend window.
    await finish({ lastError: "no_subscription", firstAttemptAt: row.firstAttemptAt ?? now });
    return "retry";
  }
  if (!sub.overagePriceId) {
    await finish({ status: "failed", lastError: "no_overage_price" });
    return "failed";
  }

  // `periodStart` is where the current period begins; the invoice for the period
  // before it keeps taking usage for invoiceGraceHours after it.
  let periodStart: Date;
  if (!live) {
    // An ended subscription bills its last period on a final invoice and
    // nothing after it.
    const endedAt = sub.end ?? sub.start;
    if (row.occurredAt >= endedAt) {
      await finish({ status: "failed", lastError: "no_active_subscription" });
      return "failed";
    }
    periodStart = endedAt;
  } else {
    // If the stored period has already ended (its renewal not synced yet), the
    // next period began at `end`.
    periodStart = sub.end && now >= sub.end ? sub.end : sub.start;
  }
  const previousPeriodStart = new Date(
    Date.UTC(
      periodStart.getUTCFullYear(),
      periodStart.getUTCMonth() - 1,
      periodStart.getUTCDate(),
      periodStart.getUTCHours(),
      periodStart.getUTCMinutes(),
      periodStart.getUTCSeconds()
    )
  );
  const graceMs = (ctx.config.invoiceGraceHours ?? 1) * HOUR_MS;
  const previousInvoiceOpen = now.getTime() < periodStart.getTime() + graceMs;
  const fromPreviousPeriod = row.occurredAt < periodStart;
  const olderThanPreviousPeriod = row.occurredAt < previousPeriodStart;
  const tooOldForStripe = now.getTime() - row.occurredAt.getTime() > STRIPE_MAX_EVENT_AGE_MS;
  if ((fromPreviousPeriod && !previousInvoiceOpen) || olderThanPreviousPeriod || tooOldForStripe) {
    // Stripe would accept it into meter summaries but never bill it, so it is
    // written off here where it is visible.
    await finish({ status: "late" });
    return "late";
  }

  const attempt = {
    attempts: row.attempts + 1,
    firstAttemptAt: row.firstAttemptAt ?? now,
  };
  try {
    // A fresh idempotency key per attempt: Stripe replays a key's saved result,
    // including a 500, so one key would turn a single server error into a
    // permanent one. Duplicates across attempts are dropped by `identifier`.
    await ctx.stripe.billing.meterEvents.create(buildMeterEventParams(row, customer.id), {
      idempotencyKey: `context-kit-billing:meter:${row.sourceId}:${attempt.attempts}`,
    });
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
    if (isPermanentStripeError(err)) {
      await finish({ ...attempt, status: "failed", lastError: message });
      return "failed";
    }
    await finish({ ...attempt, lastError: message });
    return "retry";
  }
  await finish({ ...attempt, status: "sent", sentAt: now, lastError: null });
  return "sent";
}

/**
 * Sends pending outbox rows to Stripe as meter events. Run it on a schedule
 * (every minute) or from `after()` once a usage record is written.
 *
 * Each row is locked with `FOR UPDATE SKIP LOCKED` while it is sent, so
 * concurrent reporters never send the same row. The meter event carries the
 * row's source id as its `identifier`, so a retry after a lost response is
 * dropped by Stripe instead of billed twice.
 */
export async function reportPendingUsage(
  ctx: BillingContext,
  options: { limit?: number } = {}
): Promise<ReportSummary> {
  const limit = options.limit ?? 100;
  const summary: ReportSummary = { sent: 0, retry: 0, failed: 0, late: 0, needsReview: 0 };
  const seen: string[] = [];

  for (let i = 0; i < limit; i++) {
    const outcome = await ctx.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(billingUsageReport)
        .where(
          and(
            eq(billingUsageReport.status, "pending"),
            seen.length > 0 ? notInArray(billingUsageReport.sourceId, seen) : sql`true`
          )
        )
        .orderBy(asc(billingUsageReport.createdAt), asc(billingUsageReport.sourceId))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!row) return null;
      seen.push(row.sourceId);
      return reportOne(ctx, tx, row, ctx.now?.() ?? new Date());
    });
    if (outcome === null) break;
    summary[outcome]++;
  }
  return summary;
}
