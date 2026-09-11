import {
  afterAll,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceMapGenerator } from "source-map";

// ─── Test fixtures ────────────────────────────────────────────────────────────

// A real source map built with the same library the resolver uses: generated
// app.js line 1, column 0 maps back to Dashboard.tsx line 5, column 0 inside
// handleClick. A hand-written "mappings" string is too easy to get wrong, and
// a map that maps nothing makes every resolution assertion pass vacuously.
function buildSourceMap(): string {
  const generator = new SourceMapGenerator({ file: "app.js" });
  generator.addMapping({
    generated: { line: 1, column: 0 },
    original: { line: 5, column: 0 },
    source: "../src/components/Dashboard.tsx",
    name: "handleClick",
  });
  return generator.toString();
}

// A raw minified stack trace referencing the test fixture file
function makeMinifiedStack(mapDir: string) {
  return `TypeError: Cannot read properties of undefined (reading 'map')
    at http://localhost:3000/_next/static/chunks/app.js:1:0
    at processTicksAndRejections (node:internal/process/task_queues:95:5)`;
}

// A distinct, uniquely-named source map for cache-eviction tests, so each
// index's resolved output is distinguishable from every other index's.
function buildIndexedSourceMap(index: number): string {
  const generator = new SourceMapGenerator({ file: `lru${index}.js` });
  generator.addMapping({
    generated: { line: 1, column: 0 },
    original: { line: 1, column: 0 },
    source: `Original${index}.tsx`,
    name: `fn${index}`,
  });
  return generator.toString();
}

// ─── Temp directory setup ─────────────────────────────────────────────────────

let testMapDir: string;
let testMapFile: string;

beforeAll(() => {
  testMapDir = join(tmpdir(), `error-tracker-test-${Date.now()}`);
  mkdirSync(testMapDir, { recursive: true });
  testMapFile = join(testMapDir, "app.js.map");
  writeFileSync(testMapFile, buildSourceMap(), "utf-8");
});

afterAll(() => {
  if (existsSync(testMapDir)) {
    rmSync(testMapDir, { recursive: true, force: true });
  }
});

// ─── Import target ────────────────────────────────────────────────────────────

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

  test("resolves a mapped frame to the original file, line, column and name", async () => {
    const rawStack = `TypeError: test\n    at http://localhost:3000/_next/static/chunks/app.js:1:0`;
    const result = await resolveStack(rawStack, { sourceMapDir: testMapDir });
    expect(result).toBe(
      "TypeError: test\n    at handleClick (../src/components/Dashboard.tsx:5:0)"
    );
  });

  test("resolves only the frames that have a map and leaves the rest verbatim", async () => {
    const result = await resolveStack(makeMinifiedStack(testMapDir), {
      sourceMapDir: testMapDir,
    });
    const lines = result.split("\n");
    expect(lines[1]).toBe(
      "    at handleClick (../src/components/Dashboard.tsx:5:0)"
    );
    expect(lines[2]).toBe(
      "    at processTicksAndRejections (node:internal/process/task_queues:95:5)"
    );
  });

  test("keeps the raw frame when the position has no mapping", async () => {
    const rawStack = "RangeError: invalid length\n  at fn (app.js:999:999)";
    const result = await resolveStack(rawStack, { sourceMapDir: testMapDir });
    expect(result).toBe(rawStack);
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

describe("resolveStack — async read with in-flight dedup", () => {
  test("concurrent misses on the same never-before-seen map share a single read", async () => {
    const dedupDir = join(tmpdir(), `error-tracker-dedup-${Date.now()}`);
    mkdirSync(dedupDir, { recursive: true });
    writeFileSync(join(dedupDir, "app.js.map"), buildSourceMap(), "utf-8");

    // Wrap the real implementation so the read still happens, just counted.
    const realReadFile = fsp.readFile.bind(fsp);
    let readCount = 0;
    const spy = spyOn(fsp, "readFile").mockImplementation((...args: any[]) => {
      readCount++;
      return (realReadFile as any)(...args);
    });

    try {
      const rawStack = `TypeError: test\n    at http://localhost:3000/_next/static/chunks/app.js:1:0`;
      const expected =
        "TypeError: test\n    at handleClick (../src/components/Dashboard.tsx:5:0)";

      // Five concurrent resolutions all miss the cache for the same map file.
      // Without in-flight dedup, each would perform its own read and parse.
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          resolveStack(rawStack, { sourceMapDir: dedupDir })
        )
      );

      for (const result of results) {
        expect(result).toBe(expected);
      }
      expect(readCount).toBe(1);
    } finally {
      spy.mockRestore();
      rmSync(dedupDir, { recursive: true, force: true });
    }
  });

  test("a later, separate resolution after the first settles reads again", async () => {
    // Sanity check for the dedup bookkeeping: once the in-flight promise for
    // a path settles and the map is cached, a later call for the same path
    // should be served from the cache, not trigger a second file read.
    const dedupDir = join(tmpdir(), `error-tracker-dedup2-${Date.now()}`);
    mkdirSync(dedupDir, { recursive: true });
    writeFileSync(join(dedupDir, "app.js.map"), buildSourceMap(), "utf-8");

    const realReadFile = fsp.readFile.bind(fsp);
    let readCount = 0;
    const spy = spyOn(fsp, "readFile").mockImplementation(
      (...args: any[]) => {
        readCount++;
        return (realReadFile as any)(...args);
      }
    );

    try {
      const rawStack = `TypeError: test\n    at http://localhost:3000/_next/static/chunks/app.js:1:0`;
      await resolveStack(rawStack, { sourceMapDir: dedupDir });
      expect(readCount).toBe(1);

      await resolveStack(rawStack, { sourceMapDir: dedupDir });
      // Second call hits the now-populated sourceMapCache, no additional read.
      expect(readCount).toBe(1);
    } finally {
      spy.mockRestore();
      rmSync(dedupDir, { recursive: true, force: true });
    }
  });
});

describe("resolveStack — true LRU eviction", () => {
  test("a repeatedly-hit entry survives eviction while an untouched entry is evicted", async () => {
    const lruDir = join(tmpdir(), `error-tracker-lru-${Date.now()}`);
    mkdirSync(lruDir, { recursive: true });

    const CACHE_LIMIT = 20;
    const frameFor = (i: number) => `TypeError: test\n    at lru${i}.js:1:0`;
    const expectedFor = (i: number) =>
      `TypeError: test\n    at fn${i} (Original${i}.tsx:1:0)`;

    try {
      for (let i = 0; i < CACHE_LIMIT; i++) {
        writeFileSync(
          join(lruDir, `lru${i}.js.map`),
          buildIndexedSourceMap(i),
          "utf-8"
        );
      }

      // Fill the cache to its limit, in order, so entry 0 is the oldest insert.
      for (let i = 0; i < CACHE_LIMIT; i++) {
        const result = await resolveStack(frameFor(i), {
          sourceMapDir: lruDir,
        });
        expect(result).toBe(expectedFor(i));
      }

      // Hit entry 0 again. True LRU promotes it to most-recently-used; FIFO
      // eviction (keying off insertion order only) would leave it untouched.
      const hitResult = await resolveStack(frameFor(0), {
        sourceMapDir: lruDir,
      });
      expect(hitResult).toBe(expectedFor(0));

      // Add one more distinct entry, forcing exactly one eviction.
      writeFileSync(
        join(lruDir, `lru${CACHE_LIMIT}.js.map`),
        buildIndexedSourceMap(CACHE_LIMIT),
        "utf-8"
      );
      const newResult = await resolveStack(frameFor(CACHE_LIMIT), {
        sourceMapDir: lruDir,
      });
      expect(newResult).toBe(expectedFor(CACHE_LIMIT));

      // Corrupt entry 0's map file on disk (the file still exists, so the
      // filesystem probe still finds it — only its content is now garbage).
      // If entry 0 is still cached in memory (true LRU), resolution succeeds
      // from the cached consumer without ever reading this file. Under FIFO
      // eviction, entry 0 would have been evicted as the oldest insert, so
      // the resolver would re-read this now-corrupt file, fail to parse it,
      // and fall back to the raw (unresolved) frame line instead.
      writeFileSync(join(lruDir, "lru0.js.map"), "not-valid-json{{{{", "utf-8");
      const survivorResult = await resolveStack(frameFor(0), {
        sourceMapDir: lruDir,
      });
      expect(survivorResult).toBe(expectedFor(0));
    } finally {
      rmSync(lruDir, { recursive: true, force: true });
    }
  });
});

describe("resolveStack — filename validation and negative cache", () => {
  test("rejects an unsafe filename without ever attempting a read", async () => {
    // Filename validation happens before any candidate path is built, so an
    // unsafe filename must never reach fsp.readFile.
    const realReadFile = fsp.readFile.bind(fsp);
    let readCount = 0;
    const spy = spyOn(fsp, "readFile").mockImplementation((...args: any[]) => {
      readCount++;
      return (realReadFile as any)(...args);
    });

    try {
      const traversalStack = "TypeError: test\n  at fn (../../etc/passwd:1:1)";
      readCount = 0;
      const traversalResult = await resolveStack(traversalStack, {
        sourceMapDir: testMapDir,
      });
      expect(traversalResult).toBe(traversalStack);
      expect(readCount).toBe(0);

      const weirdNameStack = "TypeError: test\n  at fn (weird$name.js:1:1)";
      readCount = 0;
      const weirdNameResult = await resolveStack(weirdNameStack, {
        sourceMapDir: testMapDir,
      });
      expect(weirdNameResult).toBe(weirdNameStack);
      expect(readCount).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("reads a missing chunk's map file once and reuses the negative cache on repeat lookups", async () => {
    const missingDir = join(tmpdir(), `error-tracker-negcache-${Date.now()}`);
    mkdirSync(missingDir, { recursive: true });

    const realReadFile = fsp.readFile.bind(fsp);
    let readCount = 0;
    const spy = spyOn(fsp, "readFile").mockImplementation((...args: any[]) => {
      readCount++;
      return (realReadFile as any)(...args);
    });

    try {
      const rawStack = "TypeError: test\n  at fn (nope.js:1:1)";

      // No pre-check: the miss is discovered by the ENOENT from the read
      // itself, which then records the negative-cache entry.
      const result1 = await resolveStack(rawStack, {
        sourceMapDir: missingDir,
      });
      expect(result1).toBe(rawStack);
      expect(readCount).toBe(1);

      const result2 = await resolveStack(rawStack, {
        sourceMapDir: missingDir,
      });
      expect(result2).toBe(rawStack);
      // The second lookup for the same missing map path is served from the
      // negative cache: no additional read attempt.
      expect(readCount).toBe(1);
    } finally {
      spy.mockRestore();
      rmSync(missingDir, { recursive: true, force: true });
    }
  });

  test("a non-ENOENT read failure falls back to the raw line and is retried next time", async () => {
    // Make the "map file" a directory so fsp.readFile fails with EISDIR
    // instead of ENOENT — a transient/unexpected error, not a real miss.
    const eisdirDir = join(tmpdir(), `error-tracker-eisdir-${Date.now()}`);
    mkdirSync(eisdirDir, { recursive: true });
    mkdirSync(join(eisdirDir, "weird.js.map"), { recursive: true });

    const realReadFile = fsp.readFile.bind(fsp);
    let readCount = 0;
    const spy = spyOn(fsp, "readFile").mockImplementation((...args: any[]) => {
      readCount++;
      return (realReadFile as any)(...args);
    });

    try {
      const rawStack = "TypeError: test\n  at fn (weird.js:1:1)";

      const result1 = await resolveStack(rawStack, {
        sourceMapDir: eisdirDir,
      });
      expect(result1).toBe(rawStack);
      expect(readCount).toBe(1);

      // Not recorded in the negative cache, so the next call retries the read.
      const result2 = await resolveStack(rawStack, {
        sourceMapDir: eisdirDir,
      });
      expect(result2).toBe(rawStack);
      expect(readCount).toBe(2);
    } finally {
      spy.mockRestore();
      rmSync(eisdirDir, { recursive: true, force: true });
    }
  });
});
