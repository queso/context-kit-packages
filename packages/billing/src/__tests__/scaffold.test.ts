import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const PACKAGE_ROOT = resolve(import.meta.dir, "../..");
const MONOREPO_ROOT = resolve(PACKAGE_ROOT, "../..");

describe("@context-kit/billing scaffold", () => {
  test("package builds successfully", () => {
    const result = execSync("bun --filter @context-kit/billing build", {
      cwd: MONOREPO_ROOT,
      stdio: "pipe",
    });
    // If execSync doesn't throw, exit code was 0
    expect(result).toBeDefined();
  }, 30000);

  test("built output files exist", () => {
    const distDir = resolve(PACKAGE_ROOT, "dist");
    expect(existsSync(resolve(distDir, "index.js"))).toBe(true);
    expect(existsSync(resolve(distDir, "webhook.js"))).toBe(true);
    expect(existsSync(resolve(distDir, "cli.js"))).toBe(true);
  });

  test("main entry point can be imported without error", async () => {
    const mod = await import(resolve(PACKAGE_ROOT, "dist/index.js"));
    expect(mod).toBeDefined();
  });
});
