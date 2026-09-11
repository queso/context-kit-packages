import { describe, test, expect } from "bun:test";
import { resolve } from "path";

// The CI Postgres job sets REQUIRE_POSTGRES so postgres.test.ts fails, rather
// than skips, when DATABASE_URL is missing. The guard is a module-level throw
// in that file, so it is exercised here in a child process with a controlled
// environment.
describe("postgres.test.ts REQUIRE_POSTGRES guard", () => {
  test(
    "fails the run when REQUIRE_POSTGRES is set and DATABASE_URL is not a postgres URL",
    () => {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && key !== "DATABASE_URL") env[key] = value;
      }
      env.REQUIRE_POSTGRES = "1";

      const result = Bun.spawnSync({
        cmd: [process.execPath, "test", resolve(import.meta.dir, "postgres.test.ts")],
        cwd: resolve(import.meta.dir, "../.."),
        env,
        stdout: "pipe",
        stderr: "pipe",
      });

      const output = result.stdout.toString() + result.stderr.toString();
      expect(result.exitCode).not.toBe(0);
      expect(output).toContain("REQUIRE_POSTGRES is set but DATABASE_URL is not a postgres:// URL");
    },
    30_000
  );

  test("skips, and passes, without REQUIRE_POSTGRES when DATABASE_URL is unset", () => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && key !== "DATABASE_URL" && key !== "REQUIRE_POSTGRES") {
        env[key] = value;
      }
    }

    const result = Bun.spawnSync({
      cmd: [process.execPath, "test", resolve(import.meta.dir, "postgres.test.ts")],
      cwd: resolve(import.meta.dir, "../.."),
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = result.stdout.toString() + result.stderr.toString();
    expect(result.exitCode).toBe(0);
    expect(output).toContain("1 skip");
  }, 30_000);
});
