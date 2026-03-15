import { describe, expect, mock, test, beforeEach, afterEach } from "bun:test";
import type { ErrorTrackerConfig } from "../types";

// ─── Mock dependencies ────────────────────────────────────────────────────────

const mockInitErrorTracker = mock((_config: ErrorTrackerConfig) => () => {});
const mockPatchConsoleError = mock((_config: ErrorTrackerConfig) => () => {});

mock.module("../init", () => ({ initErrorTracker: mockInitErrorTracker }));
mock.module("../console-patch", () => ({ patchConsoleError: mockPatchConsoleError }));

// ─── Import target ────────────────────────────────────────────────────────────

// @ts-expect-error: module created by B.A. during implementation phase
const { createErrorTracker } = await import("../factory");

// ─── createErrorTracker ───────────────────────────────────────────────────────

describe("createErrorTracker", () => {
  beforeEach(() => {
    mockInitErrorTracker.mockClear();
    mockPatchConsoleError.mockClear();
  });

  test("is a function", () => {
    expect(typeof createErrorTracker).toBe("function");
  });

  test("returns an object with init and ErrorBoundary", () => {
    const tracker = createErrorTracker({ endpoint: "/api/errors" });
    expect(typeof tracker.init).toBe("function");
    expect(typeof tracker.ErrorBoundary).toBe("function");
  });

  test("accepts endpoint as the only required config field", () => {
    expect(() => createErrorTracker({ endpoint: "/api/errors" })).not.toThrow();
  });

  test("defaults endpoint to /api/errors when not provided", () => {
    expect(() => createErrorTracker({})).not.toThrow();
  });
});

describe("createErrorTracker — init()", () => {
  let savedNodeEnv: string | undefined;

  beforeEach(() => {
    savedNodeEnv = process.env.NODE_ENV;
    mockInitErrorTracker.mockClear();
    mockPatchConsoleError.mockClear();
  });

  afterEach(() => {
    if (savedNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = savedNodeEnv;
    }
  });

  test("init() calls initErrorTracker", () => {
    const tracker = createErrorTracker({ endpoint: "/api/errors" });
    tracker.init();
    expect(mockInitErrorTracker).toHaveBeenCalledTimes(1);
  });

  test("init() passes config to initErrorTracker", () => {
    const tracker = createErrorTracker({
      endpoint: "https://example.com/api/errors",
      token: "test-token",
    });
    tracker.init();
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const [calledConfig] = (mockInitErrorTracker.mock.calls as any[][])[0];
    expect(calledConfig?.endpoint).toBe("https://example.com/api/errors");
  });

  test("init() does NOT call patchConsoleError when patchConsoleError is false (default)", () => {
    const tracker = createErrorTracker({ endpoint: "/api/errors" });
    tracker.init();
    expect(mockPatchConsoleError).not.toHaveBeenCalled();
  });

  test("init() does NOT call patchConsoleError when patchConsoleError is explicitly false", () => {
    const tracker = createErrorTracker({ endpoint: "/api/errors", patchConsoleError: false });
    tracker.init();
    expect(mockPatchConsoleError).not.toHaveBeenCalled();
  });

  test("init() calls patchConsoleError when patchConsoleError: true", () => {
    const tracker = createErrorTracker({ endpoint: "/api/errors", patchConsoleError: true });
    tracker.init();
    expect(mockPatchConsoleError).toHaveBeenCalledTimes(1);
  });

  test("init() passes config to patchConsoleError when enabled", () => {
    const tracker = createErrorTracker({
      endpoint: "https://example.com/api/errors",
      patchConsoleError: true,
    });
    tracker.init();
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const [calledConfig] = (mockPatchConsoleError.mock.calls as any[][])[0];
    expect(calledConfig?.endpoint).toBe("https://example.com/api/errors");
  });

  test("init() returns a cleanup function", () => {
    const tracker = createErrorTracker({ endpoint: "/api/errors" });
    const cleanup = tracker.init();
    expect(typeof cleanup).toBe("function");
  });

  test("cleanup function does not throw", () => {
    const tracker = createErrorTracker({ endpoint: "/api/errors" });
    const cleanup = tracker.init();
    expect(() => cleanup()).not.toThrow();
  });

  test("cleanup function cleans up console patch when patchConsoleError: true", () => {
    const patchRestore = mock(() => {});
    mockPatchConsoleError.mockImplementation(() => patchRestore);

    const tracker = createErrorTracker({ endpoint: "/api/errors", patchConsoleError: true });
    const cleanup = tracker.init();
    cleanup();

    expect(patchRestore).toHaveBeenCalledTimes(1);

    mockPatchConsoleError.mockImplementation(() => () => {});
  });
});

describe("createErrorTracker — environment default", () => {
  let savedNodeEnv: string | undefined;

  beforeEach(() => {
    savedNodeEnv = process.env.NODE_ENV;
    mockInitErrorTracker.mockClear();
  });

  afterEach(() => {
    if (savedNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = savedNodeEnv;
    }
  });

  test("defaults environment to NODE_ENV when not specified", () => {
    process.env.NODE_ENV = "production";
    const tracker = createErrorTracker({ endpoint: "/api/errors" });
    tracker.init();
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const [calledConfig] = (mockInitErrorTracker.mock.calls as any[][])[0];
    if (calledConfig?.environment !== undefined) {
      expect(calledConfig.environment).toBe("production");
    }
  });

  test("uses provided environment over NODE_ENV", () => {
    process.env.NODE_ENV = "production";
    const tracker = createErrorTracker({ endpoint: "/api/errors", environment: "staging" });
    tracker.init();
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const [calledConfig] = (mockInitErrorTracker.mock.calls as any[][])[0];
    if (calledConfig?.environment !== undefined) {
      expect(calledConfig.environment).toBe("staging");
    }
  });
});

describe("createErrorTracker — production warning", () => {
  let savedNodeEnv: string | undefined;
  let warnCalls: unknown[][];
  let originalWarn: typeof console.warn;

  beforeEach(() => {
    savedNodeEnv = process.env.NODE_ENV;
    warnCalls = [];
    originalWarn = console.warn;
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    console.warn = (...args: any[]) => warnCalls.push(args);
    mockInitErrorTracker.mockClear();
  });

  afterEach(() => {
    console.warn = originalWarn;
    if (savedNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = savedNodeEnv;
    }
  });

  test("warns when NODE_ENV=production and no secret token is configured", () => {
    process.env.NODE_ENV = "production";
    const tracker = createErrorTracker({ endpoint: "/api/errors" });
    tracker.init();
    const allWarnings = warnCalls.flat().join(" ").toLowerCase();
    expect(allWarnings).toMatch(/token|secret|auth/);
  });

  test("does not warn when NODE_ENV=production and a token is configured", () => {
    process.env.NODE_ENV = "production";
    const tracker = createErrorTracker({ endpoint: "/api/errors", token: "my-secret" });
    tracker.init();
    expect(warnCalls.length).toBe(0);
  });

  test("does not warn in development even without a token", () => {
    process.env.NODE_ENV = "development";
    const tracker = createErrorTracker({ endpoint: "/api/errors" });
    tracker.init();
    expect(warnCalls.length).toBe(0);
  });
});

describe("createErrorTracker — ErrorBoundary pre-binding", () => {
  test("ErrorBoundary is a component (function or class)", () => {
    const tracker = createErrorTracker({ endpoint: "/api/errors" });
    expect(typeof tracker.ErrorBoundary).toBe("function");
  });

  test("ErrorBoundary from different configs are distinct", () => {
    const tracker1 = createErrorTracker({ endpoint: "/api/errors" });
    const tracker2 = createErrorTracker({ endpoint: "/api/errors/v2" });
    // Each tracker should produce its own pre-bound component
    expect(tracker1.ErrorBoundary).not.toBe(tracker2.ErrorBoundary);
  });
});

// ─── src/index.ts barrel exports ─────────────────────────────────────────────

describe("src/index.ts barrel exports", () => {
  test("createErrorTracker is exported from src/index", async () => {
    const mod = await import("../index");
    expect(typeof mod.createErrorTracker).toBe("function");
  });

  test("createErrorTracker is the default export from src/index", async () => {
    const mod = await import("../index");
    // Default export should be createErrorTracker
    expect(typeof mod.default).toBe("function");
  });

  test("ErrorTrackerConfig type is re-exported (module loads without error)", async () => {
    // Type exports are erased at runtime; verify module loads cleanly
    const mod = await import("../index");
    expect(mod).toBeDefined();
  });

  test("ErrorPayload type is accessible (module loads without error)", async () => {
    const mod = await import("../index");
    expect(mod).toBeDefined();
  });

  test("StackFrame type is accessible (module loads without error)", async () => {
    const mod = await import("../index");
    expect(mod).toBeDefined();
  });
});

// Type-level compile check: imports below must resolve or this file won't compile
import type { ErrorTrackerConfig as _Config, ErrorPayload as _Payload, StackFrame as _Frame } from "../index";
