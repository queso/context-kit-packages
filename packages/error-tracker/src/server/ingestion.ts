import { createHash } from "node:crypto";
import type { StackFrame } from "../types.js";

export interface IngestionConfig {
  // biome-ignore lint/suspicious/noExplicitAny: Prisma client type varies per consumer
  prisma: any;
  secretHeaderName?: string;
  secretHeaderToken?: string;
  deduplicationWindowMs?: number;
}

const DEFAULT_DEDUP_WINDOW_MS = 86_400_000; // 24 hours

export function computeFingerprint(message: string, frames: StackFrame[]): string {
  const topFrames = frames.slice(0, 3);
  const frameStr = topFrames
    .map((f) => `${f.file}:${f.line}:${f.column}:${f.functionName ?? ""}`)
    .join("|");
  return createHash("sha256")
    .update(`${message}|${frameStr}`)
    .digest("hex");
}

function parseFrames(stack: string): StackFrame[] {
  const frames: StackFrame[] = [];
  const lines = stack.split("\n");
  for (const line of lines) {
    // Match "  at FunctionName (file.js:line:col)"
    const match = line.match(/at\s+(?:(.+?)\s+\()?(.+):(\d+):(\d+)\)?/);
    if (match) {
      frames.push({
        functionName: match[1] ?? undefined,
        file: match[2],
        line: parseInt(match[3], 10),
        column: parseInt(match[4], 10),
      });
    }
  }
  return frames;
}

export function createIngestionHandler(config: IngestionConfig) {
  const { prisma, secretHeaderName, secretHeaderToken, deduplicationWindowMs = DEFAULT_DEDUP_WINDOW_MS } = config;

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
    if (!body.message || typeof body.message !== "string" || body.message.trim() === "") {
      return Response.json({ error: "message is required" }, { status: 400 });
    }

    const message = body.message as string;
    const rawStack = typeof body.stack === "string" ? body.stack : "";
    const resolvedStack = typeof body.resolvedStack === "string" ? body.resolvedStack : null;

    // Fix 2: use resolved frames for fingerprinting when available so the same
    // logical error from different builds produces a stable fingerprint
    const fingerprintFrames = parseFrames(resolvedStack ?? rawStack);
    const fingerprint = computeFingerprint(message, fingerprintFrames);
    const environment = process.env.NODE_ENV ?? (typeof body.environment === "string" ? body.environment : "unknown");
    const now = new Date();

    // Check for existing unresolved record within dedup window
    const windowStart = new Date(now.getTime() - deduplicationWindowMs);
    const existing = await prisma.clientError.findFirst({
      where: { fingerprint, resolvedAt: null },
    });

    if (existing && existing.resolvedAt === null && existing.lastSeenAt >= windowStart) {
      // Increment occurrences
      await prisma.clientError.update({
        where: { id: existing.id },
        data: {
          occurrences: existing.occurrences + 1,
          lastSeenAt: now,
          // Fix 1: persist the resolved stack on update
          ...(resolvedStack !== null ? { resolvedStack } : {}),
        },
      });
    } else {
      // Insert new record
      await prisma.clientError.create({
        data: {
          message,
          stack: rawStack || null,
          componentStack: typeof body.componentStack === "string" ? body.componentStack : null,
          // Fix 1: persist the resolved stack on create
          resolvedStack,
          fingerprint,
          occurrences: 1,
          environment,
          url: typeof body.url === "string" ? body.url : null,
          userAgent: typeof body.userAgent === "string" ? body.userAgent : null,
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now,
        },
      });
    }

    return Response.json({ success: true, fingerprint });
  };
}
