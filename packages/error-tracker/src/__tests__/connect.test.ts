import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "../schema/sqlite";
import {
  connectFromDatabaseUrl,
  hasSupportedScheme,
  parseDatabaseUrl,
} from "../server/connect";

let workDir: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "error-tracker-connect-"));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * `connectFromDatabaseUrl` types `db` as `object` (it is generic over the
 * consumer's schema), so a test that queries it has to name the concrete type.
 */
function asSqliteDb(db: object): LibSQLDatabase<typeof schema> {
  return db as LibSQLDatabase<typeof schema>;
}

/** Creates `client_error` in a database returned by connectFromDatabaseUrl. */
async function pushSchemaInto(db: object): Promise<void> {
  const { pushSQLiteSchema } = await import("drizzle-kit/api");
  const { apply } = await pushSQLiteSchema(
    schema,
    db as Parameters<typeof pushSQLiteSchema>[1]
  );
  await apply();
}

describe("parseDatabaseUrl", () => {
  test.each([
    ["sqlite:./local.db", "./local.db"],
    ["sqlite:/var/data/app.db", "/var/data/app.db"],
    ["sqlite://./local.db", "./local.db"],
    ["sqlite::memory:", ":memory:"],
  ])("%s is sqlite at %s", (url, path) => {
    expect(parseDatabaseUrl(url)).toEqual({ dialect: "sqlite", path });
  });

  test.each([
    "postgres://user:pass@localhost:5432/app",
    "postgresql://user:pass@localhost:5432/app?sslmode=require",
  ])("%s is postgres and keeps the URL verbatim", (url) => {
    // The driver needs the whole URL, credentials and query string included.
    expect(parseDatabaseUrl(url)).toEqual({ dialect: "postgres", url });
  });

  test.each([
    ["a mysql URL", "mysql://user@localhost/app"],
    ["an http URL", "http://localhost:5432/app"],
    ["a bare file path", "./local.db"],
    ["an empty string", ""],
    ["a scheme-less host", "localhost:5432"],
  ])("rejects %s", (_label, url) => {
    expect(() => parseDatabaseUrl(url)).toThrow(
      /^DATABASE_URL must start with sqlite:/
    );
  });

  test.each(["sqlite://host/app.db", "sqlite://example.com/var/data/app.db"])(
    "rejects %s, which names a host rather than a path",
    (url) => {
      // `sqlite://host/x` reads as an authority, and silently treating "host"
      // as a directory would put the database somewhere nobody asked for.
      expect(() => parseDatabaseUrl(url)).toThrow(/sqlite/i);
    }
  );
});

describe("hasSupportedScheme", () => {
  test.each([
    "sqlite::memory:",
    "sqlite:./local.db",
    "postgres://user@localhost/app",
    "postgresql://user@localhost/app",
  ])("accepts %s", (url) => {
    expect(hasSupportedScheme(url)).toBe(true);
  });

  test.each(["mysql://user@localhost/app", "http://localhost/app", "./local.db", ""])(
    "rejects %s",
    (url) => {
      expect(hasSupportedScheme(url)).toBe(false);
    }
  );

  test("is case-insensitive about the scheme", () => {
    expect(hasSupportedScheme("SQLITE:./local.db")).toBe(true);
  });

  test("only checks the scheme, so a URL it accepts can still fail to parse", () => {
    // A caller must not treat this as full validation: `sqlite://host/x` has a
    // supported scheme but names an authority SQLite cannot open.
    expect(hasSupportedScheme("sqlite://host/app.db")).toBe(true);
    expect(() => parseDatabaseUrl("sqlite://host/app.db")).toThrow();
  });
});

describe("connectFromDatabaseUrl", () => {
  test("opens an in-memory sqlite database the schema can be pushed into", async () => {
    const { db, dialect, close } = await connectFromDatabaseUrl(
      "sqlite::memory:"
    );
    expect(dialect).toBe("sqlite");

    try {
      await pushSchemaInto(db);
      const sqliteDb = asSqliteDb(db);

      await sqliteDb.insert(schema.clientError).values({
        message: "TypeError: boom",
        fingerprint: "fp-memory",
        environment: "test",
        lastSeenAt: new Date("2026-03-01T00:00:00.000Z"),
      });

      const rows = await sqliteDb
        .select()
        .from(schema.clientError)
        .where(eq(schema.clientError.fingerprint, "fp-memory"));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.message).toBe("TypeError: boom");
      expect(rows[0]?.occurrences).toBe(1);
      expect(rows[0]?.resolvedAt).toBeNull();
    } finally {
      await close();
    }
  });

  test("opens a sqlite file and the rows survive a reconnect", async () => {
    const file = join(workDir, "tail.db");

    const first = await connectFromDatabaseUrl(`sqlite:${file}`);
    try {
      await pushSchemaInto(first.db);
      await asSqliteDb(first.db).insert(schema.clientError).values({
        message: "RangeError: persisted",
        fingerprint: "fp-file",
        environment: "production",
        lastSeenAt: new Date("2026-03-02T00:00:00.000Z"),
      });
    } finally {
      await first.close();
    }

    expect(existsSync(file)).toBe(true);

    const second = await connectFromDatabaseUrl(`sqlite:${file}`);
    try {
      const rows = await asSqliteDb(second.db)
        .select()
        .from(schema.clientError);
      expect(rows.map((row) => row.fingerprint)).toEqual(["fp-file"]);
      expect(rows[0]?.message).toBe("RangeError: persisted");
    } finally {
      await second.close();
    }
  });

  test("refuses a URL it cannot parse without opening anything", async () => {
    // The URL is validated before any driver is loaded; the failure still
    // arrives as a rejected promise so callers only handle one failure shape.
    await expect(
      connectFromDatabaseUrl("mysql://user@localhost/app")
    ).rejects.toThrow(/^DATABASE_URL must start with sqlite:/);
  });
});
