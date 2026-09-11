import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import * as consolePatchModule from "../console-patch";
import * as initModule from "../init";
import type { ErrorTrackerConfig } from "../types";

// ─── Mock dependencies ────────────────────────────────────────────────────────

// Bun's `mock.module` registry is process-wide and survives across test files in
// one `bun test` run, so these stubs have to be handed back before init.test.ts
// and console-patch.test.ts run. The snapshots must be spread copies taken
// before the stubs are registered: `mock.module` rewrites an already-imported
// module's live namespace in place, so re-registering the namespace object
// itself would only reinstall the stub.
const realInit = { ...initModule };
const realConsolePatch = { ...consolePatchModule };

const mockInitErrorTracker = mock((_config: ErrorTrackerConfig) => () => {});
const mockPatchConsoleError = mock((_config: ErrorTrackerConfig) => () => {});

mock.module("../init", () => ({ initErrorTracker: mockInitErrorTracker }));
mock.module("../console-patch", () => ({
  patchConsoleError: mockPatchConsoleError,
}));

afterAll(() => {
  mock.module("../init", () => realInit);
  mock.module("../console-patch", () => realConsolePatch);
});

// ─── Import target ────────────────────────────────────────────────────────────

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
    const tracker = createErrorTracker({});
    tracker.init();
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const [calledConfig] = (mockInitErrorTracker.mock.calls as any[][])[0];
    expect(calledConfig?.endpoint).toBe("/api/errors");
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
    const tracker = createErrorTracker({
      endpoint: "/api/errors",
      patchConsoleError: false,
    });
    tracker.init();
    expect(mockPatchConsoleError).not.toHaveBeenCalled();
  });

  test("init() calls patchConsoleError when patchConsoleError: true", () => {
    const tracker = createErrorTracker({
      endpoint: "/api/errors",
      patchConsoleError: true,
    });
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

    const tracker = createErrorTracker({
      endpoint: "/api/errors",
      patchConsoleError: true,
    });
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
    expect(calledConfig?.environment).toBe("production");
  });

  test("uses provided environment over NODE_ENV", () => {
    process.env.NODE_ENV = "production";
    const tracker = createErrorTracker({
      endpoint: "/api/errors",
      environment: "staging",
    });
    tracker.init();
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const [calledConfig] = (mockInitErrorTracker.mock.calls as any[][])[0];
    expect(calledConfig?.environment).toBe("staging");
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
    expect(allWarnings).toContain("no token configured");
  });

  test("does not warn when NODE_ENV=production and a token is configured", () => {
    process.env.NODE_ENV = "production";
    const tracker = createErrorTracker({
      endpoint: "/api/errors",
      token: "my-secret",
    });
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

  test("the module's runtime export keys are exactly the expected set", async () => {
    // `ErrorTrackerConfig`, `ErrorPayload` and `StackFrame` are type-only
    // exports: erased at compile time, so there is nothing of them left to
    // assert on at runtime (the compile check below stands in for those).
    // What *can* be checked here is the full set of runtime exports, so an
    // export silently added or dropped from src/index.ts fails this test.
    const mod = await import("../index");
    expect(Object.keys(mod).sort()).toEqual(
      ["ErrorBoundary", "createErrorTracker", "default"].sort()
    );
  });
});

// Type-level compile check: imports below must resolve or this file won't compile
import type {
  ErrorTrackerConfig as _Config,
  StackFrame as _Frame,
  ErrorPayload as _Payload,
} from "../index";
