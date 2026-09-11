import { createClient } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "../schema/sqlite";
import type { ClientError, NewClientError } from "../schema/sqlite";
import type { DatabaseConfig } from "../types";

/**
 * A Drizzle instance shaped exactly like the `db` a real consumer passes in.
 *
 * context-kit apps export `db` from `db/index.ts` as a Proxy over a lazily
 * created Drizzle instance, so the error-tracker package must work through that
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

/**
 * Wraps an async factory so it runs at most once concurrently, caching the
 * result on success. A rejected call is not cached: the next call clears the
 * stale rejection and invokes the factory again.
 */
export function memoizeAsync<T>(fn: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | undefined;
  return () => {
    if (!cached) {
      cached = fn().catch((err) => {
        cached = undefined;
        throw err;
      });
    }
    return cached;
  };
}

/**
 * Creates the `client_error` table in the in-memory SQLite database.
 *
 * The underlying push runs once per process on success; a failed push (e.g. a
 * transient drizzle-kit/api error) is not cached, so the next call retries it.
 */
export const prepareTestDb = memoizeAsync(async () => {
  const { pushSQLiteSchema } = await import("drizzle-kit/api");
  const { apply } = await pushSQLiteSchema(
    schema,
    getRealDb() as Parameters<typeof pushSQLiteSchema>[1]
  );
  await apply();
});

/** The config every server-side factory takes, pointed at the test database. */
export function sqliteConfig(): DatabaseConfig {
  return { db: testDb, dialect: "sqlite" };
}

/**
 * Empties `client_error`. Every test file shares one in-memory database, so
 * each test has to clear the table itself or results depend on file order.
 */
export async function resetClientErrors(): Promise<void> {
  await testDb.delete(schema.clientError);
}

/** Every row in `client_error`, oldest-inserted order not guaranteed. */
export async function readClientErrors(): Promise<ClientError[]> {
  return testDb.select().from(schema.clientError);
}

/** The single row in `client_error`; throws when there is not exactly one. */
export async function readOnlyClientError(): Promise<ClientError> {
  const rows = await readClientErrors();
  if (rows.length !== 1) {
    throw new Error(`Expected exactly 1 client_error row, found ${rows.length}`);
  }
  return rows[0]!;
}

/** The row carrying `fingerprint`, or undefined when there is none. */
export async function findClientError(
  fingerprint: string
): Promise<ClientError | undefined> {
  const rows = await readClientErrors();
  return rows.find((row) => row.fingerprint === fingerprint);
}

let seedCounter = 0;

/**
 * Inserts one `client_error` row directly through Drizzle, filling in the
 * not-null columns a query-side test does not care about.
 */
export async function seedClientError(
  overrides: Partial<NewClientError> = {}
): Promise<ClientError> {
  const [row] = await seedClientErrors([overrides]);
  return row!;
}

/** Inserts several `client_error` rows in one statement. */
export async function seedClientErrors(
  rows: Partial<NewClientError>[]
): Promise<ClientError[]> {
  const values = rows.map((overrides) => {
    seedCounter += 1;
    return {
      message: `seeded error ${seedCounter}`,
      fingerprint: `seed-fingerprint-${seedCounter}`,
      environment: "production",
      lastSeenAt: new Date("2026-01-01T00:00:00.000Z"),
      ...overrides,
    } satisfies NewClientError;
  });
  return testDb.insert(schema.clientError).values(values).returning();
}

/** Builds a POST request carrying a JSON error report. */
export function errorRequest(
  body: unknown,
  headers: Record<string, string> = {}
): Request {
  return new Request("https://example.com/api/errors", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** Builds a POST request whose body is not JSON at all. */
export function rawRequest(
  body: string,
  headers: Record<string, string> = {}
): Request {
  return new Request("https://example.com/api/errors", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

/** Builds a GET request against the query endpoint with `params` applied. */
export function queryRequest(
  params: Record<string, string> = {},
  headers: Record<string, string> = {}
): Request {
  const url = new URL("https://example.com/api/errors");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new Request(url, { method: "GET", headers });
}

/**
 * Replaces `console.log`/`console.error` with collectors for the duration of
 * `fn`, returning everything written alongside the callback's result. The
 * console is restored even when `fn` throws (which is how the stubbed
 * `process.exit` below reports itself).
 */
export async function captureConsole<T>(
  fn: () => Promise<T>
): Promise<{ out: string; lines: string[]; result?: T; error?: unknown }> {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const collect = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  console.log = collect;
  console.error = collect;
  try {
    const result = await fn();
    return { out: lines.join("\n"), lines, result };
  } catch (error) {
    return { out: lines.join("\n"), lines, error };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

/** Thrown by the stubbed `process.exit` so code after the call cannot run. */
export class ProcessExitError extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
    this.name = "ProcessExitError";
  }
}

/**
 * Replaces `process.exit` with a stub that records its code and throws, so a
 * caller that expects `exit()` to end the function does not keep going.
 */
export function stubProcessExit(): { codes: number[]; restore: () => void } {
  const codes: number[] = [];
  const original = process.exit;
  process.exit = ((code?: number) => {
    codes.push(code ?? 0);
    throw new ProcessExitError(code ?? 0);
  }) as typeof process.exit;
  return {
    codes,
    restore: () => {
      process.exit = original;
    },
  };
}

/** Sets `process.env[key]`, returning a restore function for the old value. */
export function stubEnv(key: string, value: string | undefined): () => void {
  const original = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return () => {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  };
}
