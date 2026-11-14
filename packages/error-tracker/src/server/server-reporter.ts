/**
 * Records errors raised on the server into the same `client_error` table the
 * browser reporter feeds, with `source` set to "server".
 *
 * Only the error itself (name, message, stack) and three labels (route
 * pattern, HTTP method, tag) are stored. Request headers, cookies, bodies,
 * the concrete request path and environment values are never read, so they
 * cannot reach the row.
 */

import type { DatabaseConfig } from "../types.js";
import { computeFingerprint } from "./ingestion.js";
import { parseFrames } from "./parse-stack.js";
import { createStore, type OccurrenceValues } from "./store.js";

export interface ServerErrorReporterConfig extends DatabaseConfig {
  /** Stored in `environment`. Defaults to `NODE_ENV`, then "development". */
  environment?: string;
  /**
   * The longest a report waits for the database, in milliseconds. A write
   * still pending after this is abandoned and logged. Defaults to 2000.
   */
  timeoutMs?: number;
}

/** What a caller of `reportServerError` may say about where the error came from. */
export interface ServerErrorContext {
  /** Route pattern such as `/api/webhooks/[provider]`. A query string or fragment is dropped. */
  route?: string;
  /** HTTP method. Stored upper-cased; anything that is not a plain token is dropped. */
  method?: string;
  /** A label of the caller's choosing, e.g. "stripe-webhook" or "nightly-sync". */
  tag?: string;
}

/**
 * The parts of Next.js's `onRequestError` arguments this reporter reads.
 * Declared structurally, rather than imported from `next`, so the package
 * builds against every `next` its peer range allows; Next's own argument
 * types are assignable to these.
 */
export interface RequestErrorRequest {
  method?: string;
  /** Accepted so Next's argument type-checks; never read (it carries the query string). */
  path?: unknown;
  /** Accepted so Next's argument type-checks; never read (it carries cookies and credentials). */
  headers?: unknown;
}

export interface RequestErrorContext {
  routePath?: string;
  routeType?: string;
}

export interface ServerErrorReporter {
  /** Export this from `instrumentation.ts` as `onRequestError`. */
  onRequestError(
    error: unknown,
    request: RequestErrorRequest,
    context: RequestErrorContext
  ): Promise<void>;
  /** For code that catches an error itself and still has to respond. */
  reportServerError(error: unknown, context?: ServerErrorContext): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 2_000;

const MAX_MESSAGE_LENGTH = 2_000;
const MAX_STACK_LENGTH = 10_000;
const MAX_ROUTE_LENGTH = 512;
const MAX_METHOD_LENGTH = 16;
const MAX_TAG_LENGTH = 128;
const MAX_ENVIRONMENT_LENGTH = 64;

const METHOD_RE = /^[A-Za-z]+$/;

const LOG_PREFIX = "[error-tracker] failed to record server error:";

/** Writes one line to the server log; a broken console must not throw either. */
function logFailure(detail: string): void {
  try {
    console.error(`${LOG_PREFIX} ${detail}`);
  } catch {
    // Nothing left to tell.
  }
}

/** Reads a property, treating a throwing getter as absent. */
function read(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function describeValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    try {
      return String(value);
    } catch {
      return "unserializable thrown value";
    }
  }
}

/** Name, message and stack of whatever was thrown, Error or not. */
function describeError(error: unknown): {
  message: string;
  stack: string | null;
} {
  if (typeof error === "object" && error !== null) {
    const rawMessage = read(error, "message");
    if (typeof rawMessage === "string") {
      const rawName = read(error, "name");
      const name = typeof rawName === "string" && rawName ? rawName : "Error";
      const rawStack = read(error, "stack");
      return {
        message: `${name}: ${rawMessage}`,
        stack: typeof rawStack === "string" && rawStack ? rawStack : null,
      };
    }
  }
  return { message: `Error: ${describeValue(error)}`, stack: null };
}

function cleanRoute(route: unknown): string | null {
  if (typeof route !== "string") return null;
  const pattern = route.split(/[?#]/, 1)[0] ?? "";
  return pattern ? pattern.slice(0, MAX_ROUTE_LENGTH) : null;
}

function cleanMethod(method: unknown): string | null {
  if (typeof method !== "string") return null;
  if (!METHOD_RE.test(method) || method.length > MAX_METHOD_LENGTH) return null;
  return method.toUpperCase();
}

function cleanTag(tag: unknown): string | null {
  if (typeof tag !== "string" || tag === "") return null;
  return tag.slice(0, MAX_TAG_LENGTH);
}

export function createServerErrorReporter(
  config: ServerErrorReporterConfig
): ServerErrorReporter {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive number of milliseconds");
  }

  // Validates db and dialect now, so a misconfigured instrumentation file
  // fails at startup rather than on the first error.
  const store = createStore(config);

  const environment = (
    config.environment ??
    process.env.NODE_ENV ??
    "development"
  ).slice(0, MAX_ENVIRONMENT_LENGTH);

  /** Writes the row, waiting at most `timeoutMs`; never rejects. */
  async function write(values: OccurrenceValues): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Both branches settle to a value, so a write that fails after the
    // timeout has won is absorbed here instead of surfacing as an unhandled
    // rejection.
    const outcome = Promise.resolve()
      .then(() => store.recordOccurrence(values))
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error })
      );
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
      // Do not hold a short-lived process (a script, a job) open for it.
      (timer as { unref?: () => void }).unref?.();
    });

    try {
      const result = await Promise.race([outcome, timeout]);
      if (result === "timeout") {
        // The driver may still deliver the write later; there is no
        // portable way to cancel a query Drizzle has handed to it.
        logFailure(
          `no answer from the database within ${timeoutMs} ms; stopped waiting`
        );
      } else if (!result.ok) {
        logFailure(describeDbError(result.error));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async function report(
    error: unknown,
    labels: { route: unknown; method: unknown; tag: unknown }
  ): Promise<void> {
    try {
      const { message: fullMessage, stack: fullStack } = describeError(error);
      const message = fullMessage.slice(0, MAX_MESSAGE_LENGTH);
      const stack = fullStack ? fullStack.slice(0, MAX_STACK_LENGTH) : null;

      await write({
        message,
        stack,
        componentStack: null,
        resolvedStack: null,
        fingerprint: computeFingerprint(message, parseFrames(stack ?? "")),
        environment,
        url: null,
        userAgent: null,
        source: "server",
        route: cleanRoute(labels.route),
        method: cleanMethod(labels.method),
        tag: cleanTag(labels.tag),
        now: new Date(),
      });
    } catch (unexpected) {
      logFailure(describeDbError(unexpected));
    }
  }

  return {
    onRequestError(error, request, context) {
      // `request.path` is the concrete URL with its query string, and
      // `request.headers` holds cookies and credentials. Neither is read.
      return report(error, {
        route: safeRead(context, "routePath"),
        method: safeRead(request, "method"),
        tag: safeRead(context, "routeType"),
      });
    },

    reportServerError(error, context) {
      return report(error, {
        route: safeRead(context, "route"),
        method: safeRead(context, "method"),
        tag: safeRead(context, "tag"),
      });
    },
  };
}

function safeRead(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? read(value, key) : undefined;
}

/**
 * The innermost cause's name and first message line. Drizzle wraps driver
 * errors in one whose message spells out the statement and its parameters,
 * and those parameters are the error being reported; the root cause (e.g.
 * `connect ECONNREFUSED`) is what says why the write failed.
 */
function describeDbError(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < 10; depth++) {
    if (typeof current !== "object" || current === null) break;
    const cause = read(current, "cause");
    if (cause === undefined || cause === null) break;
    current = cause;
  }

  if (typeof current === "object" && current !== null) {
    const name = read(current, "name");
    const message = read(current, "message");
    if (typeof message === "string") {
      const firstLine = message.split("\n", 1)[0] ?? "";
      return `${typeof name === "string" && name ? name : "Error"}: ${firstLine}`;
    }
  }
  return describeValue(current).split("\n", 1)[0] ?? "";
}
