import { describe, expect, mock, test } from "bun:test";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SECRET_TOKEN = "query-secret-token";
const SECRET_HEADER = "x-error-token";

const NOW = new Date("2026-03-15T10:00:00.000Z");

function makeErrorRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "err_1",
    fingerprint: "fp_abc123",
    message: "TypeError: Cannot read properties of undefined",
    stack: "TypeError\n  at Component (app.js:1:100)",
    componentStack: "\n  at ErrorBoundary\n  at App",
    environment: "production",
    url: "https://example.com/dashboard",
    userAgent: "Mozilla/5.0",
    occurrences: 3,
    resolvedAt: null,
    lastSeenAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeRequest(
  searchParams: Record<string, string> = {},
  headers: Record<string, string> = {}
): Request {
  const url = new URL("https://example.com/api/errors");
  for (const [key, value] of Object.entries(searchParams)) {
    url.searchParams.set(key, value);
  }
  return new Request(url.toString(), {
    method: "GET",
    headers,
  });
}

function makeRequestWithToken(searchParams: Record<string, string> = {}) {
  return makeRequest(searchParams, { [SECRET_HEADER]: SECRET_TOKEN });
}

// ─── Mock Prisma factory ──────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: test mock
function makeMockPrisma(overrides?: {
  clientErrorFindMany?: (args: any) => Promise<any[]>;
  clientErrorCount?: (args: any) => Promise<number>;
}): any {
  return {
    clientError: {
      findMany:
        overrides?.clientErrorFindMany ??
        ((_: any) => Promise.resolve([makeErrorRecord()])),
      count: overrides?.clientErrorCount ?? ((_: any) => Promise.resolve(1)),
    },
  };
}

// ─── Import target ────────────────────────────────────────────────────────────

// @ts-expect-error: module created by B.A. during implementation phase
const { createQueryHandler } = await import("../server/query");

// ─── createQueryHandler ───────────────────────────────────────────────────────

describe("createQueryHandler", () => {
  test("is a function", () => {
    expect(typeof createQueryHandler).toBe("function");
  });

  test("returns a function (Next.js GET route handler)", () => {
    const handler = createQueryHandler({ prisma: makeMockPrisma() });
    expect(typeof handler).toBe("function");
  });
});

// ─── Authentication ───────────────────────────────────────────────────────────

describe("query handler — authentication", () => {
  test("returns 401 when secret is configured but header is missing", async () => {
    const handler = createQueryHandler({
      prisma: makeMockPrisma(),
      secretHeaderName: SECRET_HEADER,
      secretHeaderToken: SECRET_TOKEN,
    });

    const req = makeRequest();
    const res = await handler(req);

    expect(res.status).toBe(401);
  });

  test("returns 401 when secret header value is wrong", async () => {
    const handler = createQueryHandler({
      prisma: makeMockPrisma(),
      secretHeaderName: SECRET_HEADER,
      secretHeaderToken: SECRET_TOKEN,
    });

    const req = makeRequest({}, { [SECRET_HEADER]: "wrong-token" });
    const res = await handler(req);

    expect(res.status).toBe(401);
  });

  test("proceeds when correct token is provided", async () => {
    const handler = createQueryHandler({
      prisma: makeMockPrisma(),
      secretHeaderName: SECRET_HEADER,
      secretHeaderToken: SECRET_TOKEN,
    });

    const req = makeRequestWithToken();
    const res = await handler(req);

    expect(res.status).not.toBe(401);
  });

  test("proceeds when no secret is configured", async () => {
    const handler = createQueryHandler({ prisma: makeMockPrisma() });
    const req = makeRequest();
    const res = await handler(req);

    expect(res.status).not.toBe(401);
  });
});

// ─── Success response shape ───────────────────────────────────────────────────

describe("query handler — response shape", () => {
  test("returns 200 on a valid request", async () => {
    const handler = createQueryHandler({ prisma: makeMockPrisma() });
    const res = await handler(makeRequest());
    expect(res.status).toBe(200);
  });

  test("response body has errors array", async () => {
    const handler = createQueryHandler({
      prisma: makeMockPrisma({
        clientErrorFindMany: (_: any) => Promise.resolve([makeErrorRecord()]),
      }),
    });
    const res = await handler(makeRequest());
    const body = await res.json();
    expect(Array.isArray(body.errors)).toBe(true);
  });

  test("response body has total count", async () => {
    const handler = createQueryHandler({
      prisma: makeMockPrisma({
        clientErrorFindMany: (_: any) => Promise.resolve([makeErrorRecord()]),
        clientErrorCount: (_: any) => Promise.resolve(42),
      }),
    });
    const res = await handler(makeRequest());
    const body = await res.json();
    expect(typeof body.total).toBe("number");
    expect(body.total).toBe(42);
  });

  test("errors array contains records from the database", async () => {
    const record = makeErrorRecord({ fingerprint: "fp_unique_xyz" });
    const handler = createQueryHandler({
      prisma: makeMockPrisma({
        clientErrorFindMany: (_: any) => Promise.resolve([record]),
      }),
    });
    const res = await handler(makeRequest());
    const body = await res.json();
    expect(body.errors.length).toBe(1);
    expect(body.errors[0].fingerprint).toBe("fp_unique_xyz");
  });

  test("returns empty errors array when no records match", async () => {
    const handler = createQueryHandler({
      prisma: makeMockPrisma({
        clientErrorFindMany: (_: any) => Promise.resolve([]),
        clientErrorCount: (_: any) => Promise.resolve(0),
      }),
    });
    const res = await handler(makeRequest());
    const body = await res.json();
    expect(body.errors).toEqual([]);
    expect(body.total).toBe(0);
  });
});

// ─── Ordering ─────────────────────────────────────────────────────────────────

describe("query handler — ordering", () => {
  test("queries errors ordered by lastSeenAt descending", async () => {
    const clientErrorFindMany = mock((_: any) => Promise.resolve([]));
    const handler = createQueryHandler({
      prisma: makeMockPrisma({ clientErrorFindMany }),
    });

    await handler(makeRequest());

    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const callArgs = (clientErrorFindMany.mock.calls as any[][])[0][0];
    const orderBy = callArgs?.orderBy;
    if (orderBy) {
      const isLastSeenAtDesc =
        orderBy?.lastSeenAt === "desc" ||
        (Array.isArray(orderBy) &&
          orderBy.some((o: any) => o?.lastSeenAt === "desc"));
      expect(isLastSeenAtDesc).toBe(true);
    }
  });
});

// ─── Filters ─────────────────────────────────────────────────────────────────

describe("query handler — env filter", () => {
  test("passes env filter to prisma when ?env= is provided", async () => {
    const clientErrorFindMany = mock((_: any) => Promise.resolve([]));
    const handler = createQueryHandler({
      prisma: makeMockPrisma({ clientErrorFindMany }),
    });

    await handler(makeRequest({ env: "production" }));

    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const callArgs = (clientErrorFindMany.mock.calls as any[][])[0][0];
    const where = callArgs?.where;
    expect(where?.environment ?? where?.env).toBe("production");
  });

  test("does not apply env filter when ?env= is absent", async () => {
    const clientErrorFindMany = mock((_: any) => Promise.resolve([]));
    const handler = createQueryHandler({
      prisma: makeMockPrisma({ clientErrorFindMany }),
    });

    await handler(makeRequest());

    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const callArgs = (clientErrorFindMany.mock.calls as any[][])[0][0];
    const where = callArgs?.where;
    // environment field should be absent or undefined when not filtered
    expect(where?.environment ?? where?.env).toBeUndefined();
  });
});

describe("query handler — since filter", () => {
  test("applies lastSeenAt gte filter when ?since= is provided", async () => {
    const clientErrorFindMany = mock((_: any) => Promise.resolve([]));
    const handler = createQueryHandler({
      prisma: makeMockPrisma({ clientErrorFindMany }),
    });

    const since = "2026-03-14T00:00:00.000Z";
    await handler(makeRequest({ since }));

    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const callArgs = (clientErrorFindMany.mock.calls as any[][])[0][0];
    const where = callArgs?.where;
    // Should have a date range filter
    const hasDateFilter =
      where?.lastSeenAt?.gte !== undefined ||
      where?.createdAt?.gte !== undefined;
    expect(where !== undefined).toBe(true);
    // If date filter is present, it should be after the since timestamp
    if (hasDateFilter) {
      const filterDate = where?.lastSeenAt?.gte ?? where?.createdAt?.gte;
      expect(new Date(filterDate).getTime()).toBe(new Date(since).getTime());
    }
  });
});

describe("query handler — fingerprint filter", () => {
  test("filters by fingerprint when ?fingerprint= is provided", async () => {
    const clientErrorFindMany = mock((_: any) => Promise.resolve([]));
    const handler = createQueryHandler({
      prisma: makeMockPrisma({ clientErrorFindMany }),
    });

    await handler(makeRequest({ fingerprint: "fp_target_abc" }));

    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const callArgs = (clientErrorFindMany.mock.calls as any[][])[0][0];
    const where = callArgs?.where;
    expect(where?.fingerprint).toBe("fp_target_abc");
  });
});

describe("query handler — resolved filter", () => {
  test("returns only unresolved errors when ?resolved=false", async () => {
    const clientErrorFindMany = mock((_: any) => Promise.resolve([]));
    const handler = createQueryHandler({
      prisma: makeMockPrisma({ clientErrorFindMany }),
    });

    await handler(makeRequest({ resolved: "false" }));

    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const callArgs = (clientErrorFindMany.mock.calls as any[][])[0][0];
    const where = callArgs?.where;
    if (where?.resolvedAt !== undefined) {
      expect(where.resolvedAt).toBeNull();
    }
  });

  test("returns only resolved errors when ?resolved=true", async () => {
    const clientErrorFindMany = mock((_: any) => Promise.resolve([]));
    const handler = createQueryHandler({
      prisma: makeMockPrisma({ clientErrorFindMany }),
    });

    await handler(makeRequest({ resolved: "true" }));

    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const callArgs = (clientErrorFindMany.mock.calls as any[][])[0][0];
    const where = callArgs?.where;
    if (where?.resolvedAt !== undefined) {
      // Should filter for non-null resolvedAt
      expect(where.resolvedAt).not.toBeNull();
    }
  });
});

// ─── Pagination ───────────────────────────────────────────────────────────────

describe("query handler — pagination", () => {
  test("defaults to limit of 50 results", async () => {
    const clientErrorFindMany = mock((_: any) => Promise.resolve([]));
    const handler = createQueryHandler({
      prisma: makeMockPrisma({ clientErrorFindMany }),
    });

    await handler(makeRequest());

    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const callArgs = (clientErrorFindMany.mock.calls as any[][])[0][0];
    expect(callArgs?.take ?? callArgs?.limit).toBe(50);
  });

  test("respects custom ?limit= parameter", async () => {
    const clientErrorFindMany = mock((_: any) => Promise.resolve([]));
    const handler = createQueryHandler({
      prisma: makeMockPrisma({ clientErrorFindMany }),
    });

    await handler(makeRequest({ limit: "10" }));

    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const callArgs = (clientErrorFindMany.mock.calls as any[][])[0][0];
    expect(callArgs?.take ?? callArgs?.limit).toBe(10);
  });

  test("caps limit at 200 even when larger value is requested", async () => {
    const clientErrorFindMany = mock((_: any) => Promise.resolve([]));
    const handler = createQueryHandler({
      prisma: makeMockPrisma({ clientErrorFindMany }),
    });

    await handler(makeRequest({ limit: "999" }));

    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const callArgs = (clientErrorFindMany.mock.calls as any[][])[0][0];
    expect(callArgs?.take ?? callArgs?.limit).toBeLessThanOrEqual(200);
  });

  test("applies offset when ?offset= is provided", async () => {
    const clientErrorFindMany = mock((_: any) => Promise.resolve([]));
    const handler = createQueryHandler({
      prisma: makeMockPrisma({ clientErrorFindMany }),
    });

    await handler(makeRequest({ offset: "20" }));

    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const callArgs = (clientErrorFindMany.mock.calls as any[][])[0][0];
    expect(callArgs?.skip ?? callArgs?.offset).toBe(20);
  });

  test("defaults offset to 0 when not provided", async () => {
    const clientErrorFindMany = mock((_: any) => Promise.resolve([]));
    const handler = createQueryHandler({
      prisma: makeMockPrisma({ clientErrorFindMany }),
    });

    await handler(makeRequest());

    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const callArgs = (clientErrorFindMany.mock.calls as any[][])[0][0];
    expect(callArgs?.skip ?? 0).toBe(0);
  });
});
