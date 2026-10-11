import type { ErrorPayload, ErrorTrackerConfig } from "./types.js";

const MAX_STACK_LENGTH = 10_000;
// Matches the server's stored cap. Without it a long console.error message
// could push the body past the 64 KB keepalive quota and the server's limit.
const MAX_MESSAGE_LENGTH = 2_000;
const LOOP_GUARD = "@context-kit/error-tracker";
const REPORT_TIMEOUT_MS = 5_000;

function truncate(str: string, max = MAX_STACK_LENGTH): string {
  return str.length > max ? str.slice(0, max) : str;
}

function isTimeout(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "TimeoutError" || err.name === "AbortError")
  );
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
    message: truncate(data.message, MAX_MESSAGE_LENGTH),
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

  // Older browsers lack AbortSignal.timeout; skip the signal there rather
  // than throw, since the reporter must never throw.
  const makeInit = (keepalive: boolean): RequestInit => {
    const init: RequestInit = {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    };
    // keepalive lets the request finish after the page unloads or navigates,
    // which is when errors thrown during navigation or tab close are sent.
    if (keepalive) {
      init.keepalive = true;
    }
    if (
      typeof AbortSignal !== "undefined" &&
      typeof AbortSignal.timeout === "function"
    ) {
      init.signal = AbortSignal.timeout(REPORT_TIMEOUT_MS);
    }
    return init;
  };

  // Fire-and-forget: intentionally not awaited, errors are swallowed.
  // Browsers reject a keepalive request when in-flight keepalive bodies would
  // exceed 64 KB in total, so a rejection is retried once as an ordinary
  // request, which still gets through while the page is open. A timeout is
  // not retried, since a second request would wait on the same slow endpoint.
  fetch(config.endpoint, makeInit(true)).catch((err: unknown) => {
    if (isTimeout(err)) return;
    fetch(config.endpoint, makeInit(false)).catch(() => {
      // Swallow errors — error reporter must never throw
    });
  });
}
