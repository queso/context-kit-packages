import { createHash } from "node:crypto";
import type { StackFrame } from "../types.js";
import { parseFrames } from "./parse-stack.js";

export interface IngestionConfig {
  // biome-ignore lint/suspicious/noExplicitAny: Prisma client type varies per consumer
  prisma: any;
  secretHeaderName?: string;
  secretHeaderToken?: string;
  deduplicationWindowMs?: number;
}

const DEFAULT_DEDUP_WINDOW_MS = 86_400_000; // 24 hours
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
    prisma,
    secretHeaderName = "x-error-tracker-token",
    secretHeaderToken,
    deduplicationWindowMs = DEFAULT_DEDUP_WINDOW_MS,
  } = config;

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
    const environment = process.env.NODE_ENV ?? "development";
    const now = new Date();

    // Check for existing unresolved record within dedup window.
    // We query with lastSeenAt >= windowStart directly so the DB does the
    // filtering — no need to re-check the timestamp in application code.
    const windowStart = new Date(now.getTime() - deduplicationWindowMs);
    const existing = await prisma.clientError.findFirst({
      where: {
        fingerprint,
        resolvedAt: null,
        lastSeenAt: { gte: windowStart },
      },
    });

    if (existing) {
      // Matching unresolved record found within the window — increment in place.
      // We update by `id` (a specific row) rather than `fingerprint` so we never
      // touch a row that was concurrently resolved or replaced.
      await prisma.clientError.update({
        where: { id: existing.id },
        data: {
          occurrences: { increment: 1 },
          lastSeenAt: now,
          ...(resolvedStack !== null ? { resolvedStack } : {}),
        },
      });
    } else {
      // No matching unresolved record in window — create a new one.
      // Wrap in try/catch: under concurrent load two requests with the same
      // fingerprint can both reach this branch simultaneously.  If the sibling
      // request wins the INSERT first we get a P2002 unique-constraint error;
      // handle that by falling back to an atomic updateMany so neither request
      // is lost.
      const newRecordData = {
        message,
        stack: rawStack || null,
        componentStack:
          typeof body.componentStack === "string" ? body.componentStack : null,
        resolvedStack,
        fingerprint,
        occurrences: 1,
        environment,
        url: typeof body.url === "string" ? body.url : null,
        userAgent: typeof body.userAgent === "string" ? body.userAgent : null,
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      };

      try {
        await prisma.clientError.create({ data: newRecordData });
      } catch (err: unknown) {
        // P2002 = Prisma unique constraint violation
        if (
          err &&
          typeof err === "object" &&
          "code" in err &&
          (err as { code: string }).code === "P2002"
        ) {
          // Another concurrent request just created the row — merge into it.
          await prisma.clientError.updateMany({
            where: { fingerprint, resolvedAt: null },
            data: {
              occurrences: { increment: 1 },
              lastSeenAt: now,
              ...(resolvedStack !== null ? { resolvedStack } : {}),
            },
          });
        } else {
          throw err;
        }
      }
    }

    return Response.json({ success: true, fingerprint });
  };
}
