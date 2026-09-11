#!/usr/bin/env node

import { pathToFileURL } from "node:url";
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
  // Validate before touching the database so a bad option never opens a
  // connection it is about to throw away; programmatic callers get the same
  // protection the CLI arg parser gives `tail`.
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1) {
    console.error(`Error: ${LIMIT_USAGE_ERROR}`);
    printUsage();
    process.exit(1);
    return;
  }
  if (options.since !== undefined && Number.isNaN(options.since.getTime())) {
    console.error(`Error: ${SINCE_USAGE_ERROR}`);
    printUsage();
    process.exit(1);
    return;
  }

  const session = await openSession(options);

  if (!session) {
    process.exit(1);
    return;
  }

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

function printUsage(): void {
  console.error("Usage: error-tracker <tail|resolve> [options]");
  console.error("  tail     --limit N --env ENV --since DATE");
  console.error("  resolve  <fingerprint>");
}

const LIMIT_USAGE_ERROR = "--limit expects a positive integer";
const ENV_USAGE_ERROR = "--env expects a value";
const SINCE_USAGE_ERROR = "--since expects a valid date";

/** Thrown by `parseTailArgs` on any invalid or missing flag value. */
export class CliUsageError extends Error {}

export interface TailArgs {
  limit: number;
  env?: string;
  since?: Date;
}

/**
 * Parses `tail` subcommand flags. A flag's value must exist and must not
 * itself look like another flag (`--since --env production` should not treat
 * `--env` as the date), so this stops short of the next `--...` token and
 * reports it as missing.
 */
export function parseTailArgs(args: string[]): TailArgs {
  let limit = 20;
  let env: string | undefined;
  let since: Date | undefined;

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    const hasValue = value !== undefined && !value.startsWith("--");

    if (flag === "--limit") {
      if (!hasValue) throw new CliUsageError(LIMIT_USAGE_ERROR);
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new CliUsageError(LIMIT_USAGE_ERROR);
      }
      limit = parsed;
      i++;
    } else if (flag === "--env") {
      if (!hasValue) throw new CliUsageError(ENV_USAGE_ERROR);
      env = value;
      i++;
    } else if (flag === "--since") {
      if (!hasValue) throw new CliUsageError(SINCE_USAGE_ERROR);
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) {
        throw new CliUsageError(SINCE_USAGE_ERROR);
      }
      since = parsed;
      i++;
    } else if (flag.startsWith("--")) {
      throw new CliUsageError(`Unknown option: ${flag}`);
    } else {
      // A non-flag token here isn't a value being consumed by a prior flag
      // (those are skipped via `i++` above) — it's a stray positional arg.
      throw new CliUsageError(`Unknown argument: ${flag}`);
    }
  }

  return { limit, env, since };
}

// CLI entry point
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "tail") {
    let parsed: TailArgs;
    try {
      parsed = parseTailArgs(args.slice(1));
    } catch (err) {
      if (!(err instanceof CliUsageError)) throw err;
      console.error(`Error: ${err.message}`);
      printUsage();
      process.exit(1);
      return;
    }

    await runTail({ ...parsed, exitOnComplete: true });
  } else if (command === "resolve") {
    const fingerprint = args[1];
    if (!fingerprint) {
      console.error("Usage: error-tracker resolve <fingerprint>");
      process.exit(1);
    }
    await runResolve({ fingerprint, exitOnComplete: true });
  } else {
    printUsage();
    process.exit(1);
  }
}

// Only run main when executed directly as a script. Comparing file URLs
// (rather than reconstructing one with a `file://` prefix) keeps this
// working on Windows, where argv[1] is a POSIX-incompatible drive path.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
