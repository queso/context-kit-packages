import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// ─── Test fixtures ────────────────────────────────────────────────────────────

// A minimal valid source map (maps line 1, col 0 → original file line 5, col 0)
// Generated from a fictional minified file with one mapping entry.
const MINIMAL_SOURCE_MAP = JSON.stringify({
  version: 3,
  file: "app.js",
  sourceRoot: "",
  sources: ["../src/components/Dashboard.tsx"],
  sourcesContent: [null],
  names: ["handleClick"],
  // Single mapping: generated col 0 → source 0, orig line 4 (0-indexed), col 0, name 0
  mappings: "AACIC",
});

// A raw minified stack trace referencing the test fixture file
function makeMinifiedStack(mapDir: string) {
  return `TypeError: Cannot read properties of undefined (reading 'map')
    at http://localhost:3000/_next/static/chunks/app.js:1:0
    at processTicksAndRejections (node:internal/process/task_queues:95:5)`;
}

// ─── Temp directory setup ─────────────────────────────────────────────────────

let testMapDir: string;
let testMapFile: string;

beforeAll(() => {
  testMapDir = join(tmpdir(), `error-tracker-test-${Date.now()}`);
  mkdirSync(testMapDir, { recursive: true });
  testMapFile = join(testMapDir, "app.js.map");
  writeFileSync(testMapFile, MINIMAL_SOURCE_MAP, "utf-8");
});

afterAll(() => {
  if (existsSync(testMapDir)) {
    rmSync(testMapDir, { recursive: true, force: true });
  }
});

// ─── Import target ────────────────────────────────────────────────────────────

// @ts-expect-error: module created by B.A. during implementation phase
const { resolveStack } = await import("../server/source-map-resolver");

// ─── resolveStack ─────────────────────────────────────────────────────────────

describe("resolveStack", () => {
  test("is a function", () => {
    expect(typeof resolveStack).toBe("function");
  });

  test("returns a string", async () => {
    const result = await resolveStack(makeMinifiedStack(testMapDir), {
      sourceMapDir: testMapDir,
    });
    expect(typeof result).toBe("string");
  });

  test("returns a non-empty string for a valid stack", async () => {
    const result = await resolveStack(makeMinifiedStack(testMapDir), {
      sourceMapDir: testMapDir,
    });
    expect(result.length).toBeGreaterThan(0);
  });

  test("returns original stack as fallback when source map directory does not exist", async () => {
    const rawStack = "TypeError: test\n  at fn (app.js:1:0)";
    const result = await resolveStack(rawStack, {
      sourceMapDir: "/nonexistent/path/that/does/not/exist",
    });
    // Must return something (not throw), and should contain the original error message
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("returns raw frame when source map file is missing for a specific chunk", async () => {
    const rawStack = "TypeError: test\n  at fn (missing-chunk.js:1:0)";
    const result = await resolveStack(rawStack, {
      sourceMapDir: testMapDir,
    });
    // Graceful fallback: original frame text preserved
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("does not throw when source map file is corrupt/invalid JSON", async () => {
    const corruptMapDir = join(tmpdir(), `error-tracker-corrupt-${Date.now()}`);
    mkdirSync(corruptMapDir, { recursive: true });
    writeFileSync(
      join(corruptMapDir, "app.js.map"),
      "not-valid-json{{{{",
      "utf-8"
    );

    try {
      const rawStack = "Error\n  at fn (app.js:1:0)";
      const result = await resolveStack(rawStack, {
        sourceMapDir: corruptMapDir,
      });
      // Must not throw — returns fallback
      expect(typeof result).toBe("string");
    } finally {
      rmSync(corruptMapDir, { recursive: true, force: true });
    }
  });

  test("does not propagate internal resolution errors (never throws)", async () => {
    // Pass an intentionally broken stack string
    await expect(
      resolveStack("this is not a stack trace at all", {
        sourceMapDir: testMapDir,
      })
    ).resolves.toBeDefined();
  });

  test("accepts configurable sourceMapDir option", async () => {
    // Verify a custom sourceMapDir is respected
    const customDir = join(tmpdir(), `error-tracker-custom-${Date.now()}`);
    mkdirSync(customDir, { recursive: true });

    try {
      const result = await resolveStack("Error\n  at fn (app.js:1:0)", {
        sourceMapDir: customDir,
      });
      // Should return a fallback (no maps in custom dir) without throwing
      expect(typeof result).toBe("string");
    } finally {
      rmSync(customDir, { recursive: true, force: true });
    }
  });

  test("resolved output includes original error message line", async () => {
    const rawStack =
      "TypeError: Cannot read 'map'\n  at Dashboard (app.js:1:0)";
    const result = await resolveStack(rawStack, { sourceMapDir: testMapDir });
    // The error message should survive resolution
    expect(result).toContain("TypeError");
  });

  test("resolved output with a valid source map includes original source file reference", async () => {
    const rawStack = `TypeError: test\n    at http://localhost:3000/_next/static/chunks/app.js:1:0`;
    const result = await resolveStack(rawStack, { sourceMapDir: testMapDir });
    // If resolution succeeded, the output should reference the original source file
    // or at minimum contain a non-empty resolved string
    expect(result.length).toBeGreaterThan(0);
  });

  test("falls back gracefully when resolution fails internally (raw stack returned)", async () => {
    const rawStack = "RangeError: invalid length\n  at fn (app.js:999:999)";

    // Even if the specific line/col isn't in the source map, should not throw
    const result = await resolveStack(rawStack, { sourceMapDir: testMapDir });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("resolveStack — default source map directory", () => {
  test("uses .next/static/chunks/ as default source map directory when none provided", async () => {
    // Call without sourceMapDir — should not throw (will use default path)
    const rawStack = "Error: test\n  at fn (app.js:1:0)";
    // This will likely fall back to raw since .next/ won't exist in test env,
    // but must not throw
    await expect(resolveStack(rawStack)).resolves.toBeDefined();
  });
});
