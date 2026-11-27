import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type Stripe from "stripe";

/**
 * Any Drizzle Postgres database: postgres-js, node-postgres, PGlite, Neon.
 * The billing tables must be part of the app's schema (see `./schema/postgres`).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BillingDb = PgDatabase<PgQueryResultHKT, any>;

export interface PlanDefinition {
  /** Credits (or other units) included each billing period. A non-negative integer. */
  includedUnits: number;
  /**
   * Lookup key of the plan's monthly licensed Stripe price. Omitted for the free
   * plan, which has no Stripe price.
   */
  priceLookupKey?: string;
}

export interface BillingConfig {
  /** Every plan the app offers, keyed by the app's own plan key. */
  plans: Record<string, PlanDefinition>;
  /** Key of the plan a subject is on without a paying subscription. */
  freePlan: string;
  overage: {
    /** Lookup key of the metered per-unit price that bills usage above the allowance. */
    priceLookupKey: string;
    /** `event_name` of the Stripe Billing Meter the overage price uses. */
    meterEventName: string;
  };
  /** Days a `past_due` subscription keeps its paid plan, counted from the unpaid invoice's finalization. */
  gracePeriodDays: number;
  /**
   * The Stripe account's invoice finalization grace period, in hours. Usage older
   * than the current period start minus this window can no longer reach an
   * invoice. Stripe's default is 1 hour; the maximum is 72.
   */
  invoiceGraceHours?: number;
  /** Turn on Stripe Tax in Checkout. Off by default; see the README before enabling. */
  automaticTax?: boolean;
}

export interface BillingContext {
  db: BillingDb;
  stripe: Stripe;
  config: BillingConfig;
  /** Injected clock for tests. Defaults to `() => new Date()`. */
  now?: () => Date;
}
