import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createQueryHandler } from "../server/query";
import {
  prepareTestDb,
  queryRequest,
  resetClientErrors,
  seedClientError,
  seedClientErrors,
  sqliteConfig,
  stubEnv,
  testDb,
} from "./helpers";

const SECRET_HEADER = "x-error-token";
const SECRET_TOKEN = "test-secret-token";

interface QueryBody {
  errors: Record<string, unknown>[];
  total: number;
}

const handler = createQueryHandler(sqliteConfig());

/** Runs the handler and returns its parsed body, failing on a non-200 status. */
async function query(params: Record<string, string> = {}): Promise<QueryBody> {
  const res = await handler(queryRequest(params));
  expect(res.status).toBe(200);
  return (await res.json()) as QueryBody;
}

function fingerprints(body: QueryBody): unknown[] {
  return body.errors.map((row) => row.fingerprint);
}

beforeAll(async () => {
  await prepareTestDb();
});

beforeEach(async () => {
  await resetClientErrors();
});

describe("createQueryHandler configuration", () => {
  test("throws when no db is provided", () => {
    expect(() => createQueryHandler({ dialect: "sqlite" } as never)).toThrow(
      /A Drizzle database instance is required/
    );
  });

  test("throws on a dialect it cannot query", () => {
    expect(() =>
      createQueryHandler({ db: testDb, dialect: "mysql" } as never)
    ).toThrow('Unsupported dialect "mysql"');
  });
});

describe("createQueryHandler production warning", () => {
  /** Mirrors captureWarnings in server.test.ts: captureConsole only intercepts log/error. */
  function captureWarnings(fn: () => void): string {
    const lines: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    };
    try {
      fn();
    } finally {
      console.warn = original;
    }
    return lines.join("\n");
  }

  test("warns when NODE_ENV is production and no secretHeaderToken is configured", () => {
    const restore = stubEnv("NODE_ENV", "production");
    try {
      const out = captureWarnings(() => {
        createQueryHandler(sqliteConfig());
      });
      expect(out).toContain("The query endpoint accepts unauthenticated requests");
    } finally {
      restore();
    }
  });

  test("does not warn when a secretHeaderToken is configured", () => {
    const restore = stubEnv("NODE_ENV", "production");
    try {
      const out = captureWarnings(() => {
        createQueryHandler({ ...sqliteConfig(), secretHeaderToken: "shh" });
      });
      expect(out).toBe("");
    } finally {
      restore();
    }
  });

  test("does not warn outside production", () => {
    const restore = stubEnv("NODE_ENV", "test");
    try {
      const out = captureWarnings(() => {
        createQueryHandler(sqliteConfig());
      });
      expect(out).toBe("");
    } finally {
      restore();
    }
  });
});

describe("query handler authentication", () => {
  const guarded = createQueryHandler({
    ...sqliteConfig(),
    secretHeaderName: SECRET_HEADER,
    secretHeaderToken: SECRET_TOKEN,
  });

  test("returns 401 and no rows when the token header is missing", async () => {
    await seedClientError();
    const res = await guarded(queryRequest());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  test("returns 401 when the token header is wrong", async () => {
    const res = await guarded(
      queryRequest({}, { [SECRET_HEADER]: "wrong" })
    );
    expect(res.status).toBe(401);
  });

  test("returns rows when the correct token is provided", async () => {
    await seedClientError({ fingerprint: "fp-authorized" });
    const res = await guarded(
      queryRequest({}, { [SECRET_HEADER]: SECRET_TOKEN })
    );
    expect(res.status).toBe(200);
    expect(fingerprints((await res.json()) as QueryBody)).toEqual([
      "fp-authorized",
    ]);
  });

  test("returns rows when no token is configured", async () => {
    await seedClientError({ fingerprint: "fp-open" });
    expect(fingerprints(await query())).toEqual(["fp-open"]);
  });
});

describe("query handler response shape", () => {
  test("returns an empty list and a zero total when nothing is stored", async () => {
    expect(await query()).toEqual({ errors: [], total: 0 });
  });

  test("returns rows keyed by the schema's property names with ISO timestamps", async () => {
    const lastSeenAt = new Date("2026-03-15T10:00:00.000Z");
    const resolvedAt = new Date("2026-03-16T11:30:00.000Z");
    const seeded = await seedClientError({
      message: "TypeError: boom",
      stack: "TypeError: boom\n  at Component (app.js:1:100)",
      componentStack: "\n  at ErrorBoundary",
      resolvedStack: "TypeError: boom\n  at Component (src/Component.tsx:1:1)",
      fingerprint: "fp-shape",
      occurrences: 7,
      environment: "production",
      url: "https://example.com/dashboard",
      userAgent: "Mozilla/5.0",
      lastSeenAt,
      resolvedAt,
    });

    const body = await query();
    expect(body.total).toBe(1);
    expect(body.errors[0]).toEqual({
      id: seeded.id,
      message: "TypeError: boom",
      stack: "TypeError: boom\n  at Component (app.js:1:100)",
      componentStack: "\n  at ErrorBoundary",
      resolvedStack: "TypeError: boom\n  at Component (src/Component.tsx:1:1)",
      fingerprint: "fp-shape",
      occurrences: 7,
      environment: "production",
      url: "https://example.com/dashboard",
      userAgent: "Mozilla/5.0",
      resolvedAt: resolvedAt.toISOString(),
      createdAt: seeded.createdAt.toISOString(),
      updatedAt: seeded.updatedAt.toISOString(),
      lastSeenAt: lastSeenAt.toISOString(),
    });
  });

  test("returns the newest errors first", async () => {
    await seedClientErrors([
      { fingerprint: "fp-old", lastSeenAt: new Date("2026-01-01T00:00:00Z") },
      { fingerprint: "fp-new", lastSeenAt: new Date("2026-03-01T00:00:00Z") },
      { fingerprint: "fp-mid", lastSeenAt: new Date("2026-02-01T00:00:00Z") },
    ]);

    expect(fingerprints(await query())).toEqual([
      "fp-new",
      "fp-mid",
      "fp-old",
    ]);
  });
});

describe("query handler filters", () => {
  beforeEach(async () => {
    await seedClientErrors([
      {
        fingerprint: "fp-prod-open",
        environment: "production",
        lastSeenAt: new Date("2026-03-10T00:00:00Z"),
      },
      {
        fingerprint: "fp-prod-resolved",
        environment: "production",
        lastSeenAt: new Date("2026-03-05T00:00:00Z"),
        resolvedAt: new Date("2026-03-06T00:00:00Z"),
      },
      {
        fingerprint: "fp-staging-open",
        environment: "staging",
        lastSeenAt: new Date("2026-02-01T00:00:00Z"),
      },
    ]);
  });

  test("returns every row when no filter is applied", async () => {
    const body = await query();
    expect(body.total).toBe(3);
    expect(fingerprints(body)).toEqual([
      "fp-prod-open",
      "fp-prod-resolved",
      "fp-staging-open",
    ]);
  });

  test("env returns only that environment", async () => {
    const body = await query({ env: "staging" });
    expect(fingerprints(body)).toEqual(["fp-staging-open"]);
    expect(body.total).toBe(1);
  });

  test("since keeps rows last seen at or after the timestamp", async () => {
    const body = await query({ since: "2026-03-05T00:00:00.000Z" });
    expect(fingerprints(body)).toEqual(["fp-prod-open", "fp-prod-resolved"]);
    expect(body.total).toBe(2);
  });

  test("fingerprint returns just that error", async () => {
    const body = await query({ fingerprint: "fp-prod-resolved" });
    expect(fingerprints(body)).toEqual(["fp-prod-resolved"]);
    expect(body.total).toBe(1);
  });

  test("fingerprint returns nothing when it matches no row", async () => {
    expect(await query({ fingerprint: "fp-does-not-exist" })).toEqual({
      errors: [],
      total: 0,
    });
  });

  test("resolved=false returns only unresolved errors", async () => {
    const body = await query({ resolved: "false" });
    expect(fingerprints(body)).toEqual(["fp-prod-open", "fp-staging-open"]);
    expect(body.total).toBe(2);
  });

  test("resolved=true returns only resolved errors", async () => {
    const body = await query({ resolved: "true" });
    expect(fingerprints(body)).toEqual(["fp-prod-resolved"]);
    expect(body.total).toBe(1);
  });

  test("combines env with resolved", async () => {
    const body = await query({ env: "production", resolved: "false" });
    expect(fingerprints(body)).toEqual(["fp-prod-open"]);
    expect(body.total).toBe(1);
  });
});

describe("query handler parameter validation", () => {
  async function seedDaily(count: number): Promise<void> {
    await seedClientErrors(
      Array.from({ length: count }, (_, i) => ({
        fingerprint: `fp-valid-${String(i).padStart(4, "0")}`,
        lastSeenAt: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000),
      }))
    );
  }

  test("limit=abc falls back to the default of 50", async () => {
    await seedDaily(60);
    const body = await query({ limit: "abc" });
    expect(body.errors).toHaveLength(50);
    expect(body.total).toBe(60);
  });

  test("limit=-1 falls back to the default of 50", async () => {
    await seedDaily(60);
    const body = await query({ limit: "-1" });
    expect(body.errors).toHaveLength(50);
  });

  test("offset=-5 is clamped to 0", async () => {
    await seedClientErrors([
      { fingerprint: "fp-a", lastSeenAt: new Date("2026-03-03T00:00:00Z") },
      { fingerprint: "fp-b", lastSeenAt: new Date("2026-03-02T00:00:00Z") },
    ]);
    const body = await query({ offset: "-5" });
    expect(fingerprints(body)).toEqual(["fp-a", "fp-b"]);
  });

  test("offset=abc is clamped to 0", async () => {
    await seedClientErrors([
      { fingerprint: "fp-a", lastSeenAt: new Date("2026-03-03T00:00:00Z") },
    ]);
    const body = await query({ offset: "abc" });
    expect(fingerprints(body)).toEqual(["fp-a"]);
  });

  test("an offset far above Number.MAX_SAFE_INTEGER is clamped instead of reaching the driver as-is", async () => {
    // Passing this straight through to Drizzle's .offset() would hand a
    // Postgres driver a value it rejects outright, answering 500 instead of a
    // well-formed empty page.
    await seedClientErrors([
      { fingerprint: "fp-a", lastSeenAt: new Date("2026-03-03T00:00:00Z") },
    ]);
    const res = await handler(
      queryRequest({ offset: "99999999999999999999" })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ errors: [], total: 1 });
  });

  test("returns 400 when since does not parse to a valid date", async () => {
    const res = await handler(queryRequest({ since: "not-a-date" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "since must be an ISO 8601 date",
    });
  });
});

describe("query handler pagination", () => {
  /** Rows dated one day apart, newest first once sorted. */
  async function seedDaily(count: number): Promise<void> {
    await seedClientErrors(
      Array.from({ length: count }, (_, i) => ({
        fingerprint: `fp-${String(i).padStart(4, "0")}`,
        lastSeenAt: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000),
      }))
    );
  }

  test("returns 50 rows by default and reports the full total", async () => {
    await seedDaily(55);
    const body = await query();
    expect(body.errors).toHaveLength(50);
    expect(body.total).toBe(55);
    expect(body.errors[0]?.fingerprint).toBe("fp-0054");
  });

  test("respects a smaller limit", async () => {
    await seedDaily(10);
    const body = await query({ limit: "3" });
    expect(fingerprints(body)).toEqual(["fp-0009", "fp-0008", "fp-0007"]);
    expect(body.total).toBe(10);
  });

  test("caps the limit at 200", async () => {
    await seedDaily(205);
    const body = await query({ limit: "500" });
    expect(body.errors).toHaveLength(200);
    expect(body.total).toBe(205);
  });

  test("offset skips rows without changing the total", async () => {
    await seedDaily(10);
    const body = await query({ limit: "2", offset: "3" });
    expect(fingerprints(body)).toEqual(["fp-0006", "fp-0005"]);
    expect(body.total).toBe(10);
  });

  test("an offset past the end returns no rows and the unchanged total", async () => {
    await seedDaily(4);
    expect(await query({ offset: "10" })).toEqual({ errors: [], total: 4 });
  });

  test("applies the filter and the page together", async () => {
    await seedClientErrors([
      {
        fingerprint: "fp-a",
        environment: "production",
        lastSeenAt: new Date("2026-03-03T00:00:00Z"),
      },
      {
        fingerprint: "fp-b",
        environment: "production",
        lastSeenAt: new Date("2026-03-02T00:00:00Z"),
      },
      {
        fingerprint: "fp-c",
        environment: "staging",
        lastSeenAt: new Date("2026-03-01T00:00:00Z"),
      },
    ]);
    const body = await query({ env: "production", limit: "1", offset: "1" });
    expect(fingerprints(body)).toEqual(["fp-b"]);
    expect(body.total).toBe(2);
  });
});
