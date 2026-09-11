import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import * as reporterModule from "../reporter";
import type { ErrorTrackerConfig } from "../types";

// ─── Mock reportError ─────────────────────────────────────────────────────────

const mockReportError = mock(
  (_config: ErrorTrackerConfig, _data: unknown) => undefined
);

// Bun's `mock.module` registry is process-wide and survives across test files
// in one `bun test` run, so this stub has to be handed back before
// reporter.test.ts runs. The snapshot must be a spread copy taken before the
// stub is registered: `mock.module` rewrites an already-imported module's live
// namespace in place, so re-registering the namespace object itself would only
// reinstall the stub.
const realReporter = { ...reporterModule };

mock.module("../reporter", () => ({
  reportError: mockReportError,
}));

afterAll(() => {
  mock.module("../reporter", () => realReporter);
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TEST_CONFIG: ErrorTrackerConfig = {
  endpoint: "https://example.com/api/errors",
  environment: "test",
  token: "test-token",
};

// ─── Import target ────────────────────────────────────────────────────────────

const { patchConsoleError } = await import("../console-patch");

// ─── patchConsoleError ────────────────────────────────────────────────────────

describe("patchConsoleError", () => {
  let originalConsoleError: typeof console.error;

  beforeEach(() => {
    originalConsoleError = console.error;
    mockReportError.mockClear();
  });

  afterEach(() => {
    // Always restore to prevent test pollution
    console.error = originalConsoleError;
  });

  test("is a function", () => {
    expect(typeof patchConsoleError).toBe("function");
  });

  test("returns a restore function", () => {
    const restore = patchConsoleError(TEST_CONFIG);
    expect(typeof restore).toBe("function");
    restore();
  });

  test("restore function does not throw", () => {
    const restore = patchConsoleError(TEST_CONFIG);
    expect(() => restore()).not.toThrow();
  });

  test("wraps console.error after patching", () => {
    const before = console.error;
    const restore = patchConsoleError(TEST_CONFIG);
    // console.error should have been replaced
    expect(console.error).not.toBe(before);
    restore();
  });

  test("restores original console.error after calling restore", () => {
    const original = console.error;
    const restore = patchConsoleError(TEST_CONFIG);
    restore();
    expect(console.error).toBe(original);
  });
});

describe("patchConsoleError — calling original first", () => {
  let originalConsoleError: typeof console.error;
  let restore: () => void;

  beforeEach(() => {
    originalConsoleError = console.error;
    mockReportError.mockClear();
    restore = patchConsoleError(TEST_CONFIG);
  });

  afterEach(() => {
    restore();
    console.error = originalConsoleError;
  });

  test("calls the original console.error when patched version is invoked", () => {
    const originalCalled: unknown[][] = [];
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    console.error = (...args: any[]) => {
      originalCalled.push(args);
    };
    // Re-patch on top of our spy
    const restore2 = patchConsoleError(TEST_CONFIG);

    console.error("test original call");
    restore2();

    expect(
      originalCalled.some((args) => args[0] === "test original call")
    ).toBe(true);
  });

  test("calls original console.error BEFORE reportError", () => {
    const callOrder: string[] = [];
    const origSpy = mock((..._args: unknown[]) => {
      callOrder.push("original");
    });
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    (console as any).error = origSpy;

    mockReportError.mockImplementation(() => {
      callOrder.push("reporter");
      return undefined;
    });

    const restore2 = patchConsoleError(TEST_CONFIG);
    console.error(new Error("order test"));
    restore2();

    const originalIdx = callOrder.indexOf("original");
    const reporterIdx = callOrder.indexOf("reporter");

    expect(originalIdx).toBeGreaterThanOrEqual(0);
    expect(reporterIdx).toBeGreaterThanOrEqual(0);
    expect(originalIdx).toBeLessThan(reporterIdx);

    mockReportError.mockImplementation(() => undefined);
  });
});

describe("patchConsoleError — Error arguments", () => {
  let originalConsoleError: typeof console.error;
  let restore: () => void;

  beforeEach(() => {
    originalConsoleError = console.error;
    // Silence during tests
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    console.error = (..._args: any[]) => {};
    mockReportError.mockClear();
    restore = patchConsoleError(TEST_CONFIG);
  });

  afterEach(() => {
    restore();
    console.error = originalConsoleError;
  });

  test("calls reportError when console.error is called with an Error", () => {
    console.error(new Error("test Error arg"));
    expect(mockReportError).toHaveBeenCalledTimes(1);
  });

  test("includes error message in reportError payload for Error arg", () => {
    console.error(new Error("Error message in payload"));
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const [, payload] = (mockReportError.mock.calls as any[][])[0] ?? [];
    expect(payload?.message).toContain("Error message in payload");
  });

  test("includes stack in reportError payload when Error has a stack", () => {
    const err = new Error("stack test");
    console.error(err);
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const [, payload] = (mockReportError.mock.calls as any[][])[0] ?? [];
    expect(err.stack).toBeDefined();
    expect(payload?.stack).toBeDefined();
    expect(typeof payload.stack).toBe("string");
  });
});

describe("patchConsoleError — non-Error arguments", () => {
  let originalConsoleError: typeof console.error;
  let restore: () => void;

  beforeEach(() => {
    originalConsoleError = console.error;
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    console.error = (..._args: any[]) => {};
    mockReportError.mockClear();
    restore = patchConsoleError(TEST_CONFIG);
  });

  afterEach(() => {
    restore();
    console.error = originalConsoleError;
  });

  test("calls reportError when console.error is called with a string", () => {
    console.error("string error message");
    expect(mockReportError).toHaveBeenCalledTimes(1);
  });

  test("serializes string argument as message in payload", () => {
    console.error("plain string error");
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const [, payload] = (mockReportError.mock.calls as any[][])[0] ?? [];
    expect(typeof payload?.message).toBe("string");
    expect(payload?.message).toContain("plain string error");
  });

  test("calls reportError when console.error is called with an object", () => {
    console.error({ code: "ERR_UNKNOWN", detail: "something" });
    expect(mockReportError).toHaveBeenCalledTimes(1);
  });

  test("serializes object argument as message string in payload", () => {
    console.error({ code: "ERR_TEST" });
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const [, payload] = (mockReportError.mock.calls as any[][])[0] ?? [];
    expect(typeof payload?.message).toBe("string");
    expect(payload?.message.length).toBeGreaterThan(0);
  });

  test("calls reportError when console.error is called with multiple arguments", () => {
    console.error("prefix:", new Error("multi-arg error"));
    expect(mockReportError).toHaveBeenCalledTimes(1);
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const [, payload] = (mockReportError.mock.calls as any[][])[0] ?? [];
    expect(typeof payload?.message).toBe("string");
  });
});

describe("patchConsoleError — idempotency", () => {
  let originalConsoleError: typeof console.error;

  beforeEach(() => {
    originalConsoleError = console.error;
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    console.error = (..._args: any[]) => {};
    mockReportError.mockClear();
  });

  afterEach(() => {
    console.error = originalConsoleError;
  });

  test("patching twice and calling once does not double-report", () => {
    const restore1 = patchConsoleError(TEST_CONFIG);
    const restore2 = patchConsoleError(TEST_CONFIG);

    console.error(new Error("idempotent"));

    restore2();
    restore1();

    // The outer wrapper's original.apply reaches the inner wrapper, which
    // must see the same in-flight flag and only forward to its own original
    // instead of reporting again.
    expect(mockReportError.mock.calls.length).toBe(1);
  });

  test("calling restore twice does not throw", () => {
    const restore = patchConsoleError(TEST_CONFIG);
    expect(() => {
      restore();
      restore();
    }).not.toThrow();
  });

  test("cleaning up two patches in installation order leaves no live patch behind", () => {
    const realCalls: unknown[][] = [];
    const realConsoleError = console.error;
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    console.error = (...args: any[]) => {
      realCalls.push(args);
    };

    const restore1 = patchConsoleError(TEST_CONFIG);
    const restore2 = patchConsoleError(TEST_CONFIG);

    // Clean up in installation order: restore1 runs first, so it restores
    // console.error to patch2's wrapper. Without the per-patch active flag,
    // that surviving wrapper still reports after "both" cleanups.
    restore1();
    restore2();

    mockReportError.mockClear();
    console.error("after both cleanups");

    expect(mockReportError).not.toHaveBeenCalled();
    expect(realCalls).toEqual([["after both cleanups"]]);

    console.error = realConsoleError;
  });
});

describe("patchConsoleError — loop prevention", () => {
  let originalConsoleError: typeof console.error;
  let restore: () => void;

  beforeEach(() => {
    originalConsoleError = console.error;
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    console.error = (..._args: any[]) => {};
    mockReportError.mockClear();
    restore = patchConsoleError(TEST_CONFIG);
  });

  afterEach(() => {
    restore();
    console.error = originalConsoleError;
  });

  test("does not infinitely recurse if reportError internally calls console.error", () => {
    // Simulate reportError calling console.error (which would cause a loop without prevention)
    mockReportError.mockImplementation(() => {
      // This should be detected as a loop and skipped
      console.error("internal reporter log");
      return undefined;
    });

    // Should complete without stack overflow
    expect(() => {
      console.error(new Error("loop prevention test"));
    }).not.toThrow();

    mockReportError.mockImplementation(() => undefined);
  });
});
