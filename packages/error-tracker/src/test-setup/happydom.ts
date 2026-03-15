import { afterEach } from "bun:test";
import { Window } from "happy-dom";

// Save native Event and ErrorEvent before happy-dom overwrites them
const NativeEvent = globalThis.Event;
const NativeErrorEvent = globalThis.ErrorEvent;

const window = new Window();
const document = window.document;

Object.defineProperty(globalThis, "window", { value: window, writable: true });
Object.defineProperty(globalThis, "document", { value: document, writable: true });
Object.defineProperty(globalThis, "navigator", { value: window.navigator, writable: true });
Object.defineProperty(globalThis, "location", { value: window.location, writable: true });
Object.defineProperty(globalThis, "history", { value: window.history, writable: true });
Object.defineProperty(globalThis, "HTMLElement", { value: window.HTMLElement, writable: true });
Object.defineProperty(globalThis, "Element", { value: window.Element, writable: true });
Object.defineProperty(globalThis, "Node", { value: window.Node, writable: true });
Object.defineProperty(globalThis, "Event", { value: window.Event, writable: true });
Object.defineProperty(globalThis, "CustomEvent", { value: window.CustomEvent, writable: true });
// Keep native ErrorEvent so bun's dispatchEvent accepts it
Object.defineProperty(globalThis, "ErrorEvent", { value: NativeErrorEvent ?? window.ErrorEvent, writable: true });

// Polyfill PromiseRejectionEvent using the NATIVE Event so bun's dispatchEvent accepts it
if (typeof (globalThis as unknown as Record<string, unknown>).PromiseRejectionEvent === "undefined") {
  class PromiseRejectionEvent extends NativeEvent {
    promise: Promise<unknown>;
    reason: unknown;
    constructor(type: string, init: { promise: Promise<unknown>; reason: unknown; cancelable?: boolean }) {
      super(type, { cancelable: init.cancelable ?? true });
      this.promise = init.promise;
      this.reason = init.reason;
      // Suppress bun's unhandled-rejection crash for the promise passed in
      // (the test creates Promise.reject(reason) which bun would crash on otherwise)
      if (init.promise && typeof init.promise.catch === "function") {
        init.promise.catch(() => {});
      }
    }
  }
  Object.defineProperty(globalThis, "PromiseRejectionEvent", {
    value: PromiseRejectionEvent,
    writable: true,
  });
}

const { cleanup } = await import("@testing-library/react");

afterEach(() => {
  cleanup();
});
