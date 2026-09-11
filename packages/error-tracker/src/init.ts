import { reportError } from "./reporter.js";
import type { ErrorPayload, ErrorTrackerConfig } from "./types.js";

type WindowErrorHandler = (
  event: string | Event,
  source?: string,
  lineno?: number,
  colno?: number,
  error?: Error
) => boolean | void;

function makePayload(
  config: ErrorTrackerConfig,
  message: string,
  stack?: string
): ErrorPayload {
  return {
    message,
    stack,
    url: typeof window !== "undefined" ? window.location.href : "",
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
    environment: config.environment,
  };
}

function serializeReason(reason: unknown): { message: string; stack?: string } {
  if (reason instanceof Error) {
    return { message: reason.message, stack: reason.stack };
  }
  if (typeof reason === "string") {
    return { message: reason };
  }
  try {
    return { message: JSON.stringify(reason) ?? String(reason) };
  } catch {
    return { message: String(reason) };
  }
}

export function initErrorTracker(config: ErrorTrackerConfig): () => void {
  // Save previous onerror handler for chaining
  const g = globalThis as unknown as Record<string, unknown>;
  const previousOnError = g.onerror as WindowErrorHandler | undefined;

  // Set to false by cleanup. `window.onerror` is a single slot, so when two
  // trackers are installed and cleaned up in installation order, the second
  // cleanup restores the first handler; the flag keeps that handler inert
  // instead of reporting again.
  let active = true;

  const onError: WindowErrorHandler = (event, source, lineno, colno, error) => {
    if (!active) {
      return typeof previousOnError === "function"
        ? previousOnError.call(globalThis, event, source, lineno, colno, error)
        : false;
    }
    const message =
      error?.message ?? (typeof event === "string" ? event : "Unknown error");
    const stack = error?.stack;
    reportError(config, makePayload(config, message, stack));

    // Chain to previous handler
    if (typeof previousOnError === "function") {
      return previousOnError.call(globalThis, event, source, lineno, colno, error);
    }
    return false;
  };

  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    // Only suppress the runtime's default unhandled-rejection reporting when
    // the adopter opted into patchConsoleError. Otherwise an app that never
    // enabled it would see unhandled rejections vanish from the console.
    if (config.patchConsoleError && typeof event.preventDefault === "function") {
      event.preventDefault();
    }
    const { message, stack } = serializeReason(event.reason);
    reportError(config, makePayload(config, message, stack));
  };

  g.onerror = onError;
  globalThis.addEventListener("unhandledrejection", onUnhandledRejection);

  return () => {
    active = false;
    // Restore the previous onerror only while this handler is still the one
    // installed; a later tracker that chained on top keeps its own slot.
    if (g.onerror === onError) {
      if (typeof previousOnError === "function") {
        g.onerror = previousOnError;
      } else {
        g.onerror = undefined;
      }
    }
    globalThis.removeEventListener("unhandledrejection", onUnhandledRejection);
  };
}
