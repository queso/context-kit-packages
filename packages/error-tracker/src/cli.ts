#!/usr/bin/env node

export interface TailOptions {
  // biome-ignore lint/suspicious/noExplicitAny: Prisma client type varies per consumer
  prisma?: any;
  limit?: number;
  env?: string;
  since?: Date;
  exitOnComplete?: boolean;
}

export interface ResolveOptions {
  // biome-ignore lint/suspicious/noExplicitAny: Prisma client type varies per consumer
  prisma?: any;
  fingerprint: string;
  exitOnComplete?: boolean;
}

async function getPrisma(provided?: unknown): Promise<unknown | null> {
  if (provided) return provided;
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  try {
    // Dynamic import — works when consumer has @prisma/client installed
    // biome-ignore lint/suspicious/noExplicitAny: runtime import of consumer's PrismaClient
    const mod = (await import("@prisma/client")) as any;
    const PrismaClient = mod.PrismaClient ?? mod.default?.PrismaClient;
    if (!PrismaClient) return null;
    return new PrismaClient();
  } catch {
    return null;
  }
}

export async function runTail(options: TailOptions): Promise<void> {
  const prisma = await getPrisma(options.prisma);

  if (!prisma) {
    console.error(
      "Error: Could not initialize Prisma client. Ensure DATABASE_URL is set and @prisma/client is installed."
    );
    process.exit(1);
    return;
  }

  const limit = options.limit ?? 20;

  // biome-ignore lint/suspicious/noExplicitAny: dynamic Prisma query
  const where: Record<string, any> = {
    resolvedAt: null,
  };

  if (options.env) {
    where.environment = options.env;
  }

  if (options.since) {
    where.lastSeenAt = { gte: options.since };
  }

  // biome-ignore lint/suspicious/noExplicitAny: Prisma client
  const errors = await (prisma as any).clientError.findMany({
    where,
    orderBy: { lastSeenAt: "desc" },
    take: limit,
  });

  if (errors.length === 0) {
    console.log("No unresolved errors found.");
  } else {
    console.log(`\nRecent errors (${errors.length}):\n`);
    console.log(
      padRight("Fingerprint", 20) +
        padRight("Occurrences", 12) +
        padRight("Last Seen", 26) +
        "Message"
    );
    console.log("-".repeat(90));

    for (const err of errors) {
      const lastSeen =
        err.lastSeenAt instanceof Date
          ? err.lastSeenAt.toISOString()
          : String(err.lastSeenAt);
      const msg = String(err.message ?? "").slice(0, 50);
      console.log(
        padRight(String(err.fingerprint ?? "").slice(0, 18), 20) +
          padRight(String(err.occurrences ?? 0), 12) +
          padRight(lastSeen, 26) +
          msg
      );
    }
    console.log();
  }

  if (options.exitOnComplete) {
    process.exit(0);
  }
}

export async function runResolve(options: ResolveOptions): Promise<void> {
  const prisma = await getPrisma(options.prisma);

  if (!prisma) {
    console.error(
      "Error: Could not initialize Prisma client. Ensure DATABASE_URL is set and @prisma/client is installed."
    );
    process.exit(1);
    return;
  }

  try {
    // biome-ignore lint/suspicious/noExplicitAny: Prisma client
    await (prisma as any).clientError.update({
      where: { fingerprint: options.fingerprint },
      data: { resolvedAt: new Date() },
    });

    console.log(`Resolved error with fingerprint: ${options.fingerprint}`);

    if (options.exitOnComplete) {
      process.exit(0);
    }
  } catch (err) {
    console.error(`Failed to resolve error: ${(err as Error).message}`);
    process.exit(1);
  }
}

function padRight(str: string, width: number): string {
  return str.length >= width
    ? str.slice(0, width)
    : str + " ".repeat(width - str.length);
}

// CLI entry point
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "tail") {
    let limit = 20;
    let env: string | undefined;
    let since: Date | undefined;

    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--limit" && args[i + 1]) {
        limit = parseInt(args[++i], 10);
      } else if (args[i] === "--env" && args[i + 1]) {
        env = args[++i];
      } else if (args[i] === "--since" && args[i + 1]) {
        since = new Date(args[++i]);
      }
    }

    await runTail({ limit, env, since, exitOnComplete: true });
  } else if (command === "resolve") {
    const fingerprint = args[1];
    if (!fingerprint) {
      console.error("Usage: error-tracker resolve <fingerprint>");
      process.exit(1);
    }
    await runResolve({ fingerprint, exitOnComplete: true });
  } else {
    console.error("Usage: error-tracker <tail|resolve> [options]");
    console.error("  tail     --limit N --env ENV --since DATE");
    console.error("  resolve  <fingerprint>");
    process.exit(1);
  }
}

// Only run main when executed directly as a script
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
