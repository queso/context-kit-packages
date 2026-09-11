import { createHash } from "node:crypto";
import type { DatabaseConfig, StackFrame } from "../types.js";
import { tokenMatches, warnIfUnauthenticated } from "./auth.js";
import { parseFrames } from "./parse-stack.js";
import { createStore } from "./store.js";

export interface IngestionConfig extends DatabaseConfig {
  secretHeaderName?: string;
  secretHeaderToken?: string;
}

const MAX_STACK_LENGTH = 10_000;
const MAX_MESSAGE_LENGTH = 2_000;
const MAX_COMPONENT_STACK_LENGTH = 10_000;
const MAX_URL_LENGTH = 2_048;
const MAX_USER_AGENT_LENGTH = 1_024;

/** Requests whose body is larger than this are rejected with 413 before parsing. */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * Reads `request`'s body, rejecting once it is known (or found) to exceed
 * `maxBytes`.
 *
 * A numeric content-length above the cap is rejected without touching the
 * body. Otherwise the body is streamed chunk by chunk, since a chunked
 * request (no content-length) or a garbage header cannot be trusted to
 * declare its own size: the running total is checked after every chunk, and
 * the reader is cancelled as soon as it is exceeded, so an oversized body is
 * never buffered or parsed in full. A null body (no body at all) reads as
 * empty text.
 */
export async function readBodyWithCap(
  request: Request,
  maxBytes: number
): Promise<{ ok: true; text: string } | { ok: false }> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    return { ok: false };
  }

  const body = request.body;
  if (!body) {
    return { ok: true, text: "" };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    total += value.byteLength;
    if (total > maxBytes) {
      // Stop pulling more of the body once it is already over the cap rather
      // than reading it to completion just to discard it.
      await reader.cancel();
      return { ok: false };
    }
    chunks.push(value);
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { ok: true, text: new TextDecoder().decode(combined) };
}

export function computeFingerprint(
  message: string,
  frames: StackFrame[]
): string {
  const topFrames = frames.slice(0, 3);
  const frameStr = topFrames
    .map((f) => `${f.file}:${f.line}:${f.column}:${f.functionName ?? ""}`)
    .join("|");
  return createHash("sha256").update(`${message}|${frameStr}`).digest("hex");
}

export function createIngestionHandler(config: IngestionConfig) {
  const {
    secretHeaderName = "x-error-tracker-token",
    secretHeaderToken,
  } = config;

  // Validates the database configuration up front so a misconfigured route
  // fails at module load rather than on the first report.
  const store = createStore(config);

  warnIfUnauthenticated("ingestion", secretHeaderToken);

  return async function POST(request: Request): Promise<Response> {
    // Auth check
    if (secretHeaderName && secretHeaderToken) {
      const provided = request.headers.get(secretHeaderName);
      if (!tokenMatches(provided, secretHeaderToken)) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    // Reject an oversized body, whether the caller declares its size up front
    // or not: a missing/non-numeric content-length falls through to the
    // size-capped stream read instead of skipping the check.
    let capped: Awaited<ReturnType<typeof readBodyWithCap>>;
    try {
      capped = await readBodyWithCap(request, MAX_BODY_BYTES);
    } catch {
      // The body stream itself failed, distinct from a body that read fine
      // but did not parse as JSON.
      return Response.json(
        { error: "Failed to read request body" },
        { status: 400 }
      );
    }
    if (!capped.ok) {
      return Response.json({ error: "Payload too large" }, { status: 413 });
    }
    const text = capped.text;

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text);
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    // Validate required fields
    if (
      !body.message ||
      typeof body.message !== "string" ||
      body.message.trim() === ""
    ) {
      return Response.json({ error: "message is required" }, { status: 400 });
    }

    const message = (body.message as string).slice(0, MAX_MESSAGE_LENGTH);
    const rawStack =
      typeof body.stack === "string"
        ? (body.stack as string).slice(0, MAX_STACK_LENGTH)
        : "";
    // An empty string is treated the same as absent: otherwise
    // `resolvedStack ?? rawStack` below would pick "" over a real rawStack,
    // collapsing the fingerprint to the message alone and storing "" instead
    // of NULL in the resolved_stack column.
    const resolvedStack =
      typeof body.resolvedStack === "string"
        ? (body.resolvedStack as string).slice(0, MAX_STACK_LENGTH) || null
        : null;
    const componentStack =
      typeof body.componentStack === "string"
        ? body.componentStack.slice(0, MAX_COMPONENT_STACK_LENGTH)
        : null;
    const url =
      typeof body.url === "string"
        ? body.url.slice(0, MAX_URL_LENGTH)
        : null;
    const userAgent =
      typeof body.userAgent === "string"
        ? body.userAgent.slice(0, MAX_USER_AGENT_LENGTH)
        : null;

    // Fix 2: use resolved frames for fingerprinting when available so the same
    // logical error from different builds produces a stable fingerprint
    const fingerprintFrames = parseFrames(resolvedStack ?? rawStack);
    const fingerprint = computeFingerprint(message, fingerprintFrames);

    // One statement, so concurrent reports of the same fingerprint merge
    // instead of racing, and a recurrence of a resolved error reopens it
    // rather than being dropped by a unique-constraint violation.
    await store.recordOccurrence({
      message,
      stack: rawStack || null,
      componentStack,
      resolvedStack,
      fingerprint,
      environment: process.env.NODE_ENV ?? "development",
      url,
      userAgent,
      now: new Date(),
    });

    return Response.json({ success: true, fingerprint });
  };
}
