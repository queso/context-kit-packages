import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ErrorPayload, ErrorTrackerConfig } from "../types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(
  overrides: Partial<ErrorTrackerConfig> = {}
): ErrorTrackerConfig {
  return {
    endpoint: "https://example.com/api/errors",
    environment: "test",
    ...overrides,
  };
}

function makePayload(overrides: Partial<ErrorPayload> = {}): ErrorPayload {
  return {
    message: "TypeError: Cannot read properties of undefined",
    stack:
      "TypeError: Cannot read...\n  at Component (app.js:1:100)\n  at App (app.js:2:200)",
    url: "https://example.com/dashboard",
    userAgent: "Mozilla/5.0",
    environment: "test",
    ...overrides,
  };
}

// ─── fetch mock infrastructure ────────────────────────────────────────────────

type FetchCall = {
  url: string;
  init?: RequestInit;
};

function mockGlobalFetch(): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  (globalThis as any).fetch = (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify({ success: true }), { status: 200 })
    );
  };
  return {
    calls,
    restore: () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      (globalThis as any).fetch = originalFetch;
    },
  };
}

function mockFetchReject(): { restore: () => void } {
  const originalFetch = globalThis.fetch;
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  (globalThis as any).fetch = (_url: string, _init?: RequestInit) => {
    return Promise.reject(new Error("Network error"));
  };
  return {
    restore: () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      (globalThis as any).fetch = originalFetch;
    },
  };
}

// ─── Import target ────────────────────────────────────────────────────────────

const { reportError } = await import("../reporter");

// ─── reportError ──────────────────────────────────────────────────────────────

describe("reportError", () => {
  test("is a function", () => {
    expect(typeof reportError).toBe("function");
  });

  test("does not return a promise (fire-and-forget)", () => {
    const fetchMock = mockGlobalFetch();
    try {
      const result = reportError(makeConfig(), makePayload());
      // Fire-and-forget: must not return a promise
      expect(result).toBeUndefined();
    } finally {
      fetchMock.restore();
    }
  });

  test("calls fetch with the configured endpoint URL", async () => {
    const fetchMock = mockGlobalFetch();
    try {
      reportError(
        makeConfig({ endpoint: "https://example.com/api/errors" }),
        makePayload()
      );
      // Give the microtask queue a tick to flush
      await new Promise((r) => setTimeout(r, 0));
      expect(fetchMock.calls.length).toBeGreaterThanOrEqual(1);
      expect(fetchMock.calls[0].url).toBe("https://example.com/api/errors");
    } finally {
      fetchMock.restore();
    }
  });

  test("sends a POST request", async () => {
    const fetchMock = mockGlobalFetch();
    try {
      reportError(makeConfig(), makePayload());
      await new Promise((r) => setTimeout(r, 0));
      expect(fetchMock.calls[0].init?.method).toBe("POST");
    } finally {
      fetchMock.restore();
    }
  });

  test("sends Content-Type: application/json", async () => {
    const fetchMock = mockGlobalFetch();
    try {
      reportError(makeConfig(), makePayload());
      await new Promise((r) => setTimeout(r, 0));
      const headers = fetchMock.calls[0].init?.headers as Record<
        string,
        string
      >;
      expect(headers?.["content-type"] ?? headers?.["Content-Type"]).toContain(
        "application/json"
      );
    } finally {
      fetchMock.restore();
    }
  });

  test("payload body includes message field", async () => {
    const fetchMock = mockGlobalFetch();
    try {
      reportError(makeConfig(), makePayload({ message: "Test error message" }));
      await new Promise((r) => setTimeout(r, 0));
      const body = JSON.parse(fetchMock.calls[0].init?.body as string);
      expect(body.message).toBe("Test error message");
    } finally {
      fetchMock.restore();
    }
  });

  test("payload body includes stack field", async () => {
    const fetchMock = mockGlobalFetch();
    try {
      reportError(
        makeConfig(),
        makePayload({ stack: "Error\n  at app.js:1:1" })
      );
      await new Promise((r) => setTimeout(r, 0));
      const body = JSON.parse(fetchMock.calls[0].init?.body as string);
      expect(typeof body.stack).toBe("string");
    } finally {
      fetchMock.restore();
    }
  });

  test("payload body includes url field", async () => {
    const fetchMock = mockGlobalFetch();
    try {
      reportError(
        makeConfig(),
        makePayload({ url: "https://example.com/page" })
      );
      await new Promise((r) => setTimeout(r, 0));
      const body = JSON.parse(fetchMock.calls[0].init?.body as string);
      expect(body.url).toBe("https://example.com/page");
    } finally {
      fetchMock.restore();
    }
  });

  test("payload body includes userAgent field", async () => {
    const fetchMock = mockGlobalFetch();
    try {
      reportError(makeConfig(), makePayload({ userAgent: "TestAgent/1.0" }));
      await new Promise((r) => setTimeout(r, 0));
      const body = JSON.parse(fetchMock.calls[0].init?.body as string);
      expect(body.userAgent).toBe("TestAgent/1.0");
    } finally {
      fetchMock.restore();
    }
  });

  test("payload body includes timestamp field", async () => {
    const fetchMock = mockGlobalFetch();
    try {
      reportError(makeConfig(), makePayload());
      await new Promise((r) => setTimeout(r, 0));
      const body = JSON.parse(fetchMock.calls[0].init?.body as string);
      expect(body.timestamp).toBeDefined();
      // timestamp should be a valid ISO string or number
      const ts =
        typeof body.timestamp === "string"
          ? new Date(body.timestamp).getTime()
          : body.timestamp;
      expect(isNaN(ts)).toBe(false);
    } finally {
      fetchMock.restore();
    }
  });

  test("payload body includes componentStack when provided", async () => {
    const fetchMock = mockGlobalFetch();
    try {
      reportError(
        makeConfig(),
        makePayload({ componentStack: "\n  at ErrorBoundary\n  at App" })
      );
      await new Promise((r) => setTimeout(r, 0));
      const body = JSON.parse(fetchMock.calls[0].init?.body as string);
      expect(body.componentStack).toBeDefined();
    } finally {
      fetchMock.restore();
    }
  });

  test("payload body omits or leaves undefined componentStack when not provided", async () => {
    const fetchMock = mockGlobalFetch();
    try {
      const payload = makePayload();
      delete payload.componentStack;
      reportError(makeConfig(), payload);
      await new Promise((r) => setTimeout(r, 0));
      const body = JSON.parse(fetchMock.calls[0].init?.body as string);
      // componentStack should be absent or undefined/null when not provided
      expect(body.componentStack ?? null).toBeNull();
    } finally {
      fetchMock.restore();
    }
  });

  test("includes secret header token when configured", async () => {
    const fetchMock = mockGlobalFetch();
    try {
      reportError(
        makeConfig({
          token: "my-secret-token",
          secretHeaderName: "x-error-token",
        }),
        makePayload()
      );
      await new Promise((r) => setTimeout(r, 0));
      const headers = fetchMock.calls[0].init?.headers as Record<
        string,
        string
      >;
      expect(headers?.["x-error-token"]).toBe("my-secret-token");
    } finally {
      fetchMock.restore();
    }
  });

  test("does not include secret header when token is not configured", async () => {
    const fetchMock = mockGlobalFetch();
    try {
      reportError(makeConfig({ token: undefined }), makePayload());
      await new Promise((r) => setTimeout(r, 0));
      const headers = fetchMock.calls[0].init?.headers as Record<
        string,
        string
      >;
      // Should not have any auth-style header with a secret value
      const headerValues = Object.values(headers ?? {});
      expect(headerValues.some((v) => v === "my-secret-token")).toBe(false);
    } finally {
      fetchMock.restore();
    }
  });

  test("does not throw when fetch rejects (fire-and-forget error swallowing)", async () => {
    const rejectMock = mockFetchReject();
    try {
      // This must NOT throw — errors are swallowed
      expect(() => reportError(makeConfig(), makePayload())).not.toThrow();
      await new Promise((r) => setTimeout(r, 10));
      // If we reach here without an unhandled rejection crashing the process, the test passes
    } finally {
      rejectMock.restore();
    }
  });

  test("truncates stack strings longer than 10,000 characters", async () => {
    const fetchMock = mockGlobalFetch();
    const longStack = "Error\n" + "  at fn (app.js:1:1)\n".repeat(500); // well over 10k chars
    try {
      reportError(makeConfig(), makePayload({ stack: longStack }));
      await new Promise((r) => setTimeout(r, 0));
      const body = JSON.parse(fetchMock.calls[0].init?.body as string);
      expect(body.stack.length).toBeLessThanOrEqual(10_000);
    } finally {
      fetchMock.restore();
    }
  });

  test("truncates componentStack strings longer than 10,000 characters", async () => {
    const fetchMock = mockGlobalFetch();
    const longComponentStack = "\n  at Component\n".repeat(700); // well over 10k chars
    try {
      reportError(
        makeConfig(),
        makePayload({ componentStack: longComponentStack })
      );
      await new Promise((r) => setTimeout(r, 0));
      const body = JSON.parse(fetchMock.calls[0].init?.body as string);
      expect(body.componentStack).toBeDefined();
      expect(body.componentStack.length).toBeLessThanOrEqual(10_000);
    } finally {
      fetchMock.restore();
    }
  });
});

describe("reportError — fetch timeout", () => {
  test("passes a signal that is an unaborted AbortSignal", async () => {
    const fetchMock = mockGlobalFetch();
    try {
      reportError(makeConfig(), makePayload());
      await new Promise((r) => setTimeout(r, 0));
      const signal = fetchMock.calls[0].init?.signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect((signal as AbortSignal).aborted).toBe(false);
    } finally {
      fetchMock.restore();
    }
  });

  test("still reports when AbortSignal.timeout is unavailable", async () => {
    const fetchMock = mockGlobalFetch();
    const originalTimeout = AbortSignal.timeout;
    // biome-ignore lint/suspicious/noExplicitAny: simulating an older environment
    (AbortSignal as any).timeout = undefined;
    try {
      expect(() => reportError(makeConfig(), makePayload())).not.toThrow();
      await new Promise((r) => setTimeout(r, 0));
      expect(fetchMock.calls.length).toBe(1);
      expect(fetchMock.calls[0].init?.signal).toBeUndefined();
    } finally {
      AbortSignal.timeout = originalTimeout;
      fetchMock.restore();
    }
  });
});

describe("loop prevention", () => {
  test("skips reporting when stack contains error-tracker module path", async () => {
    const fetchMock = mockGlobalFetch();
    try {
      // Simulate an error whose stack trace contains the error-tracker module path
      const selfReferentialStack =
        "Error: loop\n  at reportError (/node_modules/@context-kit/error-tracker/dist/reporter.js:10:5)\n  at handler (app.js:5:3)";
      reportError(makeConfig(), makePayload({ stack: selfReferentialStack }));
      await new Promise((r) => setTimeout(r, 0));
      // fetch should NOT have been called — loop prevention skipped the report
      expect(fetchMock.calls.length).toBe(0);
    } finally {
      fetchMock.restore();
    }
  });

  test("does not skip reporting for normal errors with no self-referential stack", async () => {
    const fetchMock = mockGlobalFetch();
    try {
      reportError(makeConfig(), makePayload());
      await new Promise((r) => setTimeout(r, 0));
      expect(fetchMock.calls.length).toBe(1);
    } finally {
      fetchMock.restore();
    }
  });
});
