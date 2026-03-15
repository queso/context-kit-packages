import type { ErrorTrackerConfig, ErrorPayload } from "./types.js";

const MAX_STACK_LENGTH = 10_000;
const LOOP_GUARD = "@context-kit/error-tracker";

function truncate(str: string): string {
  return str.length > MAX_STACK_LENGTH ? str.slice(0, MAX_STACK_LENGTH) : str;
}

export function reportError(config: ErrorTrackerConfig, data: ErrorPayload): void {
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

  // Fire-and-forget: intentionally not awaited, errors are swallowed
  fetch(config.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }).catch(() => {
    // Swallow errors — error reporter must never throw
  });
}
