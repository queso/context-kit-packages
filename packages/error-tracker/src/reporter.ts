import type { ErrorPayload, ErrorTrackerConfig } from "./types.js";

const MAX_STACK_LENGTH = 10_000;
const LOOP_GUARD = "@context-kit/error-tracker";
const REPORT_TIMEOUT_MS = 5_000;

function truncate(str: string): string {
  return str.length > MAX_STACK_LENGTH ? str.slice(0, MAX_STACK_LENGTH) : str;
}

/**
 * Sends an error report to the configured endpoint.
 *
 * Fire-and-forget: the underlying POST is not awaited and attaches its own
 * rejection handler, so this function never throws and never returns a
 * promise. Callers must not await it or attach a `.catch` of their own;
 * there is nothing to await or catch.
 */
export function reportError(
  config: ErrorTrackerConfig,
  data: ErrorPayload
): void {
  // Loop prevention: skip if the stack references the error-tracker itself
  if (data.stack && data.stack.includes(LOOP_GUARD)) {
    return;
  }

  const body: Record<string, unknown> = {
    message: data.message,
    url: data.url,
    userAgent: data.userAgent,
    environment: data.environment,
    timestamp: new Date().toISOString(),
  };

  if (data.stack !== undefined) {
    body.stack = truncate(data.stack);
  }

  if (data.componentStack !== undefined) {
    body.componentStack = truncate(data.componentStack);
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (config.token && config.secretHeaderName) {
    headers[config.secretHeaderName] = config.token;
  }

  const init: RequestInit = {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  };

  // Older browsers lack AbortSignal.timeout; skip the signal there rather
  // than throw, since the reporter must never throw.
  if (
    typeof AbortSignal !== "undefined" &&
    typeof AbortSignal.timeout === "function"
  ) {
    init.signal = AbortSignal.timeout(REPORT_TIMEOUT_MS);
  }

  // Fire-and-forget: intentionally not awaited, errors are swallowed
  fetch(config.endpoint, init).catch(() => {
    // Swallow errors — error reporter must never throw
  });
}
