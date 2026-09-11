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

// ─── Window/global mock helpers ───────────────────────────────────────────────

type WindowErrorHandler = (
  event: string | Event,
  source?: string,
  lineno?: number,
  colno?: number,
  error?: Error
) => boolean | void;

type UnhandledRejectionHandler = (event: PromiseRejectionEvent) => void;

function simulateWindowError(
  error: Error,
  source = "app.js",
  lineno = 1,
  colno = 0
) {
  const handler = (globalThis as unknown as { onerror?: WindowErrorHandler })
    .onerror;
  if (handler) {
    handler(error.message, source, lineno, colno, error);
  } else {
    // Dispatch as a real event if addEventListener was used
    const event = new ErrorEvent("error", {
      message: error.message,
      filename: source,
      lineno,
      colno,
      error,
    });
    globalThis.dispatchEvent(event);
  }
}

function simulateUnhandledRejection(reason: unknown): PromiseRejectionEvent {
  const promise = Promise.reject(reason);
  // Bun (like a browser) can independently notice this real promise was never
  // handled and treat it as an unhandled rejection of its own, separate from
  // the synthetic event dispatched below. That used to be masked by the
  // listener's unconditional `preventDefault()`; now that preventDefault is
  // gated on config.patchConsoleError, an ungated test would otherwise fail
  // the run over a promise no test code actually cares about catching.
  promise.catch(() => {});
  const event = new PromiseRejectionEvent("unhandledrejection", {
    promise,
    reason,
  });
  globalThis.dispatchEvent(event);
  return event;
}

// ─── Import target ────────────────────────────────────────────────────────────

const { initErrorTracker } = await import("../init");

// ─── initErrorTracker ─────────────────────────────────────────────────────────

describe("initErrorTracker", () => {
  beforeEach(() => {
    mockReportError.mockClear();
  });

  test("is a function", () => {
    expect(typeof initErrorTracker).toBe("function");
  });

  test("returns a cleanup function", () => {
    const cleanup = initErrorTracker(TEST_CONFIG);
    expect(typeof cleanup).toBe("function");
    cleanup();
  });

  test("cleanup function does not throw", () => {
    const cleanup = initErrorTracker(TEST_CONFIG);
    expect(() => cleanup()).not.toThrow();
  });
});

describe("initErrorTracker — unhandledrejection listener", () => {
  let cleanup: () => void;

  beforeEach(() => {
    mockReportError.mockClear();
    cleanup = initErrorTracker(TEST_CONFIG);
  });

  afterEach(() => {
    cleanup();
  });

  test("installs unhandledrejection listener that calls reportError", async () => {
    simulateUnhandledRejection(new Error("Unhandled promise rejection"));
    // Give microtask queue a tick
    await new Promise((r) => setTimeout(r, 0));
    expect(mockReportError).toHaveBeenCalledTimes(1);
  });

  test("includes error message in reportError payload for Error rejections", async () => {
    simulateUnhandledRejection(new Error("Specific unhandled error"));
    await new Promise((r) => setTimeout(r, 0));
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const [, payload] = (mockReportError.mock.calls as any[][])[0] ?? [];
    expect(payload?.message).toContain("Specific unhandled error");
  });

  test("handles non-Error rejection reasons (string)", async () => {
    simulateUnhandledRejection("string rejection reason");
    await new Promise((r) => setTimeout(r, 0));
    expect(mockReportError).toHaveBeenCalledTimes(1);
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const [, payload] = (mockReportError.mock.calls as any[][])[0] ?? [];
    // Message should be serialized to a string
    expect(typeof payload?.message).toBe("string");
    expect(payload?.message.length).toBeGreaterThan(0);
  });

  test("handles non-Error rejection reasons (object)", async () => {
    simulateUnhandledRejection({ code: "FETCH_FAILED", status: 500 });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockReportError).toHaveBeenCalledTimes(1);
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const [, payload] = (mockReportError.mock.calls as any[][])[0] ?? [];
    expect(typeof payload?.message).toBe("string");
  });

  test("handles non-Error rejection reasons (null)", async () => {
    simulateUnhandledRejection(null);
    await new Promise((r) => setTimeout(r, 0));
    expect(mockReportError).toHaveBeenCalledTimes(1);
  });

  test("removes unhandledrejection listener after cleanup", async () => {
    cleanup();
    mockReportError.mockClear();

    simulateUnhandledRejection(new Error("After cleanup"));
    await new Promise((r) => setTimeout(r, 0));

    // Should NOT have been called after cleanup
    expect(mockReportError).not.toHaveBeenCalled();

    // Re-install for afterEach
    cleanup = initErrorTracker(TEST_CONFIG);
  });
});

describe("initErrorTracker — window.onerror listener", () => {
  let cleanup: () => void;

  beforeEach(() => {
    mockReportError.mockClear();
    cleanup = initErrorTracker(TEST_CONFIG);
  });

  afterEach(() => {
    cleanup();
  });

  test("installs onerror handler that calls reportError", async () => {
    simulateWindowError(new Error("Global window error"));
    await new Promise((r) => setTimeout(r, 0));
    expect(mockReportError).toHaveBeenCalledTimes(1);
  });

  test("includes error message in reportError payload", async () => {
    simulateWindowError(new Error("Specific window onerror"));
    await new Promise((r) => setTimeout(r, 0));
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const [, payload] = (mockReportError.mock.calls as any[][])[0] ?? [];
    expect(payload?.message).toContain("Specific window onerror");
  });

  test("removes onerror handler after cleanup", async () => {
    cleanup();
    mockReportError.mockClear();

    simulateWindowError(new Error("After onerror cleanup"));
    await new Promise((r) => setTimeout(r, 0));

    expect(mockReportError).not.toHaveBeenCalled();

    // Re-install for afterEach
    cleanup = initErrorTracker(TEST_CONFIG);
  });
});

describe("initErrorTracker — existing handler chaining", () => {
  test("does not replace an existing window.onerror handler", () => {
    const originalHandler: WindowErrorHandler = mock(() => false);
    (globalThis as unknown as { onerror: WindowErrorHandler }).onerror =
      originalHandler;

    const cleanup = initErrorTracker(TEST_CONFIG);

    // After installing, the original handler reference should have been preserved
    // (it will be called alongside the new one, not discarded)
    simulateWindowError(new Error("chain test"));

    expect(originalHandler).toHaveBeenCalledTimes(1);

    cleanup();

    // Restore
    (
      globalThis as unknown as { onerror: WindowErrorHandler | undefined }
    ).onerror = undefined;
  });

  test("calls the previous onerror handler with globalThis as its receiver", () => {
    let receivedThis: unknown;
    // A non-arrow function so `this` reflects however the handler was invoked.
    function previousHandler(this: unknown) {
      receivedThis = this;
      return false;
    }
    (globalThis as unknown as { onerror: WindowErrorHandler }).onerror =
      previousHandler as unknown as WindowErrorHandler;

    const cleanup = initErrorTracker(TEST_CONFIG);
    simulateWindowError(new Error("receiver test"));
    cleanup();

    expect(receivedThis).toBe(globalThis);

    (
      globalThis as unknown as { onerror: WindowErrorHandler | undefined }
    ).onerror = undefined;
  });

  test("calls through to the previous onerror handler when one exists", async () => {
    const previousHandler = mock((..._args: unknown[]) => false);
    (globalThis as unknown as { onerror: typeof previousHandler }).onerror =
      previousHandler;

    const cleanup = initErrorTracker(TEST_CONFIG);
    mockReportError.mockClear();

    simulateWindowError(new Error("chained error"));
    await new Promise((r) => setTimeout(r, 0));

    cleanup();

    // Both our reporter and the previous handler should have been invoked
    expect(previousHandler.mock.calls.length).toBeGreaterThan(0);

    // Restore
    (
      globalThis as unknown as { onerror: typeof previousHandler | undefined }
    ).onerror = undefined;
  });
});

describe("initErrorTracker — idempotency", () => {
  test("each installed tracker reports an unhandled rejection once", async () => {
    // Two initErrorTracker calls install two independent trackers, each with
    // its own listener, so one rejection is reported twice. Nothing
    // de-duplicates: the factory's init() calls initErrorTracker
    // unconditionally, so consumers call init() once and tear that
    // installation down with the returned cleanup before calling it again.
    mockReportError.mockClear();
    const cleanup1 = initErrorTracker(TEST_CONFIG);
    const cleanup2 = initErrorTracker(TEST_CONFIG);

    simulateUnhandledRejection(new Error("idempotency check"));
    await new Promise((r) => setTimeout(r, 0));

    expect(mockReportError).toHaveBeenCalledTimes(2);

    cleanup1();
    cleanup2();
  });

  test("cleanup from first call can be invoked safely even after second init", () => {
    const cleanup1 = initErrorTracker(TEST_CONFIG);
    const cleanup2 = initErrorTracker(TEST_CONFIG);

    expect(() => {
      cleanup1();
      cleanup2();
    }).not.toThrow();
  });

  test("cleaning up in installation order leaves no live handler behind", async () => {
    const cleanup1 = initErrorTracker(TEST_CONFIG);
    const cleanup2 = initErrorTracker(TEST_CONFIG);
    cleanup1();
    cleanup2();
    mockReportError.mockClear();

    simulateWindowError(new Error("after both cleanups"));
    simulateUnhandledRejection(new Error("after both cleanups"));
    await new Promise((r) => setTimeout(r, 0));

    expect(mockReportError).not.toHaveBeenCalled();
  });

  test("cleaning up the newer tracker first keeps the older one reporting", async () => {
    const cleanup1 = initErrorTracker(TEST_CONFIG);
    const cleanup2 = initErrorTracker(TEST_CONFIG);
    cleanup2();
    mockReportError.mockClear();

    simulateWindowError(new Error("older tracker still installed"));
    await new Promise((r) => setTimeout(r, 0));

    expect(mockReportError).toHaveBeenCalledTimes(1);
    cleanup1();
  });
});

describe("initErrorTracker — config passthrough", () => {
  test("passes the full config to reportError", async () => {
    mockReportError.mockClear();
    const config: ErrorTrackerConfig = {
      endpoint: "https://custom.example.com/api/errors",
      environment: "production",
      token: "custom-token",
    };

    const cleanup = initErrorTracker(config);
    simulateUnhandledRejection(new Error("config passthrough test"));
    await new Promise((r) => setTimeout(r, 0));
    cleanup();

    expect(mockReportError).toHaveBeenCalledTimes(1);
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const [calledConfig] = (mockReportError.mock.calls as any[][])[0];
    expect(calledConfig?.endpoint).toBe(
      "https://custom.example.com/api/errors"
    );
  });
});

describe("initErrorTracker — preventDefault gating on patchConsoleError", () => {
  test("prevents the default unhandled-rejection reporting when patchConsoleError is true", async () => {
    mockReportError.mockClear();
    const cleanup = initErrorTracker({
      ...TEST_CONFIG,
      patchConsoleError: true,
    });
    const event = simulateUnhandledRejection(new Error("gated rejection"));
    await new Promise((r) => setTimeout(r, 0));

    expect(event.defaultPrevented).toBe(true);
    expect(mockReportError).toHaveBeenCalledTimes(1);
    cleanup();
  });

  test("leaves the runtime's default unhandled-rejection reporting alone when patchConsoleError is not set", async () => {
    mockReportError.mockClear();
    const cleanup = initErrorTracker(TEST_CONFIG);
    const event = simulateUnhandledRejection(new Error("ungated rejection"));
    await new Promise((r) => setTimeout(r, 0));

    expect(event.defaultPrevented).toBe(false);
    expect(mockReportError).toHaveBeenCalledTimes(1);
    cleanup();
  });
});
