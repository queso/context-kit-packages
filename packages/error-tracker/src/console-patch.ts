import { reportError } from "./reporter.js";
import type { ErrorPayload, ErrorTrackerConfig } from "./types.js";

// Safe without synchronization: JS is single-threaded, and reportError (called below)
// uses fire-and-forget fetch — the flag is set/cleared synchronously within one turn.
let _isReporting = false;

function makePayload(
  config: ErrorTrackerConfig,
  args: unknown[]
): ErrorPayload {
  // Find the first Error in args, or stringify all args
  const firstError = args.find((a): a is Error => a instanceof Error);

  let message: string;
  let stack: string | undefined;

  if (firstError) {
    // If there's a non-Error prefix before it, include it
    const prefix = args
      .slice(0, args.indexOf(firstError))
      .map((a) => String(a))
      .join(" ");
    message = prefix ? `${prefix} ${firstError.message}` : firstError.message;
    stack = firstError.stack;
  } else {
    message = args
      .map((a) => {
        if (typeof a === "string") return a;
        try {
          return JSON.stringify(a) ?? String(a);
        } catch {
          return String(a);
        }
      })
      .join(" ");
  }

  return {
    message,
    stack,
    url: typeof window !== "undefined" ? window.location.href : "",
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
    environment: config.environment,
  };
}

export function patchConsoleError(config: ErrorTrackerConfig): () => void {
  const original = console.error;

  // Cleared by the returned cleanup function. When two patches are installed
  // and cleaned up in installation order, the second cleanup restores
  // console.error to the first patch's wrapper (see the `active` check
  // below); without this flag that surviving wrapper would keep reporting.
  let active = true;

  // biome-ignore lint/suspicious/noExplicitAny: wrapping console.error
  const patched = (...args: any[]) => {
    // Inactive (cleaned up) or nested inside another active wrapper's call:
    // only forward to this patch's own original, never report.
    if (!active || _isReporting) {
      original.apply(console, args);
      return;
    }

    // Hold the flag for the whole call, including original.apply below, so a
    // nested wrapper (installed on top of this one) sees it and only
    // forwards instead of reporting a second time for the same call.
    _isReporting = true;
    try {
      original.apply(console, args);
      reportError(config, makePayload(config, args));
    } finally {
      _isReporting = false;
    }
  };

  console.error = patched;

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    active = false;
    if (console.error === patched) {
      console.error = original;
    }
  };
}
