#!/usr/bin/env node

import type { ErrorTrackerDialect } from "./types.js";
import { connectFromDatabaseUrl } from "./server/connect.js";
import { createStore, type ErrorStore } from "./server/store.js";

export interface DatabaseOptions {
  /** The app's Drizzle instance. Omit to connect from DATABASE_URL. */
  db?: object;
  /** Required whenever `db` is passed. */
  dialect?: ErrorTrackerDialect;
}

export interface TailOptions extends DatabaseOptions {
  limit?: number;
  env?: string;
  since?: Date;
  exitOnComplete?: boolean;
}

export interface ResolveOptions extends DatabaseOptions {
  fingerprint: string;
  exitOnComplete?: boolean;
}

interface Session {
  store: ErrorStore;
  /** Closes the connection the CLI opened; a no-op for a caller-supplied db. */
  close(): Promise<void>;
}

/**
 * Resolves the database for a command: the caller's Drizzle instance when one
 * is passed, otherwise a connection opened from DATABASE_URL. Returns null
 * (after printing why) when there is nothing to connect to, so the caller can
 * exit 1 without a stack trace.
 */
async function openSession(options: DatabaseOptions): Promise<Session | null> {
  if (options.db) {
    if (!options.dialect) {
      throw new Error(
        'A `dialect` is required alongside `db`. Pass `getDialect()` from "@/db" with your Drizzle instance.'
      );
    }
    return {
      store: createStore({ db: options.db, dialect: options.dialect }),
      close: async () => {},
    };
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      "Error: DATABASE_URL is not set. Set it to your database URL (e.g. sqlite:./data/dev.sqlite), or pass a Drizzle instance as the `db` option."
    );
    return null;
  }

  const connection = await connectFromDatabaseUrl(url);
  return {
    store: createStore({ db: connection.db, dialect: connection.dialect }),
    close: () => connection.close(),
  };
}

export async function runTail(options: TailOptions): Promise<void> {
  const session = await openSession(options);

  if (!session) {
    process.exit(1);
    return;
  }

  const limit = options.limit ?? 20;

  try {
    const { errors } = await session.store.list({
      filters: {
        resolved: false,
        environment: options.env,
        since: options.since,
      },
      limit,
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
  } finally {
    await session.close();
  }

  if (options.exitOnComplete) {
    process.exit(0);
  }
}

export async function runResolve(options: ResolveOptions): Promise<void> {
  const session = await openSession(options);

  if (!session) {
    process.exit(1);
    return;
  }

  let updated: number;
  try {
    updated = await session.store.resolve(options.fingerprint);
  } catch (err) {
    await session.close();
    console.error(`Failed to resolve error: ${(err as Error).message}`);
    process.exit(1);
    return;
  }

  await session.close();

  // The store only touches rows that are still open, so resolving an unknown
  // or already-resolved fingerprint changes nothing and is reported as failure.
  if (updated === 0) {
    console.error(
      `Failed to resolve error: no unresolved error with fingerprint ${options.fingerprint}`
    );
    process.exit(1);
    return;
  }

  console.log(`Resolved error with fingerprint: ${options.fingerprint}`);

  if (options.exitOnComplete) {
    process.exit(0);
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
