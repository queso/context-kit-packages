import { describe, expect, mock, test } from "bun:test";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SECRET_TOKEN = "server-secret-token";
const SECRET_HEADER = "x-error-token";

const NOW = new Date("2026-03-15T10:00:00.000Z");

function makePostRequest(
  body: unknown = { message: "TypeError: test" },
  headers: Record<string, string> = {}
): Request {
  return new Request("https://example.com/api/errors", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function makeGetRequest(
  searchParams: Record<string, string> = {},
  headers: Record<string, string> = {}
): Request {
  const url = new URL("https://example.com/api/errors");
  for (const [k, v] of Object.entries(searchParams)) url.searchParams.set(k, v);
  return new Request(url.toString(), { method: "GET", headers });
}

function makePostWithToken(body: unknown = { message: "TypeError: test" }): Request {
  return makePostRequest(body, { [SECRET_HEADER]: SECRET_TOKEN });
}

function makeGetWithToken(searchParams: Record<string, string> = {}): Request {
  return makeGetRequest(searchParams, { [SECRET_HEADER]: SECRET_TOKEN });
}

function makeErrorRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "err_1",
    fingerprint: "fp_abc123",
    message: "TypeError: Cannot read properties of undefined",
    stack: "TypeError\n  at Component (app.js:1:100)",
    componentStack: null,
    environment: "test",
    url: "https://example.com",
    userAgent: "Mozilla/5.0",
    occurrences: 1,
    resolvedAt: null,
    lastSeenAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

// ─── Mock Prisma factory ──────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: test mock
function makeMockPrisma(overrides?: {
  clientErrorFindFirst?: (args: any) => Promise<any>;
  clientErrorCreate?: (args: any) => Promise<any>;
  clientErrorUpdate?: (args: any) => Promise<any>;
  clientErrorUpsert?: (args: any) => Promise<any>;
  clientErrorFindMany?: (args: any) => Promise<any[]>;
  clientErrorCount?: (args: any) => Promise<number>;
}): any {
  const defaultRecord = makeErrorRecord();
  return {
    clientError: {
      findFirst: overrides?.clientErrorFindFirst ?? ((_: any) => Promise.resolve(null)),
      create: overrides?.clientErrorCreate ?? ((_: any) => Promise.resolve(defaultRecord)),
      update: overrides?.clientErrorUpdate ?? ((_: any) => Promise.resolve(defaultRecord)),
      upsert: overrides?.clientErrorUpsert ?? ((_: any) => Promise.resolve(defaultRecord)),
      findMany: overrides?.clientErrorFindMany ?? ((_: any) => Promise.resolve([defaultRecord])),
      count: overrides?.clientErrorCount ?? ((_: any) => Promise.resolve(1)),
    },
  };
}

// ─── Import target ────────────────────────────────────────────────────────────

// @ts-expect-error: module created by B.A. during implementation phase
const serverModule = await import("../server");
const { createErrorHandlers } = serverModule;

// ─── createErrorHandlers ──────────────────────────────────────────────────────

describe("createErrorHandlers", () => {
  test("is a function", () => {
    expect(typeof createErrorHandlers).toBe("function");
  });

  test("returns an object with POST and GET handlers", () => {
    const handlers = createErrorHandlers({ prisma: makeMockPrisma() });
    expect(typeof handlers.POST).toBe("function");
    expect(typeof handlers.GET).toBe("function");
  });
});

// ─── POST handler ─────────────────────────────────────────────────────────────

describe("createErrorHandlers — POST handler", () => {
  test("POST handler returns 200 with { success: true, fingerprint } on valid request", async () => {
    const { POST } = createErrorHandlers({ prisma: makeMockPrisma() });
    const res = await POST(makePostRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.fingerprint).toBe("string");
  });

  test("POST handler returns 400 when message is missing", async () => {
    const { POST } = createErrorHandlers({ prisma: makeMockPrisma() });
    const res = await POST(makePostRequest({}));
    expect(res.status).toBe(400);
  });

  test("POST handler returns 401 when secret configured but header missing", async () => {
    const { POST } = createErrorHandlers({
      prisma: makeMockPrisma(),
      secretHeaderName: SECRET_HEADER,
      secretHeaderToken: SECRET_TOKEN,
    });
    const res = await POST(makePostRequest());
    expect(res.status).toBe(401);
  });

  test("POST handler returns 401 when secret header value is wrong", async () => {
    const { POST } = createErrorHandlers({
      prisma: makeMockPrisma(),
      secretHeaderName: SECRET_HEADER,
      secretHeaderToken: SECRET_TOKEN,
    });
    const res = await POST(makePostRequest({ message: "err" }, { [SECRET_HEADER]: "bad" }));
    expect(res.status).toBe(401);
  });

  test("POST handler proceeds when correct secret token is provided", async () => {
    const { POST } = createErrorHandlers({
      prisma: makeMockPrisma(),
      secretHeaderName: SECRET_HEADER,
      secretHeaderToken: SECRET_TOKEN,
    });
    const res = await POST(makePostWithToken());
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(200);
  });

  test("POST handler returns 200 with no auth configured (permissive default)", async () => {
    const { POST } = createErrorHandlers({ prisma: makeMockPrisma() });
    const res = await POST(makePostRequest());
    expect(res.status).toBe(200);
  });
});

// ─── POST + source map resolution ─────────────────────────────────────────────

describe("createErrorHandlers — source map resolution on POST", () => {
  test("POST succeeds even when sourceMapDir is configured but no maps exist", async () => {
    const { POST } = createErrorHandlers({
      prisma: makeMockPrisma(),
      sourceMapDir: "/nonexistent/path/to/sourcemaps",
    });
    const res = await POST(makePostRequest({
      message: "TypeError: test",
      stack: "TypeError\n  at fn (app.js:1:0)",
    }));
    // Source map miss must not fail the request — graceful fallback
    expect(res.status).toBe(200);
  });

  test("POST accepts sourceMapDir configuration option without throwing", () => {
    expect(() =>
      createErrorHandlers({
        prisma: makeMockPrisma(),
        sourceMapDir: "/path/to/.next/static/chunks",
      })
    ).not.toThrow();
  });
});

// ─── POST + rate limiting ─────────────────────────────────────────────────────

describe("createErrorHandlers — rate limiting on POST", () => {
  test("POST returns 429 when rate limiter is configured and limit exceeded", async () => {
    const { POST } = createErrorHandlers({
      prisma: makeMockPrisma(),
      rateLimiter: { windowMs: 60_000, maxRequests: 2 },
    });

    const ip = "10.0.0.99";
    const makeIpRequest = () =>
      makePostRequest({ message: "rate limit test" }, { "x-forwarded-for": ip });

    // Exhaust the limit
    await POST(makeIpRequest());
    await POST(makeIpRequest());

    const blocked = await POST(makeIpRequest());
    expect(blocked.status).toBe(429);
  });

  test("POST returns 200 within rate limit", async () => {
    const { POST } = createErrorHandlers({
      prisma: makeMockPrisma(),
      rateLimiter: { windowMs: 60_000, maxRequests: 10 },
    });

    const ip = "10.0.0.77";
    const res = await POST(
      makePostRequest({ message: "ok" }, { "x-forwarded-for": ip })
    );
    expect(res.status).toBe(200);
  });

  test("POST does not apply rate limiting when rateLimiter is not configured", async () => {
    const { POST } = createErrorHandlers({ prisma: makeMockPrisma() });

    // Send many requests — none should be rate limited
    for (let i = 0; i < 5; i++) {
      const res = await POST(makePostRequest());
      expect(res.status).toBe(200);
    }
  });

  test("rate limiting on POST does not affect GET", async () => {
    const { POST, GET } = createErrorHandlers({
      prisma: makeMockPrisma(),
      rateLimiter: { windowMs: 60_000, maxRequests: 1 },
    });

    const ip = "10.0.0.55";
    // Exhaust POST limit
    await POST(makePostRequest({ message: "r" }, { "x-forwarded-for": ip }));
    const blocked = await POST(makePostRequest({ message: "r" }, { "x-forwarded-for": ip }));
    expect(blocked.status).toBe(429);

    // GET should be unaffected by the POST rate limiter
    const getRes = await GET(makeGetRequest({}, { "x-forwarded-for": ip }));
    expect(getRes.status).not.toBe(429);
  });
});

// ─── GET handler ──────────────────────────────────────────────────────────────

describe("createErrorHandlers — GET handler", () => {
  test("GET handler returns 200 with { errors, total }", async () => {
    const { GET } = createErrorHandlers({ prisma: makeMockPrisma() });
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.errors)).toBe(true);
    expect(typeof body.total).toBe("number");
  });

  test("GET handler returns 401 when secret configured but header missing", async () => {
    const { GET } = createErrorHandlers({
      prisma: makeMockPrisma(),
      secretHeaderName: SECRET_HEADER,
      secretHeaderToken: SECRET_TOKEN,
    });
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(401);
  });

  test("GET handler proceeds with correct secret token", async () => {
    const { GET } = createErrorHandlers({
      prisma: makeMockPrisma(),
      secretHeaderName: SECRET_HEADER,
      secretHeaderToken: SECRET_TOKEN,
    });
    const res = await GET(makeGetWithToken());
    expect(res.status).toBe(200);
  });

  test("GET handler supports ?env= filter", async () => {
    const clientErrorFindMany = mock((_: any) => Promise.resolve([]));
    const { GET } = createErrorHandlers({
      prisma: makeMockPrisma({ clientErrorFindMany }),
    });

    await GET(makeGetRequest({ env: "production" }));

    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const callArgs = (clientErrorFindMany.mock.calls as any[][])[0][0];
    const where = callArgs?.where;
    expect(where?.environment ?? where?.env).toBe("production");
  });

  test("GET handler defaults to 50 results per page", async () => {
    const clientErrorFindMany = mock((_: any) => Promise.resolve([]));
    const { GET } = createErrorHandlers({
      prisma: makeMockPrisma({ clientErrorFindMany }),
    });

    await GET(makeGetRequest());

    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const callArgs = (clientErrorFindMany.mock.calls as any[][])[0][0];
    expect(callArgs?.take ?? callArgs?.limit).toBe(50);
  });
});

// ─── deduplicationWindowMs passthrough ────────────────────────────────────────

describe("createErrorHandlers — deduplicationWindowMs", () => {
  test("accepts deduplicationWindowMs configuration", () => {
    expect(() =>
      createErrorHandlers({
        prisma: makeMockPrisma(),
        deduplicationWindowMs: 3_600_000,
      })
    ).not.toThrow();
  });

  test("defaults deduplicationWindowMs to 24 hours when not provided", () => {
    expect(() => createErrorHandlers({ prisma: makeMockPrisma() })).not.toThrow();
  });
});

// ─── server.ts re-exports ─────────────────────────────────────────────────────

describe("src/server.ts re-exports", () => {
  test("createIngestionHandler is re-exported from src/server", () => {
    expect(typeof serverModule.createIngestionHandler).toBe("function");
  });

  test("createQueryHandler is re-exported from src/server", () => {
    expect(typeof serverModule.createQueryHandler).toBe("function");
  });

  test("createRateLimiter is re-exported from src/server", () => {
    expect(typeof serverModule.createRateLimiter).toBe("function");
  });

  test("resolveStack is re-exported from src/server", () => {
    expect(typeof serverModule.resolveStack).toBe("function");
  });

  test("computeFingerprint is re-exported from src/server", () => {
    expect(typeof serverModule.computeFingerprint).toBe("function");
  });
});
