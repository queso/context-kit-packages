import type { ErrorTrackerConfig, ErrorPayload } from "./types.js";
import { reportError } from "./reporter.js";

// Safe without synchronization: JS is single-threaded, and reportError (called below)
// uses fire-and-forget fetch — the flag is set/cleared synchronously within one turn.
let _isReporting = false;

function makePayload(config: ErrorTrackerConfig, args: unknown[]): ErrorPayload {
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
          return JSON.stringify(a);
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

  // biome-ignore lint/suspicious/noExplicitAny: wrapping console.error
  const patched = (...args: any[]) => {
    // Call original first
    original.apply(console, args);

    // Loop prevention: skip if we're already inside reportError
    if (_isReporting) return;
    _isReporting = true;
    try {
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
    if (console.error === patched) {
      console.error = original;
    }
  };
}
