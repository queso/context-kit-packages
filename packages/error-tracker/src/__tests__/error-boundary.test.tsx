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
import { render, screen } from "@testing-library/react";
import React from "react";
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

// A component that always throws during render
function ThrowingComponent({
  message = "Test render error",
}: {
  message?: string;
}): React.ReactNode {
  throw new Error(message);
}

// A component that renders normally
function SafeChild({ text = "safe content" }: { text?: string }) {
  return <div>{text}</div>;
}

// ─── Import target ────────────────────────────────────────────────────────────

const { ErrorBoundary } = await import("../error-boundary");

// ─── Suppress React error boundary console noise in tests ─────────────────────

const originalConsoleError = console.error;
beforeEach(() => {
  mockReportError.mockClear();
  // Reset in case a preceding test (e.g. "does not throw when reportError
  // fails internally") replaced the implementation and its own restore never
  // ran because an assertion before it threw.
  mockReportError.mockImplementation(() => undefined);
  // Suppress React's "The above error occurred in" noise during error boundary tests
  console.error = (...args: unknown[]) => {
    const msg = args[0];
    if (
      typeof msg === "string" &&
      (msg.includes("The above error occurred") ||
        msg.includes("Error boundaries should implement") ||
        msg.includes("act("))
    ) {
      return;
    }
    originalConsoleError(...args);
  };
});

afterEach(() => {
  // The beforeEach above replaces console.error with a filtering stub; restore
  // it so later test files see the real console.error rather than this stub.
  console.error = originalConsoleError;
});

// ─── ErrorBoundary ────────────────────────────────────────────────────────────

describe("ErrorBoundary", () => {
  test("is a function (class component)", () => {
    expect(typeof ErrorBoundary).toBe("function");
  });

  test("renders children when no error occurs", () => {
    render(
      <ErrorBoundary config={TEST_CONFIG} fallback={<div>error fallback</div>}>
        <SafeChild text="hello world" />
      </ErrorBoundary>
    );
    expect(screen.getByText("hello world")).toBeDefined();
  });

  test("renders fallback when a child throws during render", () => {
    render(
      <ErrorBoundary
        config={TEST_CONFIG}
        fallback={<div>something went wrong</div>}
      >
        <ThrowingComponent />
      </ErrorBoundary>
    );
    expect(screen.getByText("something went wrong")).toBeDefined();
  });

  test("does not render children when an error is caught", () => {
    render(
      <ErrorBoundary config={TEST_CONFIG} fallback={<div>error fallback</div>}>
        <ThrowingComponent />
      </ErrorBoundary>
    );
    // Children output should not be visible — only fallback
    expect(screen.queryByText("safe content")).toBeNull();
  });

  test("calls reportError when a child throws", () => {
    render(
      <ErrorBoundary config={TEST_CONFIG} fallback={<div>fallback</div>}>
        <ThrowingComponent message="Caught render error" />
      </ErrorBoundary>
    );
    expect(mockReportError).toHaveBeenCalledTimes(1);
  });

  test("calls reportError with the correct config", () => {
    render(
      <ErrorBoundary config={TEST_CONFIG} fallback={<div>fallback</div>}>
        <ThrowingComponent />
      </ErrorBoundary>
    );
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const [calledConfig] = (mockReportError.mock.calls as any[][])[0];
    expect(calledConfig).toMatchObject({ endpoint: TEST_CONFIG.endpoint });
  });

  test("calls reportError with the error message in payload", () => {
    render(
      <ErrorBoundary config={TEST_CONFIG} fallback={<div>fallback</div>}>
        <ThrowingComponent message="Specific render crash" />
      </ErrorBoundary>
    );
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const [, payload] = (mockReportError.mock.calls as any[][])[0];
    expect(payload?.message).toContain("Specific render crash");
  });

  test("calls reportError with componentStack in payload", () => {
    render(
      <ErrorBoundary config={TEST_CONFIG} fallback={<div>fallback</div>}>
        <ThrowingComponent />
      </ErrorBoundary>
    );
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const [, payload] = (mockReportError.mock.calls as any[][])[0];
    // componentStack comes from React's componentDidCatch info argument
    expect(payload?.componentStack).toBeDefined();
  });

  test("does not throw when reportError fails internally", () => {
    mockReportError.mockImplementation(() => {
      throw new Error("reporter internal error");
    });

    // The render itself must succeed and show the fallback — not propagate the reporter error
    expect(() => {
      render(
        <ErrorBoundary
          config={TEST_CONFIG}
          fallback={<div>fallback shown</div>}
        >
          <ThrowingComponent />
        </ErrorBoundary>
      );
    }).not.toThrow();

    screen.getByText("fallback shown");
  });
});

describe("ErrorBoundary — fallback prop variants", () => {
  test("accepts a React node as fallback", () => {
    render(
      <ErrorBoundary config={TEST_CONFIG} fallback={<p>node fallback</p>}>
        <ThrowingComponent />
      </ErrorBoundary>
    );
    expect(screen.getByText("node fallback")).toBeDefined();
  });

  test("accepts a render function as fallback", () => {
    const fallbackFn = (error: Error) => <p>error: {error.message}</p>;

    render(
      <ErrorBoundary config={TEST_CONFIG} fallback={fallbackFn}>
        <ThrowingComponent message="function fallback error" />
      </ErrorBoundary>
    );
    expect(screen.getByText(/function fallback error/)).toBeDefined();
  });

  test("render function receives the caught Error object", () => {
    let receivedError: Error | null = null;
    const fallbackFn = (error: Error) => {
      receivedError = error;
      return <p>caught</p>;
    };

    render(
      <ErrorBoundary config={TEST_CONFIG} fallback={fallbackFn}>
        <ThrowingComponent message="error passed to render fn" />
      </ErrorBoundary>
    );

    expect(receivedError).not.toBeNull();
    expect((receivedError as unknown as Error).message).toContain(
      "error passed to render fn"
    );
  });
});

describe("ErrorBoundary — props interface", () => {
  test("accepts config prop of type ErrorTrackerConfig", () => {
    // TypeScript compile check — if the props interface is wrong, this test file won't compile
    const config: ErrorTrackerConfig = {
      endpoint: "/api/errors",
      environment: "test",
    };
    expect(() => {
      render(
        <ErrorBoundary config={config} fallback={<div>ok</div>}>
          <SafeChild />
        </ErrorBoundary>
      );
    }).not.toThrow();
  });

  test("accepts optional children", () => {
    expect(() => {
      render(
        <ErrorBoundary config={TEST_CONFIG} fallback={<div>empty</div>}>
          {null}
        </ErrorBoundary>
      );
    }).not.toThrow();
  });
});
