import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
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
  /** Transient failures (timeouts, 409, 429, 5xx, network) left pending for the next run. */
  retry: number;
  /** Rows Stripe rejected for their own data, or that can never be billed. */
  failed: number;
  late: number;
  needsReview: number;
  /** Rows left pending because the configuration needs fixing (see UsageReportingBlockedError). */
  blocked: number;
}

export type BlockedReason = "authentication" | "permission" | "meter" | "unexpected" | "unsupported_period";

/**
 * Thrown when usage cannot be reported because of something no single row can
 * fix: a rejected or under-permissioned key, a missing or archived meter, a
 * Stripe error the package does not recognise, or a subscription that does
 * not renew monthly. The affected rows stay pending and go out once the cause
 * is fixed; nothing is marked failed. Run the reporter from a job whose errors
 * page someone.
 */
export class UsageReportingBlockedError extends Error {
  constructor(
    readonly reason: BlockedReason,
    message: string,
    readonly summary: ReportSummary,
    readonly statusCode?: number,
    readonly stripeCode?: string
  ) {
    super(`usage reporting blocked (${reason}): ${message}`);
    this.name = "UsageReportingBlockedError";
  }
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

/**
 * How long a reporter holds a claimed row. stripe-node's request timeout is 30
 * seconds and createStripeClient allows 2 retries with backoff, so one send
 * takes at most about 95 seconds; five minutes leaves room. If a lease expires
 * mid-send anyway, the next reporter's resend carries the same identifier and
 * Stripe refuses it as a duplicate, which ends the row as sent.
 */
const LEASE_MS = 5 * 60_000;

/** Validation codes that mean Stripe rejected this row's own data; retrying can never succeed. */
const ROW_ERROR_CODES = new Set([
  "timestamp_too_far_in_past",
  "timestamp_in_future",
  "payload_invalid_value",
  "meter_event_invalid_value",
  "meter_event_value_not_found",
  "meter_event_customer_not_found",
  "payload_no_customer_defined",
  "meter_event_no_customer_defined",
]);

type StripeErrorLike = { statusCode?: number; code?: string; type?: string; message?: string; rawType?: string };

/**
 * Stripe already holds an event with this identifier, so the usage was
 * recorded by an earlier attempt whose response was lost.
 *
 * - v2 documents it: "400 duplicate_meter_event: A meter event with a duplicate
 *   identifier has already been submitted."
 *   (https://docs.stripe.com/api/v2/billing/meter-events/create)
 * - v1 (the endpoint used here) documents no synchronous error for it. In test
 *   mode it was observed to return an invalid_request_error with no code and
 *   the message "An event already exists with identifier <id>."
 *   (dlopez2392/bis-platform#146). The live suite asserts this on every run.
 *
 * The message form only counts when it names the identifier that was sent.
 */
export function isDuplicateIdentifierError(err: unknown, identifier: string): boolean {
  const e = err as StripeErrorLike;
  if (e?.statusCode !== 400) return false;
  if (e.code === "duplicate_meter_event") return true;
  const message = (e.message ?? "").trim().toLowerCase();
  const prefix = "an event already exists with identifier ";
  if (!message.startsWith(prefix)) return false;
  // Stripe may or may not end the message with a period, and the identifier
  // may itself end with one, so accept either form.
  const named = message.slice(prefix.length);
  const id = identifier.toLowerCase();
  return named === id || named === `${id}.`;
}

type Classified =
  | { kind: "duplicate" }
  | { kind: "transient" }
  | { kind: "row" }
  | { kind: "blocked"; reason: BlockedReason };

function classify(err: unknown, identifier: string): Classified {
  const e = err as StripeErrorLike;
  const status = e?.statusCode;
  if (typeof status !== "number") return { kind: "transient" }; // network error, no response
  if (status === 408 || status === 409 || status === 429 || status >= 500) return { kind: "transient" };
  if (isDuplicateIdentifierError(err, identifier)) return { kind: "duplicate" };
  if (status === 401) return { kind: "blocked", reason: "authentication" };
  if (status === 403) return { kind: "blocked", reason: "permission" };
  const message = e.message ?? "";
  if (e.code === "no_meter" || e.code === "archived_meter" || /\bmeter\b/i.test(message) && /(no|not found|must exist|archived|inactive|active)/i.test(message)) {
    return { kind: "blocked", reason: "meter" };
  }
  if (e.code && ROW_ERROR_CODES.has(e.code)) return { kind: "row" };
  return { kind: "blocked", reason: "unexpected" };
}

/** Removes anything key-shaped from a Stripe message before it is stored or thrown. */
function redact(message: string): string {
  return message.replace(/\b(sk|rk|pk)_(test|live)_[A-Za-z0-9*]+/g, "$1_$2_[redacted]").slice(0, 1000);
}

/**
 * One calendar month before `d`, with the day clamped to the length of that
 * month (March 31 gives February 28, not March 3) and the time of day kept.
 * For anchors on the 29th to 31st this is approximate by up to 3 days: a Jan 31
 * anchor renews Feb 28, and this gives Jan 28 as the previous boundary. The
 * exact boundary needs the subscription's anchor day, which is not stored. The
 * gap only matters for a row still unreported about a month after it was
 * written, which the 20-hour needs_review rule and Stripe's 35-day limit
 * already catch (rows are enqueued with the ledger write and sent within
 * minutes). Package Checkout anchors on day 1, where the clamp is exact.
 */
function previousMonthStart(d: Date): Date {
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() - 1;
  const daysInTarget = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(year, month, Math.min(d.getUTCDate(), daysInTarget), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds())
  );
}

/** Per-run lookup caches, so a batch of rows for one subject reads each table once. */
interface RunCache {
  customers: Map<string, { id: string } | undefined>;
  subscriptions: Map<string, SubscriptionRow[]>;
}

type SubscriptionRow = {
  start: Date | null;
  end: Date | null;
  status: string;
  overagePriceId: string | null;
  interval: string | null;
  intervalCount: number | null;
};

type Outcome =
  | { kind: "sent" | "retry" | "failed" | "late" | "needsReview" }
  | { kind: "blocked"; reason: BlockedReason; message: string; stopAll: boolean; statusCode?: number; stripeCode?: string };

async function reportOne(ctx: BillingContext, row: Row, leaseId: string, now: Date, cache: RunCache): Promise<Outcome> {
  const db = ctx.db;
  // Every write is fenced by the lease: if another reporter took the row over,
  // this one's late result is discarded.
  const finish = (set: Partial<Row>) =>
    db
      .update(billingUsageReport)
      .set({ ...set, leaseId: null, leaseExpiresAt: null })
      .where(and(eq(billingUsageReport.sourceId, row.sourceId), eq(billingUsageReport.leaseId, leaseId)));

  let customer: { id: string } | undefined;
  if (cache.customers.has(row.subjectId)) {
    customer = cache.customers.get(row.subjectId);
  } else {
    [customer] = await db
      .select({ id: billingCustomer.stripeCustomerId })
      .from(billingCustomer)
      .where(eq(billingCustomer.subjectId, row.subjectId));
    cache.customers.set(row.subjectId, customer);
  }
  if (!customer) {
    await finish({ status: "failed", lastError: "no_customer" });
    return { kind: "failed" };
  }

  if (row.firstAttemptAt && now.getTime() - row.firstAttemptAt.getTime() >= RESEND_WINDOW_MS) {
    await finish({ status: "needs_review", lastError: row.lastError ?? "unsent past the resend window" });
    return { kind: "needsReview" };
  }

  let subs = cache.subscriptions.get(row.subjectId);
  if (!subs) {
    subs = await db
    .select({
      start: billingSubscription.currentPeriodStart,
      end: billingSubscription.currentPeriodEnd,
      status: billingSubscription.status,
      overagePriceId: billingSubscription.overagePriceId,
      interval: billingSubscription.billingInterval,
      intervalCount: billingSubscription.billingIntervalCount,
    })
    .from(billingSubscription)
    .where(eq(billingSubscription.subjectId, row.subjectId))
    .orderBy(desc(billingSubscription.currentPeriodStart));
    cache.subscriptions.set(row.subjectId, subs);
  }
  const live = subs.find((s) => !ENDED_STATUSES.has(s.status));
  const sub = live ?? subs[0];
  if (!sub?.start) {
    // Usage written right after Checkout can arrive before the subscription is
    // synced. Wait; a row stuck this way reaches needs_review after the resend window.
    // Counts as an attempt so rows stuck here yield to newer rows in the claim order.
    await finish({ lastError: "no_subscription", attempts: row.attempts + 1, firstAttemptAt: row.firstAttemptAt ?? now });
    return { kind: "retry" };
  }
  if (!sub.overagePriceId) {
    await finish({ status: "failed", lastError: "no_overage_price" });
    return { kind: "failed" };
  }
  // The late-usage window below steps back one calendar month, which is only
  // right for monthly subscriptions. Anything else is refused loudly rather
  // than reported against a wrong window.
  if (sub.interval !== "month" || sub.intervalCount !== 1) {
    const message = `unsupported_period: subscription renews every ${sub.intervalCount ?? "?"} ${sub.interval ?? "unknown"}; the reporter supports monthly only`;
    // Specific to this subject's subscription, so it counts as an attempt:
    // otherwise a full batch of these rows is re-claimed every run and starves
    // newer billable rows. It does not start the resend clock (firstAttemptAt),
    // since nothing was sent.
    await finish({ lastError: message, attempts: row.attempts + 1 });
    return { kind: "blocked", reason: "unsupported_period", message, stopAll: false };
  }

  // `periodStart` is where the current period begins; the invoice for the period
  // before it keeps taking usage for invoiceGraceHours after it.
  let periodStart: Date;
  if (!live) {
    // An ended subscription bills its last period on a final invoice and nothing after it.
    const endedAt = sub.end ?? sub.start;
    if (row.occurredAt >= endedAt) {
      await finish({ status: "failed", lastError: "no_active_subscription" });
      return { kind: "failed" };
    }
    periodStart = endedAt;
  } else {
    // If the stored period has already ended (its renewal not synced yet), the
    // next period began at `end`.
    periodStart = sub.end && now >= sub.end ? sub.end : sub.start;
  }
  const graceMs = (ctx.config.invoiceGraceHours ?? 1) * HOUR_MS;
  const previousInvoiceOpen = now.getTime() < periodStart.getTime() + graceMs;
  const fromPreviousPeriod = row.occurredAt < periodStart;
  const olderThanPreviousPeriod = row.occurredAt < previousMonthStart(periodStart);
  const tooOldForStripe = now.getTime() - row.occurredAt.getTime() > STRIPE_MAX_EVENT_AGE_MS;
  if ((fromPreviousPeriod && !previousInvoiceOpen) || olderThanPreviousPeriod || tooOldForStripe) {
    // Stripe would accept it into meter summaries but never bill it, so it is
    // written off here where it is visible.
    await finish({ status: "late" });
    return { kind: "late" };
  }

  // Record the attempt before calling Stripe, so a crash mid-call still starts
  // the resend clock.
  const attempts = row.attempts + 1;
  const firstAttemptAt = row.firstAttemptAt ?? now;
  const recorded = await db
    .update(billingUsageReport)
    .set({ attempts, firstAttemptAt })
    .where(and(eq(billingUsageReport.sourceId, row.sourceId), eq(billingUsageReport.leaseId, leaseId)))
    .returning({ sourceId: billingUsageReport.sourceId });
  // No row updated means the lease was taken over: another reporter owns this
  // row, so do not send. A window remains: if the lease expires after this
  // check while Stripe is answering (a pause longer than the 5-minute lease),
  // the replacement reporter's resend is refused by Stripe as a duplicate
  // within its dedup window of at least 24 hours.
  if (recorded.length === 0) return { kind: "retry" };

  try {
    // A fresh idempotency key per attempt: Stripe replays a key's saved result,
    // including a 500, so one key would turn a single server error into a
    // permanent one. Duplicates across attempts are refused by `identifier`.
    await ctx.stripe.billing.meterEvents.create(buildMeterEventParams(row, customer.id), {
      idempotencyKey: `context-kit-billing:meter:${row.sourceId}:${attempts}`,
    });
  } catch (err) {
    const c = classify(err, row.sourceId);
    const e = err as StripeErrorLike;
    const message = redact(e?.message ?? String(err));
    if (c.kind === "duplicate") {
      await finish({ status: "sent", sentAt: now, lastError: null });
      return { kind: "sent" };
    }
    if (c.kind === "transient") {
      await finish({ lastError: message });
      return { kind: "retry" };
    }
    if (c.kind === "row") {
      await finish({ status: "failed", lastError: message });
      return { kind: "failed" };
    }
    // Stripe refused the request before doing anything, so this attempt does
    // not count toward the resend window.
    await finish({ attempts: row.attempts, firstAttemptAt: row.firstAttemptAt, lastError: `${c.reason}: ${message}` });
    return {
      kind: "blocked",
      reason: c.reason,
      message,
      stopAll: true,
      ...(e?.statusCode ? { statusCode: e.statusCode } : {}),
      ...(e?.code ? { stripeCode: e.code } : {}),
    };
  }
  await finish({ status: "sent", sentAt: now, lastError: null });
  return { kind: "sent" };
}

/**
 * Sends pending outbox rows to Stripe as meter events. Run it on a schedule
 * (every minute) or from `after()` once a usage record is written.
 *
 * Rows are claimed with a five-minute lease in one short statement
 * (`FOR UPDATE SKIP LOCKED` inside an UPDATE), and Stripe is called outside any
 * transaction, so no connection or row lock is held while Stripe answers.
 * Concurrent reporters claim disjoint rows. The meter event carries the row's
 * source id as its `identifier`, so a resend after a lost response is refused
 * by Stripe as a duplicate and the row ends as sent, not billed twice.
 *
 * Throws UsageReportingBlockedError when a configuration problem stops
 * reporting; the summary of what was done is on the error.
 */
export async function reportPendingUsage(
  ctx: BillingContext,
  options: { limit?: number } = {}
): Promise<ReportSummary> {
  const limit = options.limit ?? 100;
  const now = ctx.now?.() ?? new Date();
  const summary: ReportSummary = { sent: 0, retry: 0, failed: 0, late: 0, needsReview: 0, blocked: 0 };
  const leaseId = crypto.randomUUID();

  const claimable = ctx.db
    .select({ id: billingUsageReport.sourceId })
    .from(billingUsageReport)
    .where(
      and(
        eq(billingUsageReport.status, "pending"),
        or(isNull(billingUsageReport.leaseExpiresAt), lt(billingUsageReport.leaseExpiresAt, now))
      )
    )
    .orderBy(asc(billingUsageReport.attempts), asc(billingUsageReport.createdAt), asc(billingUsageReport.sourceId))
    .limit(limit)
    .for("update", { skipLocked: true });
  const claimed = await ctx.db
    .update(billingUsageReport)
    .set({ leaseId, leaseExpiresAt: new Date(now.getTime() + LEASE_MS) })
    .where(inArray(billingUsageReport.sourceId, claimable))
    .returning();
  claimed.sort(
    (a, b) => a.attempts - b.attempts || a.createdAt.getTime() - b.createdAt.getTime() || a.sourceId.localeCompare(b.sourceId)
  );
  const cache: RunCache = { customers: new Map(), subscriptions: new Map() };

  let firstBlock: Extract<Outcome, { kind: "blocked" }> | undefined;
  try {
    for (const row of claimed) {
      let outcome: Outcome;
      try {
        // The clock is read per row: a long batch can cross the grace window.
        outcome = await reportOne(ctx, row, leaseId, ctx.now?.() ?? new Date(), cache);
      } catch (err) {
        // A database error on one row must not stop the rows after it. The row
        // stays pending; if Stripe already took it, the resend is refused as a
        // duplicate and it ends as sent.
        const message = redact(err instanceof Error ? err.message : String(err));
        await ctx.db
          .update(billingUsageReport)
          .set({ lastError: message, attempts: sql`${billingUsageReport.attempts} + 1`, leaseId: null, leaseExpiresAt: null })
          .where(and(eq(billingUsageReport.sourceId, row.sourceId), eq(billingUsageReport.leaseId, leaseId)))
          .catch(() => {});
        summary.retry++;
        continue;
      }
      if (outcome.kind !== "blocked") {
        summary[outcome.kind]++;
        continue;
      }
      summary.blocked++;
      firstBlock ??= outcome;
      if (outcome.stopAll) break;
    }
  } finally {
    // Release whatever this run claimed but did not finish, so the next run can
    // take it without waiting for the lease to expire.
    await ctx.db
      .update(billingUsageReport)
      .set({ leaseId: null, leaseExpiresAt: null })
      .where(eq(billingUsageReport.leaseId, leaseId));
  }

  if (firstBlock) {
    throw new UsageReportingBlockedError(
      firstBlock.reason,
      firstBlock.message,
      summary,
      firstBlock.statusCode,
      firstBlock.stripeCode
    );
  }
  return summary;
}
