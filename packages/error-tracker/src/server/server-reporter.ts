/**
 * Records errors raised on the server into the same `client_error` table the
 * browser reporter feeds, with `source` set to "server".
 *
 * Only the error itself (name, message, stack) and three labels (route
 * pattern, HTTP method, tag) are stored. Request headers, cookies, bodies,
 * the concrete request path and environment values are never read, so they
 * cannot reach the row. The error's own text is cleaned before it is stored:
 * Drizzle's parameter list is dropped and credential-shaped strings are
 * masked (see `./redact.ts`).
 */

import { createHash } from "node:crypto";
import type { DatabaseConfig, StackFrame } from "../types.js";
import { parseFrames } from "./parse-stack.js";
import { maskSecrets } from "./redact.js";
import { createStore, type OccurrenceValues } from "./store.js";

export interface ServerErrorReporterConfig extends DatabaseConfig {
  /** Stored in `environment`. Defaults to `NODE_ENV`, then "development". */
  environment?: string;
  /**
   * The longest a report waits for the database, in milliseconds. A write
   * still pending after this counts as failed. Defaults to 2000.
   */
  timeoutMs?: number;
  /**
   * After `failures` consecutive failed or timed-out writes (default 3),
   * reports are skipped for `cooldownMs` (default 30000) and return at once;
   * then one write is tried, and a success resumes reporting.
   */
  breaker?: { failures?: number; cooldownMs?: number };
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
const DEFAULT_BREAKER_FAILURES = 3;
const DEFAULT_BREAKER_COOLDOWN_MS = 30_000;

const MAX_MESSAGE_LENGTH = 2_000;
const MAX_STACK_LENGTH = 10_000;
const MAX_ROUTE_LENGTH = 512;
const MAX_METHOD_LENGTH = 16;
const MAX_TAG_LENGTH = 128;
const MAX_ENVIRONMENT_LENGTH = 64;

const METHOD_RE = /^[A-Za-z]+$/;

/** `DrizzleQueryError`'s message: the statement, then its bound values. */
const DRIZZLE_QUERY_RE = /^Failed query: ([\s\S]*?)\nparams: [\s\S]*$/;

/** How many top frames contribute their function names to the fingerprint. */
const FINGERPRINT_FRAMES = 3;

/** Writes one line to the server log; a broken console must not throw either. */
function log(line: string): void {
  try {
    console.error(`[error-tracker] ${line}`);
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

function safeRead(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? read(value, key) : undefined;
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

/** Follows `cause` to the innermost error, at most 10 links. */
function rootCause(error: unknown): unknown {
  let current = error;
  for (let depth = 0; depth < 10; depth++) {
    const cause = safeRead(current, "cause");
    if (cause === undefined || cause === null) break;
    current = cause;
  }
  return current;
}

/** The first line of an error's message, or of the value itself. */
function firstLine(error: unknown): string {
  const message = safeRead(error, "message");
  const text = typeof message === "string" ? message : describeValue(error);
  return text.split("\n", 1)[0] ?? "";
}

/** `Name: first line of message`, for the log. */
function oneLine(error: unknown): string {
  const name = safeRead(error, "name");
  return `${typeof name === "string" && name ? name : "Error"}: ${firstLine(error)}`;
}

/** Name, message and stack of whatever was thrown, Error or not. */
function describeError(error: unknown): {
  name: string;
  message: string;
  stack: string | null;
} {
  if (typeof error === "object" && error !== null) {
    const rawMessage = read(error, "message");
    if (typeof rawMessage === "string") {
      const rawName = read(error, "name");
      const name = typeof rawName === "string" && rawName ? rawName : "Error";
      const rawStack = read(error, "stack");
      const stack = typeof rawStack === "string" && rawStack ? rawStack : null;
      return dropQueryParams(error, name, rawMessage, stack);
    }
  }
  return { name: "Error", message: describeValue(error), stack: null };
}

/**
 * A Drizzle query error's message is the statement followed by every bound
 * value, which in an app means logins, customer ids and whatever else the
 * query carried. Keep the statement, add the root cause's message (which
 * says why it failed), and drop the values from both the message and the
 * stack. The cause's class name is left out: drivers bundled into a
 * production build (postgres-js names errors after their class) carry a
 * minified name that can change between builds and would split the row.
 */
function dropQueryParams(
  error: object,
  name: string,
  message: string,
  stack: string | null
): { name: string; message: string; stack: string | null } {
  const match = DRIZZLE_QUERY_RE.exec(message);
  if (!match) return { name, message, stack };

  const cause = rootCause(error);
  const cleaned =
    cause === error
      ? `Failed query: ${match[1]}`
      : `Failed query: ${match[1]} [cause: ${firstLine(cause)}]`;

  if (stack === null) return { name, message: cleaned, stack: null };

  // V8 starts a stack with `${name}: ${message}`, so the header can be swapped
  // whole. If something rewrote the stack, cut the params line up to the
  // first frame instead.
  const header = `${name}: ${message}`;
  const cleanedStack = stack.startsWith(header)
    ? `${name}: ${cleaned}${stack.slice(header.length)}`
    : stack.replace(/\nparams: [\s\S]*?(?=\n\s+at |$)/, "");
  return { name, message: cleaned, stack: cleanedStack };
}

/**
 * Masks secrets, then caps. Masking runs on at most twice the cap, so a huge
 * value costs bounded work, and runs before the final cut so a token is never
 * split into a piece the patterns no longer match.
 */
function clean(text: string, max: number): string {
  return maskSecrets(text.slice(0, max * 2)).slice(0, max);
}

function cleanRoute(route: unknown): string | null {
  if (typeof route !== "string") return null;
  const pattern = route.split(/[?#]/, 1)[0] ?? "";
  return pattern ? clean(pattern, MAX_ROUTE_LENGTH) : null;
}

function cleanMethod(method: unknown): string | null {
  if (typeof method !== "string") return null;
  if (!METHOD_RE.test(method) || method.length > MAX_METHOD_LENGTH) return null;
  return method.toUpperCase();
}

function cleanTag(tag: unknown): string | null {
  if (typeof tag !== "string" || tag === "") return null;
  return clean(tag, MAX_TAG_LENGTH);
}

/**
 * The fingerprint for a server error: error name, message, route pattern,
 * and the function names of the top three frames.
 *
 * File paths, chunk names, lines and columns are left out because a
 * production build hashes chunk names and shifts positions on every deploy,
 * which would make every deploy re-announce every known error. Frames with
 * no function name contribute nothing; when none of the top frames has one,
 * the fingerprint is the name, message and route alone.
 *
 * Distinct from the browser's `computeFingerprint` (prefixed "server"), so a
 * server row and a browser row never merge.
 */
export function computeServerFingerprint(
  name: string,
  message: string,
  route: string | null,
  frames: StackFrame[]
): string {
  const functions = frames
    .slice(0, FINGERPRINT_FRAMES)
    .map((frame) => frame.functionName)
    .filter((fn): fn is string => Boolean(fn));
  return createHash("sha256")
    .update(JSON.stringify(["server", name, message, route, functions]))
    .digest("hex");
}

type Admission = "write" | "trial" | "skip";

/**
 * Stops a database outage from costing every failing request the full
 * timeout. Closed: every report writes. After `failures` consecutive failed
 * writes it opens: reports are skipped until `cooldownMs` has passed, then
 * one trial write runs (others are still skipped while it does). A trial
 * success closes it; a trial failure opens it for another window.
 *
 * Logs exactly three kinds of line: the first failure of a streak, the
 * moment it opens, and the moment it closes.
 */
function createBreaker(failures: number, cooldownMs: number) {
  let streak = 0;
  let openUntil: number | null = null;
  let trialRunning = false;
  let skipped = 0;

  return {
    admit(): Admission {
      if (openUntil === null) return "write";
      if (trialRunning || Date.now() < openUntil) {
        skipped += 1;
        return "skip";
      }
      trialRunning = true;
      return "trial";
    },

    succeeded(admission: Admission): void {
      streak = 0;
      if (admission !== "trial") return;
      trialRunning = false;
      openUntil = null;
      log(
        `database writes succeeded again; resuming server error reports (${skipped} skipped)`
      );
      skipped = 0;
    },

    failed(admission: Admission, detail: string): void {
      if (admission === "trial") {
        trialRunning = false;
        openUntil = Date.now() + cooldownMs;
        return;
      }
      // A write that was already in flight when the breaker opened.
      if (openUntil !== null) return;

      streak += 1;
      if (streak === 1) log(`failed to record server error: ${detail}`);
      if (streak >= failures) {
        streak = 0;
        openUntil = Date.now() + cooldownMs;
        log(
          `${failures} consecutive writes failed; skipping server error reports for ${cooldownMs} ms`
        );
      }
    },
  };
}

function positiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function positiveNumber(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function createServerErrorReporter(
  config: ServerErrorReporterConfig
): ServerErrorReporter {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!positiveNumber(timeoutMs)) {
    throw new Error("timeoutMs must be a positive number of milliseconds");
  }
  const failures = config.breaker?.failures ?? DEFAULT_BREAKER_FAILURES;
  const cooldownMs = config.breaker?.cooldownMs ?? DEFAULT_BREAKER_COOLDOWN_MS;
  if (!positiveInteger(failures)) {
    throw new Error("breaker.failures must be a positive integer");
  }
  if (!positiveNumber(cooldownMs)) {
    throw new Error("breaker.cooldownMs must be a positive number of milliseconds");
  }

  // Validates db and dialect now, so a misconfigured instrumentation file
  // fails at startup rather than on the first error.
  const store = createStore(config);
  const breaker = createBreaker(failures, cooldownMs);

  const environment = (
    config.environment ??
    process.env.NODE_ENV ??
    "development"
  ).slice(0, MAX_ENVIRONMENT_LENGTH);

  /**
   * Writes the row, waiting at most `timeoutMs`. Never rejects; resolves to
   * the failure's one-line description, or null on success.
   */
  async function write(values: OccurrenceValues): Promise<string | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Both branches settle to a value, so a write that fails after the
    // timeout has won is absorbed here instead of surfacing as an unhandled
    // rejection.
    const outcome = Promise.resolve()
      .then(() => store.recordOccurrence(values))
      .then(
        () => null,
        // The root cause, never Drizzle's wrapper: its message lists the
        // statement's parameters, which are the error being reported.
        (error: unknown) => oneLine(rootCause(error))
      );
    const timeout = new Promise<string>((resolve) => {
      timer = setTimeout(
        // The driver may still deliver the write later; there is no
        // portable way to cancel a query Drizzle has handed to it.
        () => resolve(`no answer from the database within ${timeoutMs} ms; stopped waiting`),
        timeoutMs
      );
      // Do not hold a short-lived process (a script, a job) open for it.
      (timer as { unref?: () => void }).unref?.();
    });

    try {
      return await Promise.race([outcome, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function report(
    error: unknown,
    labels: { route: unknown; method: unknown; tag: unknown }
  ): Promise<void> {
    let admission: Admission = "skip";
    try {
      admission = breaker.admit();
      if (admission === "skip") return;

      const described = describeError(error);
      const name = clean(described.name, MAX_MESSAGE_LENGTH);
      const bareMessage = clean(described.message, MAX_MESSAGE_LENGTH);
      const message = `${name}: ${bareMessage}`.slice(0, MAX_MESSAGE_LENGTH);
      const stack = described.stack ? clean(described.stack, MAX_STACK_LENGTH) : null;
      const route = cleanRoute(labels.route);

      const failure = await write({
        message,
        stack,
        componentStack: null,
        resolvedStack: null,
        fingerprint: computeServerFingerprint(
          name,
          bareMessage,
          route,
          parseFrames(stack ?? "")
        ),
        environment,
        url: null,
        userAgent: null,
        source: "server",
        route,
        method: cleanMethod(labels.method),
        tag: cleanTag(labels.tag),
        now: new Date(),
      });

      if (failure === null) breaker.succeeded(admission);
      else breaker.failed(admission, failure);
    } catch (unexpected) {
      if (admission !== "skip") breaker.failed(admission, oneLine(unexpected));
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
