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
    return { message: JSON.stringify(reason) };
  } catch {
    return { message: String(reason) };
  }
}

export function initErrorTracker(config: ErrorTrackerConfig): () => void {
  // Save previous onerror handler for chaining
  const g = globalThis as unknown as Record<string, unknown>;
  const previousOnError = g.onerror as WindowErrorHandler | undefined;

  const onError: WindowErrorHandler = (event, source, lineno, colno, error) => {
    const message =
      error?.message ?? (typeof event === "string" ? event : "Unknown error");
    const stack = error?.stack;
    reportError(config, makePayload(config, message, stack));

    // Chain to previous handler
    if (typeof previousOnError === "function") {
      return previousOnError(event, source, lineno, colno, error);
    }
    return false;
  };

  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    // Prevent bun/browser from logging the unhandled rejection as an error
    if (typeof event.preventDefault === "function") {
      event.preventDefault();
    }
    const { message, stack } = serializeReason(event.reason);
    reportError(config, makePayload(config, message, stack));
  };

  g.onerror = onError;
  globalThis.addEventListener("unhandledrejection", onUnhandledRejection);

  return () => {
    // Restore previous onerror
    if (typeof previousOnError === "function") {
      g.onerror = previousOnError;
    } else {
      g.onerror = undefined;
    }
    globalThis.removeEventListener("unhandledrejection", onUnhandledRejection);
  };
}
