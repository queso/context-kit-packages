import { Window } from "happy-dom";
import { afterEach } from "bun:test";

const window = new Window();
const document = window.document;

// Set globals for browser-like test environment FIRST, before any
// @testing-library imports, so screen is created with the correct document
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

// Force @testing-library/dom to initialize its `screen` object now, while
// globalThis.document is already set up. Static imports are hoisted before
// module body execution, so we must use a dynamic import here.
const { cleanup } = await import("@testing-library/react");

// Automatically cleanup @testing-library renders after each test
afterEach(() => { cleanup(); });
