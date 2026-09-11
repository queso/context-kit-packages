import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import {
  CliConfigError,
  CliUsageError,
  NotFoundError,
  parseTailArgs,
  runMain,
  runResolve,
  runTail,
} from "../cli";
import * as schema from "../schema/sqlite";
import {
  captureConsole,
  findClientError,
  prepareTestDb,
  readClientErrors,
  resetClientErrors,
  seedClientError,
  seedClientErrors,
  stubEnv,
  stubProcessExit,
  testDb,
} from "./helpers";

const DIALECT = "sqlite" as const;

let workDir: string;

beforeAll(async () => {
  await prepareTestDb();
  workDir = mkdtempSync(join(tmpdir(), "error-tracker-cli-"));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetClientErrors();
});

/**
 * Runs a CLI function with the console captured and `process.exit` stubbed, so
 * an `exit()` call is recorded instead of killing the test runner.
 *
 * `captureConsole` already rethrows anything other than the stubbed exit's
 * `ProcessExitError`, so a crash in `fn` fails the calling test instead of
 * silently passing.
 */
async function runCli(fn: () => Promise<void>) {
  const exit = stubProcessExit();
  try {
    const { out, lines } = await captureConsole(fn);
    return { out, lines, codes: exit.codes };
  } finally {
    exit.restore();
  }
}

describe("runTail", () => {
  test("says so when there is nothing unresolved", async () => {
    const { out, codes } = await runCli(() =>
      runTail({ db: testDb, dialect: DIALECT })
    );
    expect(out).toContain("No unresolved errors found.");
    expect(codes).toEqual([]);
  });

  test("says so when every stored error is already resolved", async () => {
    await seedClientError({
      fingerprint: "fp-resolved",
      resolvedAt: new Date("2026-03-01T00:00:00.000Z"),
    });

    const { out } = await runCli(() =>
      runTail({ db: testDb, dialect: DIALECT })
    );
    expect(out).toContain("No unresolved errors found.");
    expect(out).not.toContain("fp-resolved");
  });

  test("prints the fingerprint, occurrence count, last-seen time and message", async () => {
    const lastSeenAt = new Date("2026-03-15T10:00:00.000Z");
    await seedClientError({
      fingerprint: "fp-printed",
      message: "TypeError: printed message",
      occurrences: 12,
      lastSeenAt,
    });

    const { out } = await runCli(() =>
      runTail({ db: testDb, dialect: DIALECT })
    );
    expect(out).toContain("fp-printed");
    expect(out).toContain("12");
    expect(out).toContain(lastSeenAt.toISOString());
    expect(out).toContain("TypeError: printed message");
  });

  test("lists unresolved errors newest first and leaves resolved ones out", async () => {
    await seedClientErrors([
      { fingerprint: "fp-old", lastSeenAt: new Date("2026-01-01T00:00:00Z") },
      { fingerprint: "fp-new", lastSeenAt: new Date("2026-03-01T00:00:00Z") },
      { fingerprint: "fp-mid", lastSeenAt: new Date("2026-02-01T00:00:00Z") },
      {
        fingerprint: "fp-done",
        lastSeenAt: new Date("2026-04-01T00:00:00Z"),
        resolvedAt: new Date("2026-04-02T00:00:00Z"),
      },
    ]);

    const { out } = await runCli(() =>
      runTail({ db: testDb, dialect: DIALECT })
    );
    expect(out).not.toContain("fp-done");
    const newest = out.indexOf("fp-new");
    const middle = out.indexOf("fp-mid");
    const oldest = out.indexOf("fp-old");
    expect(newest).toBeGreaterThan(-1);
    expect(middle).toBeGreaterThan(newest);
    expect(oldest).toBeGreaterThan(middle);
  });

  test("prints at most 20 rows by default", async () => {
    const seeded = await seedManyUnresolved(25);
    const { out } = await runCli(() =>
      runTail({ db: testDb, dialect: DIALECT })
    );
    // `seeded` is oldest first, and filter keeps that order, so this checks
    // which rows were printed; the ordering test above checks the order.
    const printed = seeded.filter((fp) => out.includes(fp));
    expect(printed).toHaveLength(20);
    // The 20 most recent, so the five oldest are the ones left out.
    expect(printed).toEqual(seeded.slice(5));
  });

  test("prints at most `limit` rows", async () => {
    const seeded = await seedManyUnresolved(10);
    const { out } = await runCli(() =>
      runTail({ db: testDb, dialect: DIALECT, limit: 3 })
    );
    expect(seeded.filter((fp) => out.includes(fp))).toEqual(seeded.slice(7));
  });

  test("prints only the requested environment", async () => {
    await seedClientErrors([
      { fingerprint: "fp-prod", environment: "production" },
      { fingerprint: "fp-stage", environment: "staging" },
    ]);

    const { out } = await runCli(() =>
      runTail({ db: testDb, dialect: DIALECT, env: "staging" })
    );
    expect(out).toContain("fp-stage");
    expect(out).not.toContain("fp-prod");
  });

  test("prints only errors last seen at or after `since`", async () => {
    await seedClientErrors([
      {
        fingerprint: "fp-before",
        lastSeenAt: new Date("2026-01-01T00:00:00Z"),
      },
      { fingerprint: "fp-on", lastSeenAt: new Date("2026-02-01T00:00:00Z") },
      { fingerprint: "fp-after", lastSeenAt: new Date("2026-03-01T00:00:00Z") },
    ]);

    const { out } = await runCli(() =>
      runTail({
        db: testDb,
        dialect: DIALECT,
        since: new Date("2026-02-01T00:00:00Z"),
      })
    );
    expect(out).toContain("fp-on");
    expect(out).toContain("fp-after");
    expect(out).not.toContain("fp-before");
  });

  test("exits 0 when exitOnComplete is set", async () => {
    await seedClientError();
    const { codes } = await runCli(() =>
      runTail({ db: testDb, dialect: DIALECT, exitOnComplete: true })
    );
    expect(codes).toEqual([0]);
  });

  test("does not exit when exitOnComplete is not set", async () => {
    await seedClientError();
    const { codes } = await runCli(() =>
      runTail({ db: testDb, dialect: DIALECT })
    );
    expect(codes).toEqual([]);
  });

  test("rejects a non-finite or non-positive limit with a catchable CliUsageError", async () => {
    // A programmatic caller must get a rejected promise, not a killed process.
    await expect(
      runTail({ db: testDb, dialect: DIALECT, limit: -5 })
    ).rejects.toBeInstanceOf(CliUsageError);
    await expect(
      runTail({ db: testDb, dialect: DIALECT, limit: -5 })
    ).rejects.toThrow("--limit expects a positive integer");
  });

  test("rejects limit 0 with a catchable CliUsageError", async () => {
    await expect(
      runTail({ db: testDb, dialect: DIALECT, limit: 0 })
    ).rejects.toThrow("--limit expects a positive integer");
  });

  test("rejects a fractional limit with a catchable CliUsageError", async () => {
    // The store hands `limit` straight to Drizzle's .limit(), which SQLite
    // and Postgres both reject for a non-integer value.
    await expect(
      runTail({ db: testDb, dialect: DIALECT, limit: 1.5 })
    ).rejects.toThrow("--limit expects a positive integer");
  });

  test("rejects an invalid `since` Date with a catchable CliUsageError", async () => {
    await expect(
      runTail({ db: testDb, dialect: DIALECT, since: new Date("garbage") })
    ).rejects.toBeInstanceOf(CliUsageError);
    await expect(
      runTail({ db: testDb, dialect: DIALECT, since: new Date("garbage") })
    ).rejects.toThrow("--since expects a valid date");
  });
});

describe("parseTailArgs", () => {
  test("defaults to limit 20 with no env or since", () => {
    expect(parseTailArgs([])).toEqual({
      limit: 20,
      env: undefined,
      since: undefined,
    });
  });

  test("parses a valid combination of flags", () => {
    const result = parseTailArgs([
      "--limit",
      "5",
      "--env",
      "production",
      "--since",
      "2026-01-01T00:00:00.000Z",
    ]);
    expect(result).toEqual({
      limit: 5,
      env: "production",
      since: new Date("2026-01-01T00:00:00.000Z"),
    });
  });

  test("rejects a non-numeric --limit", () => {
    expect(() => parseTailArgs(["--limit", "abc"])).toThrow(CliUsageError);
    expect(() => parseTailArgs(["--limit", "abc"])).toThrow(
      "--limit expects a positive integer"
    );
  });

  test("rejects a negative --limit", () => {
    expect(() => parseTailArgs(["--limit", "-5"])).toThrow(
      "--limit expects a positive integer"
    );
  });

  test("rejects a zero --limit", () => {
    expect(() => parseTailArgs(["--limit", "0"])).toThrow(
      "--limit expects a positive integer"
    );
  });

  test("rejects an unparseable --since", () => {
    expect(() => parseTailArgs(["--since", "garbage"])).toThrow(
      "--since expects a valid date"
    );
  });

  test("does not consume a following flag as --since's value", () => {
    // `--env` looks like the next flag, not a date, so it must be reported
    // as a missing `--since` value rather than silently consumed.
    expect(() => parseTailArgs(["--since", "--env", "production"])).toThrow(
      "--since expects a valid date"
    );
  });

  test("rejects an unknown flag instead of silently skipping it", () => {
    // A typo like `--limmit` must not be silently ignored (which would leave
    // the default limit in place with no indication the flag did nothing).
    expect(() => parseTailArgs(["--limmit", "50"])).toThrow(CliUsageError);
    expect(() => parseTailArgs(["--limmit", "50"])).toThrow(
      "Unknown option: --limmit"
    );
  });

  test("rejects another unknown flag, naming it", () => {
    expect(() => parseTailArgs(["--enviroment", "production"])).toThrow(
      "Unknown option: --enviroment"
    );
  });

  test("rejects a stray non-flag token", () => {
    expect(() => parseTailArgs(["production"])).toThrow(
      "Unknown argument: production"
    );
  });

  test("still parses a valid combination of flags", () => {
    const result = parseTailArgs([
      "--limit",
      "5",
      "--env",
      "production",
      "--since",
      "2026-01-01T00:00:00.000Z",
    ]);
    expect(result).toEqual({
      limit: 5,
      env: "production",
      since: new Date("2026-01-01T00:00:00.000Z"),
    });
  });
});

describe("captureConsole", () => {
  test("rethrows an error that is not the stubbed process.exit", async () => {
    const boom = new Error("boom");
    await expect(
      captureConsole(async () => {
        throw boom;
      })
    ).rejects.toBe(boom);
  });

  test("restores the console before rethrowing a non-exit error", async () => {
    const originalLog = console.log;
    const originalError = console.error;
    await expect(
      captureConsole(async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(console.log).toBe(originalLog);
    expect(console.error).toBe(originalError);
  });
});

describe("runResolve", () => {
  test("stamps resolvedAt on the matching error and says which one", async () => {
    await seedClientError({ fingerprint: "fp-to-resolve" });
    await seedClientError({ fingerprint: "fp-untouched" });
    const before = Date.now();

    const { out, codes } = await runCli(() =>
      runResolve({ db: testDb, dialect: DIALECT, fingerprint: "fp-to-resolve" })
    );

    expect(out).toContain("Resolved error with fingerprint: fp-to-resolve");
    expect(codes).toEqual([]);

    const resolved = await findClientError("fp-to-resolve");
    expect(resolved?.resolvedAt?.getTime()).toBeGreaterThanOrEqual(before);
    expect((await findClientError("fp-untouched"))?.resolvedAt).toBeNull();
  });

  test("throws a catchable NotFoundError when no error carries that fingerprint", async () => {
    await seedClientError({ fingerprint: "fp-present" });

    await expect(
      runResolve({ db: testDb, dialect: DIALECT, fingerprint: "fp-missing" })
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      runResolve({ db: testDb, dialect: DIALECT, fingerprint: "fp-missing" })
    ).rejects.toThrow("no unresolved error with fingerprint fp-missing");
    expect((await findClientError("fp-present"))?.resolvedAt).toBeNull();
  });

  test("throws a catchable NotFoundError when the error is already resolved", async () => {
    const resolvedAt = new Date("2026-03-01T00:00:00.000Z");
    await seedClientError({ fingerprint: "fp-already", resolvedAt });

    // Only unresolved rows are eligible, so a second resolve reports failure.
    await expect(
      runResolve({ db: testDb, dialect: DIALECT, fingerprint: "fp-already" })
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      runResolve({ db: testDb, dialect: DIALECT, fingerprint: "fp-already" })
    ).rejects.toThrow("no unresolved error with fingerprint fp-already");
    // The original resolution time is left alone.
    expect((await findClientError("fp-already"))?.resolvedAt).toEqual(resolvedAt);
  });

  test("rejects with the store's own error instead of killing the process", async () => {
    // Stands in for a Drizzle instance whose update fails (a broken
    // connection, a missing table, a constraint). A programmatic caller of
    // `runResolve` must get a catchable rejection, not a killed process.
    const boom = new Error("store exploded");
    const failingDb = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: () => Promise.reject(boom),
          }),
        }),
      }),
    };

    await expect(
      runResolve({ db: failingDb, dialect: DIALECT, fingerprint: "fp-anything" })
    ).rejects.toBe(boom);
  });

  test("exits 0 when exitOnComplete is set", async () => {
    await seedClientError({ fingerprint: "fp-exit" });
    const { codes } = await runCli(() =>
      runResolve({
        db: testDb,
        dialect: DIALECT,
        fingerprint: "fp-exit",
        exitOnComplete: true,
      })
    );
    expect(codes).toEqual([0]);
  });

  test("a resolved error is hidden from tail until it happens again", async () => {
    await seedClientError({ fingerprint: "fp-cycle" });
    await runCli(() =>
      runResolve({ db: testDb, dialect: DIALECT, fingerprint: "fp-cycle" })
    );

    const { out } = await runCli(() =>
      runTail({ db: testDb, dialect: DIALECT })
    );
    expect(out).toContain("No unresolved errors found.");
  });
});

describe("CLI database connection", () => {
  test.each([
    ["runTail", () => runTail({})],
    ["runResolve", () => runResolve({ fingerprint: "fp-anything" })],
  ])(
    "%s throws a catchable CliConfigError naming DATABASE_URL when it is unset",
    async (_name, call) => {
      const restore = stubEnv("DATABASE_URL", undefined);
      try {
        await expect(call()).rejects.toBeInstanceOf(CliConfigError);
        await expect(call()).rejects.toThrow("DATABASE_URL");
      } finally {
        restore();
      }
    }
  );

  test("runTail throws a catchable CliConfigError when db is passed without dialect", async () => {
    await expect(runTail({ db: testDb })).rejects.toBeInstanceOf(
      CliConfigError
    );
    await expect(runTail({ db: testDb })).rejects.toThrow(
      "A `dialect` is required alongside `db`"
    );
  });

  test("runResolve throws a catchable CliConfigError when db is passed without dialect", async () => {
    await expect(
      runResolve({ db: testDb, fingerprint: "fp-anything" })
    ).rejects.toBeInstanceOf(CliConfigError);
  });

  test("runTail reads the database DATABASE_URL points at", async () => {
    const file = join(workDir, "tail-from-url.db");
    const { connectFromDatabaseUrl } = await import("../server/connect");
    const { db, close } = await connectFromDatabaseUrl(`sqlite:${file}`);
    try {
      const { pushSQLiteSchema } = await import("drizzle-kit/api");
      const { apply } = await pushSQLiteSchema(
        schema,
        db as Parameters<typeof pushSQLiteSchema>[1]
      );
      await apply();
      await (db as LibSQLDatabase<typeof schema>)
        .insert(schema.clientError)
        .values({
          message: "TypeError: from DATABASE_URL",
          fingerprint: "fp-from-url",
          environment: "production",
          lastSeenAt: new Date("2026-03-20T00:00:00.000Z"),
        });
    } finally {
      await close();
    }

    const restore = stubEnv("DATABASE_URL", `sqlite:${file}`);
    try {
      const { out, codes } = await runCli(() => runTail({}));
      expect(codes).toEqual([]);
      expect(out).toContain("fp-from-url");
      expect(out).toContain("TypeError: from DATABASE_URL");
    } finally {
      restore();
    }

    // The in-memory database the other tests share was not touched.
    expect(await readClientErrors()).toHaveLength(0);
  });

  test("runResolve writes to the database DATABASE_URL points at", async () => {
    const file = join(workDir, "resolve-from-url.db");
    const { connectFromDatabaseUrl } = await import("../server/connect");
    const setup = await connectFromDatabaseUrl(`sqlite:${file}`);
    try {
      const { pushSQLiteSchema } = await import("drizzle-kit/api");
      const { apply } = await pushSQLiteSchema(
        schema,
        setup.db as Parameters<typeof pushSQLiteSchema>[1]
      );
      await apply();
      await (setup.db as LibSQLDatabase<typeof schema>)
        .insert(schema.clientError)
        .values({
          message: "TypeError: resolve me",
          fingerprint: "fp-resolve-url",
          environment: "production",
          lastSeenAt: new Date("2026-03-21T00:00:00.000Z"),
        });
    } finally {
      await setup.close();
    }

    const restore = stubEnv("DATABASE_URL", `sqlite:${file}`);
    try {
      const { out } = await runCli(() =>
        runResolve({ fingerprint: "fp-resolve-url" })
      );
      expect(out).toContain(
        "Resolved error with fingerprint: fp-resolve-url"
      );
    } finally {
      restore();
    }

    const check = await connectFromDatabaseUrl(`sqlite:${file}`);
    try {
      const rows = await (check.db as LibSQLDatabase<typeof schema>)
        .select()
        .from(schema.clientError);
      expect(rows[0]?.resolvedAt).toBeInstanceOf(Date);
    } finally {
      await check.close();
    }
  });
});

describe("runMain", () => {
  // runMain is the thin dispatcher `main()` delegates to; these confirm it
  // still turns a thrown CliUsageError/CliConfigError/NotFoundError (and an
  // unknown command) into the same printed message and process.exit(1) the
  // binary always had, now that runTail/runResolve throw instead of exiting.

  test("prints usage and exits 1 for an unknown command", async () => {
    const { out, codes } = await runCli(() =>
      runMain(["node", "error-tracker", "bogus"])
    );
    expect(codes).toEqual([1]);
    expect(out).toContain("Usage: error-tracker <tail|resolve> [options]");
  });

  test("prints Error: <message> and usage, then exits 1, for a bad flag", async () => {
    const { out, codes } = await runCli(() =>
      runMain(["node", "error-tracker", "tail", "--limmit", "50"])
    );
    expect(codes).toEqual([1]);
    expect(out).toContain("Error: Unknown option: --limmit");
    expect(out).toContain("Usage: error-tracker <tail|resolve> [options]");
  });

  test("prints Error: <message> and exits 1 when DATABASE_URL is unset", async () => {
    const restore = stubEnv("DATABASE_URL", undefined);
    try {
      const { out, codes } = await runCli(() =>
        runMain(["node", "error-tracker", "tail"])
      );
      expect(codes).toEqual([1]);
      expect(out).toContain("Error: DATABASE_URL is not set");
    } finally {
      restore();
    }
  });

  test("keeps the `Failed to resolve error:` prefix for a NotFoundError", async () => {
    const file = join(workDir, "runmain-resolve-missing.db");
    const { connectFromDatabaseUrl } = await import("../server/connect");
    const { db, close } = await connectFromDatabaseUrl(`sqlite:${file}`);
    try {
      const { pushSQLiteSchema } = await import("drizzle-kit/api");
      const { apply } = await pushSQLiteSchema(
        schema,
        db as Parameters<typeof pushSQLiteSchema>[1]
      );
      await apply();
    } finally {
      await close();
    }

    const restore = stubEnv("DATABASE_URL", `sqlite:${file}`);
    try {
      const { out, codes } = await runCli(() =>
        runMain(["node", "error-tracker", "resolve", "fp-missing"])
      );
      expect(codes).toEqual([1]);
      expect(out).toContain(
        "Failed to resolve error: no unresolved error with fingerprint fp-missing"
      );
    } finally {
      restore();
    }
  });

  test("prints the `Failed to resolve error:` prefix and exits 1 when the store itself throws", async () => {
    // Point DATABASE_URL at a fresh sqlite file with the schema never
    // pushed, so `UPDATE client_error` fails on a missing table: an
    // unexpected store error rather than one of the three typed CLI errors.
    const file = join(workDir, "runmain-resolve-broken-store.db");
    const restore = stubEnv("DATABASE_URL", `sqlite:${file}`);
    try {
      const { out, codes } = await runCli(() =>
        runMain(["node", "error-tracker", "resolve", "fp-anything"])
      );
      expect(codes).toEqual([1]);
      expect(out).toContain("Failed to resolve error:");
      // Distinguish this from the NotFoundError-prefixed message above.
      expect(out).not.toContain("no unresolved error with fingerprint");
    } finally {
      restore();
    }
  });
});

/**
 * Seeds `count` unresolved errors one day apart, returning their fingerprints
 * oldest first.
 */
async function seedManyUnresolved(count: number): Promise<string[]> {
  const rows = Array.from({ length: count }, (_, i) => ({
    fingerprint: `fp-${String(i).padStart(4, "0")}`,
    lastSeenAt: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000),
  }));
  await seedClientErrors(rows);
  return rows.map((row) => row.fingerprint);
}
