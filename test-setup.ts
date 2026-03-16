/**
 * Root-level test preload for the monorepo.
 * Runs before every test file when using `bun test <path>` from the repo root.
 *
 * Sets up happy-dom globals and polyfills needed by packages that test
 * browser/React code (error-tracker, billing-ui, auth-ui).
 */
import { afterEach } from "bun:test";

// Save native Event types before happy-dom potentially overwrites them
const NativeEvent = globalThis.Event;
const NativeErrorEvent = globalThis.ErrorEvent;

// Set up happy-dom browser globals
const { Window } = await import("happy-dom");
const happyWindow = new Window();
const happyDocument = happyWindow.document;

Object.defineProperty(globalThis, "window", {
  value: happyWindow,
  writable: true,
  configurable: true,
});
Object.defineProperty(globalThis, "document", {
  value: happyDocument,
  writable: true,
  configurable: true,
});
Object.defineProperty(globalThis, "navigator", {
  value: happyWindow.navigator,
  writable: true,
  configurable: true,
});
Object.defineProperty(globalThis, "location", {
  value: happyWindow.location,
  writable: true,
  configurable: true,
});
Object.defineProperty(globalThis, "history", {
  value: happyWindow.history,
  writable: true,
  configurable: true,
});
Object.defineProperty(globalThis, "HTMLElement", {
  value: happyWindow.HTMLElement,
  writable: true,
  configurable: true,
});
Object.defineProperty(globalThis, "Element", {
  value: happyWindow.Element,
  writable: true,
  configurable: true,
});
Object.defineProperty(globalThis, "Node", {
  value: happyWindow.Node,
  writable: true,
  configurable: true,
});
Object.defineProperty(globalThis, "Event", {
  value: happyWindow.Event,
  writable: true,
  configurable: true,
});
Object.defineProperty(globalThis, "CustomEvent", {
  value: happyWindow.CustomEvent,
  writable: true,
  configurable: true,
});
// Keep native ErrorEvent so bun's dispatchEvent accepts instances
Object.defineProperty(globalThis, "ErrorEvent", {
  value: NativeErrorEvent ?? happyWindow.ErrorEvent,
  writable: true,
  configurable: true,
});

// Polyfill PromiseRejectionEvent using the native Event class so bun's
// dispatchEvent accepts instances (happy-dom doesn't provide this).
if (
  typeof (globalThis as unknown as Record<string, unknown>)
    .PromiseRejectionEvent === "undefined"
) {
  class PromiseRejectionEvent extends NativeEvent {
    promise: Promise<unknown>;
    reason: unknown;
    constructor(
      type: string,
      init: { promise: Promise<unknown>; reason: unknown; cancelable?: boolean }
    ) {
      super(type, { cancelable: init.cancelable ?? true });
      this.promise = init.promise;
      this.reason = init.reason;
      // Suppress bun's unhandled-rejection crash for the injected promise
      if (init.promise && typeof init.promise.catch === "function") {
        init.promise.catch(() => {});
      }
    }
  }
  Object.defineProperty(globalThis, "PromiseRejectionEvent", {
    value: PromiseRejectionEvent,
    writable: true,
    configurable: true,
  });
}

// Auto-cleanup @testing-library/react renders after each test (no-op if not used)
try {
  const { cleanup } = await import("@testing-library/react");
  afterEach(() => cleanup());
} catch {
  // @testing-library/react not available in this package — skip cleanup
}
