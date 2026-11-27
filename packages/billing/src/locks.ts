import { sql } from "drizzle-orm";
import type { BillingDb } from "./types.js";

/** First key of the two-key advisory lock, so billing locks cannot collide with an app's own ("bill"). */
export const LOCK_NAMESPACE = 0x62696c6c;

/**
 * Takes a transaction-scoped advisory lock on `key` within billing's namespace.
 * Keys must not change between releases: a deployed and an upgraded process
 * have to lock the same key. Current keys are "checkout:<subject>",
 * "customer:<subject>" and the Stripe subscription id.
 */
export async function billingLock(tx: Pick<BillingDb, "execute">, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_NAMESPACE}, hashtext(${key}))`);
}
