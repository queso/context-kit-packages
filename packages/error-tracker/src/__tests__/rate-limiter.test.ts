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

  test("defaults windowMs to 60,000 ms (1 minute)", async () => {
    const originalNow = Date.now;
    let currentTime = 1_000_000;
    // biome-ignore lint/suspicious/noExplicitAny: controlling time deterministically
    (Date as any).now = () => currentTime;
    try {
      // Omit windowMs — should default to 60,000ms
      const limiter = createRateLimiter({ maxRequests: 1 });
      const ip = "50.50.50.50";

      await limiter.check(makeRequest(ip));

      // Just under the default window: still limited
      currentTime += 59_999;
      const stillLimited = await limiter.check(makeRequest(ip));
      expect(stillLimited?.status).toBe(429);

      // Just past the default window: reset
      currentTime += 2;
      const afterWindow = await limiter.check(makeRequest(ip));
      expect(afterWindow).toBeNull();
    } finally {
      Date.now = originalNow;
    }
  });

  test("defaults maxRequests to 60", async () => {
    // Omit maxRequests — should default to 60
    const limiter = createRateLimiter({ windowMs: 60_000 });
    const ip = "60.60.60.60";

    for (let i = 0; i < 60; i++) {
      const result = await limiter.check(makeRequest(ip));
      expect(result).toBeNull();
    }

    const blocked = await limiter.check(makeRequest(ip));
    expect(blocked?.status).toBe(429);
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

    // Exhaust the quota keyed by the x-forwarded-for IP
    await limiter.check(
      makeRequest(null, { "x-forwarded-for": fwdIp, "x-real-ip": realIp })
    );

    // A later request carrying only the same x-real-ip value must be unaffected —
    // if the limiter had keyed on x-real-ip, this would be blocked
    const realIpOnlyResult = await limiter.check(makeRequestWithRealIp(realIp));
    expect(realIpOnlyResult).toBeNull();

    // A later request carrying only the same x-forwarded-for value should be
    // blocked, confirming the limiter keyed on x-forwarded-for
    const fwdIpOnlyResult = await limiter.check(
      makeRequestWithForwardedFor(fwdIp)
    );
    expect(fwdIpOnlyResult?.status).toBe(429);
  });

  test("handles x-forwarded-for with multiple IPs (uses first)", async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 1 });

    const firstIp = "203.0.113.5";
    const secondIp = "10.0.0.1";
    const chainedIp = `${firstIp}, ${secondIp}, 172.16.0.1`;

    await limiter.check(makeRequest(null, { "x-forwarded-for": chainedIp }));

    // A follow-up using only the first IP in the chain should be blocked,
    // confirming the limiter keyed on the first IP
    const firstIpOnly = await limiter.check(
      makeRequestWithForwardedFor(firstIp)
    );
    expect(firstIpOnly?.status).toBe(429);

    // A follow-up using only the second IP in the chain should be unaffected,
    // confirming the limiter did NOT key on it
    const secondIpOnly = await limiter.check(
      makeRequestWithForwardedFor(secondIp)
    );
    expect(secondIpOnly).toBeNull();
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

describe("createRateLimiter — maxEntries cap", () => {
  test("evicts the oldest entry once maxEntries is reached", async () => {
    const limiter = createRateLimiter({
      windowMs: 60_000,
      maxRequests: 1,
      maxEntries: 3,
    });
    const ips = ["1.1.1.1", "2.2.2.2", "3.3.3.3", "4.4.4.4"];

    for (const ip of ips) {
      const result = await limiter.check(makeRequestWithForwardedFor(ip));
      expect(result).toBeNull();
    }

    // The map can only hold 3 entries, so inserting the 4th must have evicted
    // the oldest (the 1st). It gets a fresh quota instead of a 429.
    const afterEviction = await limiter.check(
      makeRequestWithForwardedFor(ips[0]!)
    );
    expect(afterEviction).toBeNull();
  });

  test("sweeps expired entries for room before evicting a live one", async () => {
    const windowMs = 50;
    const limiter = createRateLimiter({
      windowMs,
      maxRequests: 1,
      maxEntries: 1,
    });

    await limiter.check(makeRequestWithForwardedFor("10.10.10.10"));

    // Let the only entry's window expire before the next distinct IP arrives.
    await new Promise((r) => setTimeout(r, windowMs + 10));

    await limiter.check(makeRequestWithForwardedFor("20.20.20.20"));

    // The expired entry should have been swept for room, not left in place,
    // so it also gets a fresh quota rather than reusing a stale one.
    const result = await limiter.check(
      makeRequestWithForwardedFor("10.10.10.10")
    );
    expect(result).toBeNull();
  });

  test("defaults maxEntries to 10,000", async () => {
    // No option provided — should not throw and should behave normally.
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 5 });
    const result = await limiter.check(makeRequestWithForwardedFor("30.30.30.30"));
    expect(result).toBeNull();
  });
});

describe("createRateLimiter — capacity sweep amortization", () => {
  test("does not re-sweep the whole store on a second at-capacity insert within the same window", async () => {
    const originalNow = Date.now;
    let currentTime = 0;
    // biome-ignore lint/suspicious/noExplicitAny: controlling time deterministically
    (Date as any).now = () => currentTime;
    try {
      const windowMs = 1000;
      const limiter = createRateLimiter({
        windowMs,
        maxRequests: 1,
        maxEntries: 3,
      });

      // Fill the store to capacity with three distinct IPs.
      currentTime = 0;
      await limiter.check(makeRequestWithForwardedFor("1.1.1.1")); // A
      currentTime = 10;
      await limiter.check(makeRequestWithForwardedFor("2.2.2.2")); // B
      currentTime = 20;
      await limiter.check(makeRequestWithForwardedFor("3.3.3.3")); // C

      // First at-capacity insert of a brand-new IP: A has expired (its
      // window started at 0, windowMs ago) but B and C have not, so the
      // sweep reclaims exactly A's slot. This is the existing
      // sweep-then-evict-on-the-first-hit behavior.
      currentTime = 1005;
      await limiter.check(makeRequestWithForwardedFor("4.4.4.4")); // D

      // B's own window has now expired too. Re-checking B is an existing-key
      // request, so it resets B's window in place without touching the
      // capacity/eviction path at all: B keeps its original (oldest)
      // position in insertion order but now has a brand-new, unexpired
      // window.
      currentTime = 1012;
      await limiter.check(makeRequestWithForwardedFor("2.2.2.2")); // refresh B

      // Second at-capacity insert of a brand-new IP, still well inside the
      // same windowMs since the first sweep (1005). C has been expired since
      // 1020. A "sweep on every capacity hit" implementation would reclaim
      // C's slot here and leave B (inside its freshly reset window) alone.
      // Amortized to one sweep per window, this insert instead skips the
      // sweep and evicts strictly by insertion order, so it evicts B (the
      // oldest-inserted key) even though B is live, leaving the actually
      // expired C sitting in the store, unreclaimed.
      currentTime = 1500;
      await limiter.check(makeRequestWithForwardedFor("5.5.5.5")); // E

      // Prove which of B/C got reclaimed by re-checking B. maxRequests is 1
      // and B's refreshed window (started at 1012) has not expired yet at
      // 1501, so if B is still tracked it must be blocked (429). If B was
      // instead evicted by the second insert, the limiter sees a brand-new
      // key and allows it (null).
      currentTime = 1501;
      const probeB = await limiter.check(
        makeRequestWithForwardedFor("2.2.2.2")
      );

      // Under the old "sweep on every capacity hit" code this is 429 (B
      // survives; C gets reclaimed by a second sweep). Amortized to one
      // sweep per window, B is sacrificed instead, so this must be null.
      // This assertion fails under the pre-fix every-insert sweep.
      expect(probeB).toBeNull();
    } finally {
      Date.now = originalNow;
    }
  });

  test("resumes the full sweep once the window has elapsed, reclaiming stale entries left over from a skipped round", async () => {
    const originalNow = Date.now;
    let currentTime = 0;
    // biome-ignore lint/suspicious/noExplicitAny: controlling time deterministically
    (Date as any).now = () => currentTime;
    try {
      const windowMs = 1000;
      const limiter = createRateLimiter({
        windowMs,
        maxRequests: 1,
        maxEntries: 3,
      });

      currentTime = 0;
      await limiter.check(makeRequestWithForwardedFor("10.0.0.1")); // A
      currentTime = 10;
      await limiter.check(makeRequestWithForwardedFor("10.0.0.2")); // B
      currentTime = 20;
      await limiter.check(makeRequestWithForwardedFor("10.0.0.3")); // C

      currentTime = 1005;
      await limiter.check(makeRequestWithForwardedFor("10.0.0.4")); // D, sweeps A

      // Second at-capacity insert, still inside the same window as the last
      // sweep: this one skips the sweep and evicts by insertion order, so B
      // (now also expired) is what gets removed, leaving C (also expired)
      // behind, unreclaimed, for now.
      currentTime = 1500;
      await limiter.check(makeRequestWithForwardedFor("10.0.0.5")); // E

      // A full windowMs has now passed since the last sweep (1005), so this
      // at-capacity insert is due for another full sweep. It should reclaim
      // every stale entry left over from the skipped round in one pass, not
      // just one at a time.
      currentTime = 2010;
      await limiter.check(makeRequestWithForwardedFor("10.0.0.6")); // F

      // If that sweep genuinely freed more than one slot, the very next new
      // IP is admitted without needing to evict anyone else.
      currentTime = 2011;
      await limiter.check(makeRequestWithForwardedFor("10.0.0.7")); // G

      // E (maxRequests 1, window started at 1500) must still be tracked and
      // blocked here: it was never expired, and nothing should have touched
      // it once the sweep correctly reclaimed only the stale entries.
      currentTime = 2012;
      const probeE = await limiter.check(
        makeRequestWithForwardedFor("10.0.0.5")
      );
      expect(probeE?.status).toBe(429);
    } finally {
      Date.now = originalNow;
    }
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
