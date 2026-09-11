import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

// The CI Postgres job sets REQUIRE_POSTGRES so postgres.test.ts fails, rather
// than skips, when DATABASE_URL is missing. The guard is a module-level throw
// in that file, so it is exercised here in a child process with a controlled
// environment.

const postgresTestFile = resolve(import.meta.dir, "postgres.test.ts");
const packageRoot = resolve(import.meta.dir, "../..");

function runPostgresTestFile(envOverrides: Record<string, string | undefined>) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "DATABASE_URL" && key !== "REQUIRE_POSTGRES") {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value !== undefined) env[key] = value;
  }

  // The junit reporter gives structured counts, so the assertions below do not
  // depend on how many tests postgres.test.ts contains or on bun's summary text.
  const junitDir = mkdtempSync(join(tmpdir(), "postgres-guard-"));
  const junitFile = join(junitDir, "junit.xml");
  try {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "test",
        postgresTestFile,
        "--reporter=junit",
        `--reporter-outfile=${junitFile}`,
      ],
      cwd: packageRoot,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    let junit: string | undefined;
    try {
      junit = readFileSync(junitFile, "utf8");
    } catch {
      junit = undefined;
    }

    return {
      exitCode: result.exitCode,
      output: result.stdout.toString() + result.stderr.toString(),
      junit,
    };
  } finally {
    rmSync(junitDir, { recursive: true, force: true });
  }
}

function readCount(junit: string, attribute: "tests" | "failures" | "skipped"): number {
  const match = junit.match(new RegExp(`<testsuites [^>]*\\b${attribute}="(\\d+)"`));
  if (!match) throw new Error(`junit report has no ${attribute} count:\n${junit}`);
  return Number(match[1]);
}

describe("postgres.test.ts REQUIRE_POSTGRES guard", () => {
  test(
    "fails the run, without logging the URL, when REQUIRE_POSTGRES is set and DATABASE_URL is not a postgres URL",
    () => {
      const { exitCode, output } = runPostgresTestFile({
        REQUIRE_POSTGRES: "1",
        // A wrong-scheme URL with credentials: the guard must reject it without
        // echoing it into the output.
        DATABASE_URL: "mysql://svc-user:s3cret-password@db.internal:3306/app",
      });

      expect(exitCode).not.toBe(0);
      expect(output).toContain(
        "REQUIRE_POSTGRES is set but DATABASE_URL is missing or is not a postgres:// or postgresql:// URL"
      );
      expect(output).not.toContain("s3cret-password");
      expect(output).not.toContain("db.internal");
    },
    30_000
  );

  test("skips every test, and passes, without REQUIRE_POSTGRES when DATABASE_URL is unset", () => {
    const { exitCode, junit } = runPostgresTestFile({});

    expect(exitCode).toBe(0);
    expect(junit).toBeDefined();
    const tests = readCount(junit!, "tests");
    expect(tests).toBeGreaterThan(0);
    expect(readCount(junit!, "failures")).toBe(0);
    expect(readCount(junit!, "skipped")).toBe(tests);
  }, 30_000);
});
