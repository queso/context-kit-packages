import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  createErrorHandlers,
  createIngestionHandler,
  createQueryHandler,
} from "../server";
import type { ClientError as PostgresClientError } from "../schema/postgres";
import type { ClientError as SqliteClientError } from "../schema/sqlite";
// Imported from the server barrel, not from ../types: the server-side surface
// re-exports both, and that is the path a consumer's route handler imports.
import type { DatabaseConfig, ErrorTrackerDialect } from "../server";
import type { ErrorPayload } from "../types";
import {
  errorRequest,
  prepareTestDb,
  queryRequest,
  readOnlyClientError,
  resetClientErrors,
  testDb,
} from "./helpers";

// Type-only contract. Nothing here runs; it fails to compile if the dialect
// union stops being the closed two-value union the package documents. This is
// only enforced once tsconfig.json stops excluding src/__tests__ (packages/auth
// already includes its tests in the program).
"sqlite" satisfies ErrorTrackerDialect;
"postgres" satisfies ErrorTrackerDialect;
// @ts-expect-error the dialect union is closed to the two supported dialects
"mysql" satisfies ErrorTrackerDialect;

beforeAll(async () => {
  await prepareTestDb();
});

beforeEach(async () => {
  await resetClientErrors();
});

describe("DatabaseConfig", () => {
  /** Exactly the two fields a consumer passes: `db` from @/db, `getDialect()`. */
  const config: DatabaseConfig = { db: testDb, dialect: "sqlite" };

  test("is the config every server-side factory accepts", () => {
    expect(typeof createIngestionHandler(config)).toBe("function");
    expect(typeof createQueryHandler(config)).toBe("function");
    const handlers = createErrorHandlers(config);
    expect(typeof handlers.POST).toBe("function");
    expect(typeof handlers.GET).toBe("function");
  });

  test("a Drizzle instance reached through a Proxy still works", async () => {
    // context-kit apps export `db` as a Proxy over a lazily created Drizzle
    // instance, so the package must not depend on receiving a bare object.
    const res = await createIngestionHandler(config)(
      errorRequest({ message: "TypeError: through the proxy" })
    );
    expect(res.status).toBe(200);
    expect((await readOnlyClientError()).message).toBe(
      "TypeError: through the proxy"
    );
  });
});

describe("the client payload and the stored row agree on field names", () => {
  test("every ErrorPayload field a browser reports is stored and queryable", async () => {
    // `ErrorPayload` is what the browser half posts; the Drizzle schema is what
    // the server half writes. A rename on either side would drop data silently,
    // and nothing but a round trip notices.
    // Named separately so the assertions compare against required strings:
    // `stack` and `componentStack` are optional on ErrorPayload but not-null
    // strings once the row exists.
    const reported = {
      message: "TypeError: payload round trip",
      stack: "TypeError: payload round trip\n  at Component (app.js:1:100)",
      componentStack: "\n  at ErrorBoundary\n  at App",
      url: "https://example.com/dashboard",
      userAgent: "Mozilla/5.0",
      environment: "production",
    };
    const payload: ErrorPayload = reported;

    const config: DatabaseConfig = { db: testDb, dialect: "sqlite" };
    const post = await createIngestionHandler(config)(errorRequest(payload));
    expect(post.status).toBe(200);

    const row = await readOnlyClientError();
    expect(row.message).toBe(reported.message);
    expect(row.stack).toBe(reported.stack);
    expect(row.componentStack).toBe(reported.componentStack);
    expect(row.url).toBe(reported.url);
    expect(row.userAgent).toBe(reported.userAgent);

    const get = await createQueryHandler(config)(queryRequest());
    const body = (await get.json()) as { errors: Record<string, unknown>[] };
    expect(body.errors[0]).toMatchObject({
      message: reported.message,
      stack: reported.stack,
      componentStack: reported.componentStack,
      url: reported.url,
      userAgent: reported.userAgent,
    });
  });
});

describe("ClientError row type", () => {
  test("a row read from sqlite is also a postgres ClientError", async () => {
    // Consumers write dialect-neutral code against one row type, so the two
    // modules have to infer the same shape. The assignments below are the
    // compile-time half; the assertions are the runtime half.
    const config: DatabaseConfig = { db: testDb, dialect: "sqlite" };
    await createIngestionHandler(config)(
      errorRequest({ message: "TypeError: row type" })
    );

    const sqliteRow: SqliteClientError = await readOnlyClientError();
    const postgresRow: PostgresClientError = sqliteRow;
    expect(postgresRow.fingerprint).toBe(sqliteRow.fingerprint);
    expect(postgresRow.occurrences).toBe(1);
    expect(postgresRow.lastSeenAt).toBeInstanceOf(Date);
    expect(postgresRow.resolvedAt).toBeNull();
  });
});
