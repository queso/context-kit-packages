import { beforeEach, afterEach } from "bun:test";
import { createClient } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "../schema/sqlite";
import type { AuthConfig } from "../types";

/**
 * A Drizzle instance shaped exactly like the `db` a real consumer passes in.
 *
 * context-kit apps export `db` from `db/index.ts` as a Proxy over a lazily
 * created Drizzle instance, so the auth package must work through that
 * indirection (bound methods, `in` checks, prototype lookups) and not just
 * against a bare Drizzle object.
 */
let realDb: LibSQLDatabase<typeof schema> | undefined;

function getRealDb(): LibSQLDatabase<typeof schema> {
  if (!realDb) {
    realDb = drizzle(createClient({ url: ":memory:" }), { schema });
  }
  return realDb;
}

export const testDb = new Proxy({} as LibSQLDatabase<typeof schema>, {
  get(_target, prop) {
    const target = getRealDb();
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
  has(_target, prop) {
    return Reflect.has(getRealDb(), prop);
  },
  getPrototypeOf() {
    return Object.getPrototypeOf(getRealDb());
  },
});

let pushed: Promise<void> | undefined;

/**
 * Creates the auth tables in the in-memory SQLite database.
 *
 * Idempotent: the underlying push runs exactly once per process, so tests that
 * need a real database can call this freely.
 */
export function prepareTestDb(): Promise<void> {
  if (!pushed) {
    pushed = (async () => {
      const { pushSQLiteSchema } = await import("drizzle-kit/api");
      const { apply } = await pushSQLiteSchema(
        schema,
        getRealDb() as Parameters<typeof pushSQLiteSchema>[1]
      );
      await apply();
    })();
  }
  return pushed;
}

// Helper to build a minimal valid config
export function validConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    db: testDb,
    dialect: "sqlite",
    secret: "test-secret-at-least-32-chars-long!!",
    baseURL: "http://localhost:3000",
    ...overrides,
  };
}

// Store original env vars and restore after each test
export function setupEnvGuard(): void {
  let origSecret: string | undefined;
  let origURL: string | undefined;

  beforeEach(() => {
    origSecret = process.env.BETTER_AUTH_SECRET;
    origURL = process.env.BETTER_AUTH_URL;
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.BETTER_AUTH_URL;
  });

  afterEach(() => {
    if (origSecret !== undefined) process.env.BETTER_AUTH_SECRET = origSecret;
    else delete process.env.BETTER_AUTH_SECRET;
    if (origURL !== undefined) process.env.BETTER_AUTH_URL = origURL;
    else delete process.env.BETTER_AUTH_URL;
  });
}
