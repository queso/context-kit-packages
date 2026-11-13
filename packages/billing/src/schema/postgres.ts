/**
 * Drizzle schema for PostgreSQL (postgres-js, node-postgres, PGlite, ...).
 *
 * Consumers re-export these tables from their own schema so Drizzle Kit
 * picks them up:
 *
 * ```ts
 * // db/schema.ts
 * export * from "@context-kit/billing/schema/postgres";
 * ```
 *
 * Then run `bun run db:generate` to emit the migration. The app owns the
 * migration history, so a package upgrade that changes a table surfaces as a
 * generated migration.
 *
 * Ids from Stripe and the app's subject id are `text`. Times are `timestamptz`
 * because billing periods are compared across time zones.
 */

import { pgTable, text, timestamp, boolean, bigint, integer, index } from "drizzle-orm/pg-core";

const tz = { withTimezone: true } as const;

/** One row per billing subject (the thing that pays), mapped to one Stripe Customer. */
export const billingCustomer = pgTable("billing_customer", {
  subjectId: text("subject_id").primaryKey(),
  stripeCustomerId: text("stripe_customer_id").notNull().unique(),
  livemode: boolean("livemode").notNull(),
  createdAt: timestamp("created_at", tz).defaultNow().notNull(),
});

/**
 * The last state of each Stripe subscription, as fetched from the API. Rows are
 * replaced wholesale on every sync, never patched from webhook payloads.
 */
export const billingSubscription = pgTable(
  "billing_subscription",
  {
    stripeSubscriptionId: text("stripe_subscription_id").primaryKey(),
    subjectId: text("subject_id").notNull(),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    status: text("status").notNull(),
    /** Plan key from the app's config, or null when the base price is not a known plan. */
    planKey: text("plan_key"),
    basePriceId: text("base_price_id"),
    overagePriceId: text("overage_price_id"),
    currentPeriodStart: timestamp("current_period_start", tz),
    currentPeriodEnd: timestamp("current_period_end", tz),
    cancelAt: timestamp("cancel_at", tz),
    trialEnd: timestamp("trial_end", tz),
    /** When the unpaid invoice was finalized; the grace period counts from here. */
    pastDueSince: timestamp("past_due_since", tz),
    livemode: boolean("livemode").notNull(),
    syncedAt: timestamp("synced_at", tz).notNull(),
  },
  (table) => [index("billing_subscription_subject_idx").on(table.subjectId)]
);

/** Every Stripe event delivered to the webhook, so repeats are recognised. */
export const billingWebhookEvent = pgTable("billing_webhook_event", {
  stripeEventId: text("stripe_event_id").primaryKey(),
  type: text("type").notNull(),
  objectId: text("object_id"),
  receivedAt: timestamp("received_at", tz).defaultNow().notNull(),
  processedAt: timestamp("processed_at", tz),
  lastError: text("last_error"),
});

/**
 * Meter-event outbox. One row per usage source (for OKtoMerge, one ledger run),
 * so a source is reported to Stripe at most once.
 *
 * status: pending, sent, skipped (value 0), late (its invoice was already
 * finalized), needs_review (still unsent after Stripe's dedup window may have
 * passed), failed (rejected by Stripe or no customer).
 */
export const billingUsageReport = pgTable(
  "billing_usage_report",
  {
    sourceId: text("source_id").primaryKey(),
    subjectId: text("subject_id").notNull(),
    eventName: text("event_name").notNull(),
    value: bigint("value", { mode: "number" }).notNull(),
    occurredAt: timestamp("occurred_at", tz).notNull(),
    status: text("status").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    firstAttemptAt: timestamp("first_attempt_at", tz),
    lastError: text("last_error"),
    sentAt: timestamp("sent_at", tz),
    createdAt: timestamp("created_at", tz).defaultNow().notNull(),
  },
  (table) => [index("billing_usage_report_status_idx").on(table.status, table.createdAt)]
);
