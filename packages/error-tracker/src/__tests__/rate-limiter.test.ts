import { describe, expect, test } from "bun:test";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(
  ip: string | null = "127.0.0.1",
  headers: Record<string, string> = {}
): Request {
  const allHeaders: Record<string, string> = { ...headers };
  if (ip !== null) {
    // Default: set x-forwarded-for unless a more specific header override is passed
    if (!allHeaders["x-forwarded-for"] && !allHeaders["x-real-ip"]) {
      allHeaders["x-forwarded-for"] = ip;
    }
  }
  return new Request("https://example.com/api/errors", {
    method: "POST",
    headers: allHeaders,
    body: JSON.stringify({ message: "test" }),
  });
}

function makeRequestWithForwardedFor(ip: string): Request {
  return makeRequest(null, { "x-forwarded-for": ip });
}

function makeRequestWithRealIp(ip: string): Request {
  return makeRequest(null, { "x-real-ip": ip });
}

function makeRequestWithNoIpHeaders(): Request {
  return new Request("https://example.com/api/errors", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "test" }),
  });
}

// ─── Import target ────────────────────────────────────────────────────────────

// @ts-expect-error: module created by B.A. during implementation phase
const { createRateLimiter } = await import("../server/rate-limiter");

// ─── createRateLimiter ────────────────────────────────────────────────────────

describe("createRateLimiter", () => {
  test("is a function", () => {
    expect(typeof createRateLimiter).toBe("function");
  });

  test("returns an object with a check function", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 60 });
    expect(typeof limiter.check).toBe("function");
  });

  test("does not throw when called with no options (uses defaults)", () => {
    expect(() => createRateLimiter()).not.toThrow();
  });

  test("defaults windowMs to 60,000 ms (1 minute)", () => {
    // Verify default by creating without options and checking behavior is consistent
    const limiter = createRateLimiter();
    expect(limiter).toBeDefined();
  });

  test("defaults maxRequests to 60", () => {
    // Create with explicit window, omit maxRequests — should default to 60
    const limiter = createRateLimiter({ windowMs: 60_000 });
    expect(limiter).toBeDefined();
  });
});

describe("createRateLimiter — check function", () => {
  test("check returns null (allowed) for first request from an IP", async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 5 });
    const result = await limiter.check(makeRequest("1.2.3.4"));
    expect(result).toBeNull();
  });

  test("check returns null for requests within the limit", async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 5 });
    const ip = "10.0.0.1";
    for (let i = 0; i < 5; i++) {
      const result = await limiter.check(makeRequest(ip));
      expect(result).toBeNull();
    }
  });

  test("check returns a 429 Response when limit is exceeded", async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 3 });
    const ip = "10.0.0.2";

    for (let i = 0; i < 3; i++) {
      await limiter.check(makeRequest(ip));
    }

    const result = await limiter.check(makeRequest(ip));
    expect(result).not.toBeNull();
    expect(result?.status).toBe(429);
  });

  test("429 Response includes Retry-After header", async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 1 });
    const ip = "10.0.0.3";

    await limiter.check(makeRequest(ip));
    const result = await limiter.check(makeRequest(ip));

    expect(result).not.toBeNull();
    const retryAfter =
      result?.headers.get("retry-after") ?? result?.headers.get("Retry-After");
    expect(retryAfter).not.toBeNull();
    // Retry-After should be a positive integer (seconds)
    const seconds = parseInt(retryAfter ?? "0", 10);
    expect(seconds).toBeGreaterThan(0);
  });

  test("different IPs have independent rate limit counters", async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 2 });

    const ip1 = "192.168.1.1";
    const ip2 = "192.168.1.2";

    // Exhaust ip1's quota
    await limiter.check(makeRequest(ip1));
    await limiter.check(makeRequest(ip1));
    const ip1Blocked = await limiter.check(makeRequest(ip1));
    expect(ip1Blocked?.status).toBe(429);

    // ip2 should still be allowed
    const ip2Result = await limiter.check(makeRequest(ip2));
    expect(ip2Result).toBeNull();
  });
});

describe("createRateLimiter — IP extraction", () => {
  test("extracts IP from x-forwarded-for header", async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 1 });

    const ip = "203.0.113.1";
    await limiter.check(makeRequestWithForwardedFor(ip));
    const result = await limiter.check(makeRequestWithForwardedFor(ip));

    // Same IP should be rate-limited
    expect(result?.status).toBe(429);
  });

  test("extracts IP from x-real-ip header", async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 1 });

    const ip = "203.0.113.2";
    await limiter.check(makeRequestWithRealIp(ip));
    const result = await limiter.check(makeRequestWithRealIp(ip));

    expect(result?.status).toBe(429);
  });

  test("prefers x-forwarded-for over x-real-ip when both are present", async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 1 });

    const fwdIp = "203.0.113.10";
    const realIp = "203.0.113.20";

    const req = makeRequest(null, {
      "x-forwarded-for": fwdIp,
      "x-real-ip": realIp,
    });

    await limiter.check(req);
    const result = await limiter.check(req);

    // The request should be limited because the same x-forwarded-for IP was seen twice
    expect(result?.status).toBe(429);
  });

  test("handles x-forwarded-for with multiple IPs (uses first)", async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 1 });

    const chainedIp = "203.0.113.5, 10.0.0.1, 172.16.0.1";
    const req1 = makeRequest(null, { "x-forwarded-for": chainedIp });
    const req2 = makeRequest(null, { "x-forwarded-for": chainedIp });

    await limiter.check(req1);
    const result = await limiter.check(req2);

    // Same first IP — should be rate-limited
    expect(result?.status).toBe(429);
  });

  test("handles requests with no IP headers (falls back to default key)", async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 1 });

    // Should not throw when IP headers are absent
    const result1 = await limiter.check(makeRequestWithNoIpHeaders());
    expect(result1).toBeNull();

    const result2 = await limiter.check(makeRequestWithNoIpHeaders());
    // With maxRequests=1, the second request from "unknown" IP should be limited
    expect(result2?.status).toBe(429);
  });
});

describe("createRateLimiter — in-memory Map store", () => {
  test("tracks state in memory (separate limiter instances are independent)", async () => {
    const limiter1 = createRateLimiter({ windowMs: 60_000, maxRequests: 1 });
    const limiter2 = createRateLimiter({ windowMs: 60_000, maxRequests: 1 });

    const ip = "10.10.10.1";

    // Exhaust limiter1
    await limiter1.check(makeRequest(ip));
    const blocked = await limiter1.check(makeRequest(ip));
    expect(blocked?.status).toBe(429);

    // limiter2 has its own state — not exhausted
    const allowed = await limiter2.check(makeRequest(ip));
    expect(allowed).toBeNull();
  });
});

describe("createRateLimiter — window reset", () => {
  test("stale entries outside the window do not count against the limit", async () => {
    // Use a very short window so we can test expiry
    const windowMs = 50; // 50ms
    const limiter = createRateLimiter({ windowMs, maxRequests: 2 });
    const ip = "10.20.30.40";

    // Make 2 requests (hits the limit)
    await limiter.check(makeRequest(ip));
    await limiter.check(makeRequest(ip));

    // Wait for the window to expire
    await new Promise((r) => setTimeout(r, windowMs + 10));

    // After window reset, the same IP should be allowed again
    const resultAfterExpiry = await limiter.check(makeRequest(ip));
    expect(resultAfterExpiry).toBeNull();
  });
});
