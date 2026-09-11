import { createHash } from "node:crypto";
import type { DatabaseConfig, StackFrame } from "../types.js";
import { parseFrames } from "./parse-stack.js";
import { createStore } from "./store.js";

export interface IngestionConfig extends DatabaseConfig {
  secretHeaderName?: string;
  secretHeaderToken?: string;
}

const MAX_STACK_LENGTH = 10_000;

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

  return async function POST(request: Request): Promise<Response> {
    // Auth check
    if (secretHeaderName && secretHeaderToken) {
      const provided = request.headers.get(secretHeaderName);
      if (provided !== secretHeaderToken) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    // Parse body
    let body: Record<string, unknown>;
    try {
      body = await request.json();
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

    const message = body.message as string;
    const rawStack =
      typeof body.stack === "string"
        ? (body.stack as string).slice(0, MAX_STACK_LENGTH)
        : "";
    const resolvedStack =
      typeof body.resolvedStack === "string"
        ? (body.resolvedStack as string).slice(0, MAX_STACK_LENGTH)
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
      componentStack:
        typeof body.componentStack === "string" ? body.componentStack : null,
      resolvedStack,
      fingerprint,
      environment: process.env.NODE_ENV ?? "development",
      url: typeof body.url === "string" ? body.url : null,
      userAgent: typeof body.userAgent === "string" ? body.userAgent : null,
      now: new Date(),
    });

    return Response.json({ success: true, fingerprint });
  };
}
