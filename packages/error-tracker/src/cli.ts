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
 * is passed, otherwise a connection opened from DATABASE_URL. Throws
 * `CliConfigError` when there is nothing to connect to, so a programmatic
 * caller gets a catchable rejection rather than the process being killed out
 * from under it; `main()` is the only place that turns that into `exit(1)`.
 */
async function openSession(options: DatabaseOptions): Promise<Session> {
  if (options.db) {
    if (!options.dialect) {
      throw new CliConfigError(
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
    throw new CliConfigError(
      "DATABASE_URL is not set. Set it to your database URL (e.g. sqlite:./data/dev.sqlite), or pass a Drizzle instance as the `db` option."
    );
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
  // protection the CLI arg parser gives `tail`. Thrown, not printed-and-exited,
  // so a library consumer gets a catchable rejection instead of the process
  // being killed out from under it.
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new CliUsageError(LIMIT_USAGE_ERROR);
  }
  if (options.since !== undefined && Number.isNaN(options.since.getTime())) {
    throw new CliUsageError(SINCE_USAGE_ERROR);
  }

  const session = await openSession(options);

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

  try {
    const updated = await session.store.resolve(options.fingerprint);

    // The store only touches rows that are still open, so resolving an unknown
    // or already-resolved fingerprint changes nothing and is reported as
    // failure. Thrown, not printed-and-exited, so a library consumer gets a
    // catchable rejection; runCommand adds the `Failed to resolve error:`
    // prefix. A store error (thrown by `session.store.resolve` itself) is
    // left to propagate the same way, rather than being caught here and
    // turned into a process.exit: that killed a programmatic caller's
    // process on any store error instead of giving it a catchable rejection.
    if (updated === 0) {
      throw new NotFoundError(
        `no unresolved error with fingerprint ${options.fingerprint}`
      );
    }

    console.log(`Resolved error with fingerprint: ${options.fingerprint}`);
  } finally {
    // Close the session on every path, success, NotFoundError, or a store
    // error, without swallowing whatever is propagating.
    await session.close();
  }

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

/**
 * Thrown by `openSession` when there is no database to run a command
 * against: `DATABASE_URL` is unset, or `db` was passed without `dialect`.
 */
export class CliConfigError extends Error {}

/** Thrown by `runResolve` when no unresolved error carries the given fingerprint. */
export class NotFoundError extends Error {}

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

/**
 * Runs `fn` (a `tail` or `resolve` invocation) and turns the errors
 * `runTail`/`runResolve`/`parseTailArgs` throw for programmatic callers back
 * into the binary's original printed messages and `exit(1)`.
 *
 * `unexpectedPrefix`, when given, is used for an error that is none of the
 * three typed classes below (e.g. a store failure): it is printed as
 * `${unexpectedPrefix}: ${message}` and exits 1, instead of being rethrown.
 * `resolve` passes `"Failed to resolve error"` so an unexpected store error
 * keeps the binary's original prefixed message; `tail` passes nothing, so its
 * unexpected errors keep reaching the top-level `main().catch(...)`
 * catch-all.
 */
async function runCommand(
  fn: () => Promise<void>,
  unexpectedPrefix?: string
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof NotFoundError) {
      console.error(`Failed to resolve error: ${err.message}`);
    } else if (err instanceof CliUsageError) {
      console.error(`Error: ${err.message}`);
      printUsage();
    } else if (err instanceof CliConfigError) {
      console.error(`Error: ${err.message}`);
    } else if (unexpectedPrefix) {
      console.error(`${unexpectedPrefix}: ${(err as Error).message}`);
    } else {
      throw err;
    }
    process.exit(1);
  }
}

/**
 * The CLI's command dispatcher, given the process's `argv`. Exported (rather
 * than only `main`) so it can be exercised directly in tests via the same
 * `process.exit` stub the rest of the CLI tests use.
 */
export async function runMain(argv: string[]): Promise<void> {
  const args = argv.slice(2);
  const command = args[0];

  if (command === "tail") {
    await runCommand(async () => {
      const parsed = parseTailArgs(args.slice(1));
      await runTail({ ...parsed, exitOnComplete: true });
    });
  } else if (command === "resolve") {
    const fingerprint = args[1];
    if (!fingerprint) {
      console.error("Usage: error-tracker resolve <fingerprint>");
      process.exit(1);
      return;
    }
    await runCommand(
      () => runResolve({ fingerprint, exitOnComplete: true }),
      "Failed to resolve error"
    );
  } else {
    printUsage();
    process.exit(1);
  }
}

// CLI entry point
async function main(): Promise<void> {
  await runMain(process.argv);
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
