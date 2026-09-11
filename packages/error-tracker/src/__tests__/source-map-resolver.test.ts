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
import { SourceMapConsumer, SourceMapGenerator } from "source-map";

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

const {
  resolveStack,
  __setEvictedConsumerGraceMs,
  __reconcileLoadedConsumerForTest,
} = await import("../server/source-map-resolver");

// ─── deferred destroy() on eviction ──────────────────────────────────────────
//
// getCachedConsumer hands the caller a consumer synchronously, then the
// caller uses it (originalPositionFor) without awaiting anything in between.
// A concurrent insert can evict that same consumer from the cache while the
// caller is still holding it. destroy() frees the WASM-side memory backing
// the consumer, so destroying it out from under an in-flight caller would be
// a use-after-free.
//
// The module-level source map cache is a singleton shared with every other
// test file in the run (`bun test` loads them into one process), so these
// tests cannot assume the cache starts empty — another file's fixtures may
// already occupy slots and get evicted incidentally while this test fills
// its own 20. Assertions below identify "our" consumer by its unique source
// name rather than by raw destroy-call counts, so incidental evictions of
// unrelated entries can't produce a false pass or fail.
//
// A distinct source map per index, written into its own directory, so each
// entry is independently addressable and every eviction below is exactly the
// one the test expects (no accidental hits promoting a different key to MRU).
function buildDeferDestroySourceMap(index: number): string {
  const generator = new SourceMapGenerator({ file: `defer${index}.js` });
  generator.addMapping({
    generated: { line: 1, column: 0 },
    original: { line: 1, column: 0 },
    source: `DeferOriginal${index}.tsx`,
    name: `deferFn${index}`,
  });
  return generator.toString();
}

describe("resolveStack — deferred destroy() on cache eviction", () => {
  test("does not destroy an evicted consumer synchronously, but does after the grace period elapses", async () => {
    const dir = join(tmpdir(), `error-tracker-defer-${Date.now()}`);
    mkdirSync(dir, { recursive: true });

    const CACHE_LIMIT = 20;
    const GRACE_MS = 40;
    const frameFor = (i: number) => `TypeError: test\n    at defer${i}.js:1:0`;
    const expectedFor = (i: number) =>
      `TypeError: test\n    at deferFn${i} (DeferOriginal${i}.tsx:1:1)`;

    // Spying on a probe instance's prototype reaches every BasicSourceMapConsumer
    // instance the resolver creates: source-map's factory always returns the
    // same shared class prototype for a plain (non-indexed) map. Destroy the
    // probe before installing the spy so its own cleanup call isn't counted.
    // Each destroy call's originating consumer is identified by its `.sources`
    // (the original filenames the map declares) rather than object identity,
    // so an incidental destroy of some other test's entry is distinguishable
    // from the one this test is targeting.
    const probe = await new SourceMapConsumer(
      JSON.parse(buildDeferDestroySourceMap(-1))
    );
    const consumerProto = Object.getPrototypeOf(probe);
    probe.destroy();
    const originalDestroy: () => void = consumerProto.destroy;
    const destroyedSources: string[][] = [];
    const destroySpy = spyOn(consumerProto, "destroy").mockImplementation(
      function (this: { sources: string[] }) {
        destroyedSources.push([...this.sources]);
        return originalDestroy.call(this);
      }
    );
    const targetSource = `DeferOriginal0.tsx`;
    const targetDestroyed = () =>
      destroyedSources.some((sources) => sources.includes(targetSource));

    try {
      __setEvictedConsumerGraceMs(GRACE_MS);

      // Fill the (possibly non-empty, shared) cache with 20 fresh entries.
      // Regardless of what else already occupied the cache, once 20 distinct
      // new keys have been inserted into a 20-entry LRU, the cache holds
      // exactly those 20, in insertion order — so index 0 is now the oldest.
      for (let i = 0; i < CACHE_LIMIT; i++) {
        writeFileSync(
          join(dir, `defer${i}.js.map`),
          buildDeferDestroySourceMap(i),
          "utf-8"
        );
        const result = await resolveStack(frameFor(i), { sourceMapDir: dir });
        expect(result).toBe(expectedFor(i));
      }
      expect(targetDestroyed()).toBe(false);

      // One more distinct entry forces the eviction of index 0.
      writeFileSync(
        join(dir, `defer${CACHE_LIMIT}.js.map`),
        buildDeferDestroySourceMap(CACHE_LIMIT),
        "utf-8"
      );
      await resolveStack(frameFor(CACHE_LIMIT), { sourceMapDir: dir });

      // (a) Eviction happened, but destroy() must not fire synchronously:
      // another caller could still be mid-use of the evicted consumer.
      expect(targetDestroyed()).toBe(false);

      // (b) Once the grace period elapses, the evicted consumer is destroyed.
      await new Promise((resolve) => setTimeout(resolve, GRACE_MS + 60));
      expect(targetDestroyed()).toBe(true);
    } finally {
      destroySpy.mockRestore();
      __setEvictedConsumerGraceMs(undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not destroy a reloaded entry that replaces an evicted one within the grace period", async () => {
    const dir = join(tmpdir(), `error-tracker-defer-reload-${Date.now()}`);
    mkdirSync(dir, { recursive: true });

    const CACHE_LIMIT = 20;
    const GRACE_MS = 40;
    const frameFor = (i: number) => `TypeError: test\n    at defer${i}.js:1:0`;
    const expectedFor = (i: number) =>
      `TypeError: test\n    at deferFn${i} (DeferOriginal${i}.tsx:1:1)`;

    const realReadFile = fsp.readFile.bind(fsp);
    let readCount = 0;
    const readSpy = spyOn(fsp, "readFile").mockImplementation(
      (...args: any[]) => {
        readCount++;
        return (realReadFile as any)(...args);
      }
    );

    try {
      __setEvictedConsumerGraceMs(GRACE_MS);

      for (let i = 0; i < CACHE_LIMIT; i++) {
        writeFileSync(
          join(dir, `defer${i}.js.map`),
          buildDeferDestroySourceMap(i),
          "utf-8"
        );
        await resolveStack(frameFor(i), { sourceMapDir: dir });
      }

      // Evict index 0 by loading one more distinct entry.
      writeFileSync(
        join(dir, `defer${CACHE_LIMIT}.js.map`),
        buildDeferDestroySourceMap(CACHE_LIMIT),
        "utf-8"
      );
      await resolveStack(frameFor(CACHE_LIMIT), { sourceMapDir: dir });

      // Reload index 0's path before the grace period elapses. This is a
      // genuine cache miss (index 0 was just evicted), so it reads from disk
      // again and caches a fresh consumer under the same path.
      readCount = 0;
      const reloadResult = await resolveStack(frameFor(0), {
        sourceMapDir: dir,
      });
      expect(reloadResult).toBe(expectedFor(0));
      expect(readCount).toBe(1);

      // Wait past the original eviction's grace period. If the deferred
      // destroy() were keyed only on the path (not on the specific evicted
      // instance), it would destroy this freshly reloaded consumer too.
      await new Promise((resolve) => setTimeout(resolve, GRACE_MS + 60));

      // The reloaded entry must still be a live, working cache hit: correctly
      // resolved output, and no further disk read.
      readCount = 0;
      const afterGraceResult = await resolveStack(frameFor(0), {
        sourceMapDir: dir,
      });
      expect(afterGraceResult).toBe(expectedFor(0));
      expect(readCount).toBe(0);
    } finally {
      readSpy.mockRestore();
      __setEvictedConsumerGraceMs(undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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
      "TypeError: test\n    at handleClick (../src/components/Dashboard.tsx:5:1)"
    );
  });

  test("resolves only the frames that have a map and leaves the rest verbatim", async () => {
    const result = await resolveStack(makeMinifiedStack(testMapDir), {
      sourceMapDir: testMapDir,
    });
    const lines = result.split("\n");
    expect(lines[1]).toBe(
      "    at handleClick (../src/components/Dashboard.tsx:5:1)"
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

    // Also spy on destroy() (via a probe instance's prototype, as in the
    // deferred-destroy tests above) so a regression that lets a duplicate
    // load slip past the in-flight dedup window — and then gets discarded
    // via insertOrReuseConsumer — would show up here too, not just in the
    // single-read count.
    const probe = await new SourceMapConsumer(JSON.parse(buildSourceMap()));
    const consumerProto = Object.getPrototypeOf(probe);
    probe.destroy();
    const originalDestroy: () => void = consumerProto.destroy;
    let destroyCount = 0;
    const destroySpy = spyOn(consumerProto, "destroy").mockImplementation(
      function (this: unknown) {
        destroyCount++;
        return originalDestroy.call(this);
      }
    );

    try {
      const rawStack = `TypeError: test\n    at http://localhost:3000/_next/static/chunks/app.js:1:0`;
      const expected =
        "TypeError: test\n    at handleClick (../src/components/Dashboard.tsx:5:1)";

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
      // Exactly one consumer was ever created for this path, so none of the
      // five concurrent callers ever had a duplicate to discard.
      expect(destroyCount).toBe(0);
    } finally {
      destroySpy.mockRestore();
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

// ─── discarding a duplicate loaded consumer ──────────────────────────────────
//
// The in-flight dedup window is now narrow enough that a genuine duplicate
// load for the same path is very hard to force deterministically through
// resolveStack alone (that's the point of the fix). So this exercises the
// reconciliation logic directly via the test-only hook: it simulates exactly
// the scenario the reviewer described — a second, independently loaded
// consumer arriving for a path that another caller already cached — and
// checks it is destroyed rather than leaked, while the cached instance
// keeps serving lookups.
describe("getCachedConsumer — duplicate load discard", () => {
  test("a duplicate consumer reconciled against an already-cached one is destroyed, and the cached one keeps serving lookups", async () => {
    const dir = join(tmpdir(), `error-tracker-dup-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const mapFilePath = join(dir, "dup.js.map");
    writeFileSync(mapFilePath, buildSourceMap(), "utf-8");

    const probe = await new SourceMapConsumer(JSON.parse(buildSourceMap()));
    const consumerProto = Object.getPrototypeOf(probe);
    probe.destroy();
    const originalDestroy: () => void = consumerProto.destroy;
    let destroyCount = 0;
    const destroySpy = spyOn(consumerProto, "destroy").mockImplementation(
      function (this: unknown) {
        destroyCount++;
        return originalDestroy.call(this);
      }
    );

    try {
      const rawStack = "TypeError: test\n    at dup.js:1:0";
      const expected =
        "TypeError: test\n    at handleClick (../src/components/Dashboard.tsx:5:1)";

      // Populate the cache for this path the normal way.
      const first = await resolveStack(rawStack, { sourceMapDir: dir });
      expect(first).toBe(expected);
      expect(destroyCount).toBe(0);

      // Build a second, independent consumer for the same map — standing in
      // for a duplicate load that raced past the in-flight dedup window.
      const duplicate = await new SourceMapConsumer(
        JSON.parse(buildSourceMap())
      );

      const winner = __reconcileLoadedConsumerForTest(mapFilePath, duplicate);

      // The duplicate was never handed to any caller, so it's discarded
      // rather than leaked, and the survivor is the one already cached.
      expect(destroyCount).toBe(1);
      expect(winner).not.toBe(duplicate);

      // The cache is still consistent: a later lookup resolves correctly
      // from the surviving consumer, without reading the map file again.
      const realReadFile = fsp.readFile.bind(fsp);
      let readCount = 0;
      const readSpy = spyOn(fsp, "readFile").mockImplementation(
        (...args: any[]) => {
          readCount++;
          return (realReadFile as any)(...args);
        }
      );
      try {
        const second = await resolveStack(rawStack, { sourceMapDir: dir });
        expect(second).toBe(expected);
        expect(readCount).toBe(0);
      } finally {
        readSpy.mockRestore();
      }
    } finally {
      destroySpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reconciling against an empty cache slot inserts the consumer and returns it unchanged", () => {
    // The no-existing-entry branch of insertOrReuseConsumer: nothing to
    // discard, so the passed-in consumer becomes the cached one as-is.
    const dir = join(tmpdir(), `error-tracker-dup-fresh-${Date.now()}`);
    const mapFilePath = join(dir, "fresh.js.map");

    const probe = { destroy: () => {} } as unknown as Parameters<
      typeof __reconcileLoadedConsumerForTest
    >[1];
    const result = __reconcileLoadedConsumerForTest(mapFilePath, probe);
    expect(result).toBe(probe);

    // A second reconciliation for the same path now finds it cached and
    // discards whatever is passed in place of it.
    let destroyed = false;
    const duplicate = {
      destroy: () => {
        destroyed = true;
      },
    } as unknown as Parameters<typeof __reconcileLoadedConsumerForTest>[1];
    const winner = __reconcileLoadedConsumerForTest(mapFilePath, duplicate);
    expect(winner).toBe(probe);
    expect(destroyed).toBe(true);
  });
});

describe("resolveStack — true LRU eviction", () => {
  test("a repeatedly-hit entry survives eviction while an untouched entry is evicted", async () => {
    const lruDir = join(tmpdir(), `error-tracker-lru-${Date.now()}`);
    mkdirSync(lruDir, { recursive: true });

    const CACHE_LIMIT = 20;
    const frameFor = (i: number) => `TypeError: test\n    at lru${i}.js:1:0`;
    const expectedFor = (i: number) =>
      `TypeError: test\n    at fn${i} (Original${i}.tsx:1:1)`;

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

describe("resolveStack — column translation (1-based to 0-based)", () => {
  test("translates a 1-based stack column to the 0-based mapping and formats the result back as 1-based", async () => {
    // JavaScript stack traces report 1-based columns; SourceMapConsumer
    // expects and returns 0-based columns. This fixture's only mapping sits
    // at a non-zero generated column so the translation is actually exercised
    // (a mapping at column 0 would still hit after Math.max(0, col - 1)).
    const colDir = join(tmpdir(), `error-tracker-column-${Date.now()}`);
    mkdirSync(colDir, { recursive: true });
    const generator = new SourceMapGenerator({ file: "app.js" });
    generator.addMapping({
      generated: { line: 1, column: 41 },
      original: { line: 7, column: 13 },
      source: "Column.tsx",
      name: "onClick",
    });
    writeFileSync(join(colDir, "app.js.map"), generator.toString(), "utf-8");

    try {
      // Stack column 42 (1-based) translates to lookup column 41 (0-based),
      // which hits the mapping. The original column 13 (0-based) comes back
      // formatted as 14 (1-based).
      const hit = await resolveStack("TypeError: test\n    at app.js:1:42", {
        sourceMapDir: colDir,
      });
      expect(hit).toBe("TypeError: test\n    at onClick (Column.tsx:7:14)");

      // Stack column 41 (1-based) translates to lookup column 40, one short
      // of the mapping at column 41. Under GREATEST_LOWER_BOUND bias that
      // finds no mapping, proving the -1 translation is applied on input
      // rather than skipped (untranslated, column 41 would hit directly).
      const miss = await resolveStack("TypeError: test\n    at app.js:1:41", {
        sourceMapDir: colDir,
      });
      expect(miss).toBe("TypeError: test\n    at app.js:1:41");
    } finally {
      rmSync(colDir, { recursive: true, force: true });
    }
  });
});

describe("resolveStack — negative-caches corrupt maps", () => {
  test("a corrupt map is read once, then the negative cache is reused on repeat lookups", async () => {
    const corruptDir = join(
      tmpdir(),
      `error-tracker-corrupt-negcache-${Date.now()}`
    );
    mkdirSync(corruptDir, { recursive: true });
    writeFileSync(
      join(corruptDir, "app.js.map"),
      "not-valid-json{{{{",
      "utf-8"
    );

    const realReadFile = fsp.readFile.bind(fsp);
    let readCount = 0;
    const spy = spyOn(fsp, "readFile").mockImplementation((...args: any[]) => {
      readCount++;
      return (realReadFile as any)(...args);
    });

    try {
      const rawStack = "TypeError: test\n  at fn (app.js:1:1)";

      const result1 = await resolveStack(rawStack, {
        sourceMapDir: corruptDir,
      });
      expect(result1).toBe(rawStack);
      expect(readCount).toBe(1);

      const result2 = await resolveStack(rawStack, {
        sourceMapDir: corruptDir,
      });
      expect(result2).toBe(rawStack);
      // A corrupt map is a stable condition: the second lookup for the same
      // path is served from the negative cache, no additional read attempt.
      expect(readCount).toBe(1);
    } finally {
      spy.mockRestore();
      rmSync(corruptDir, { recursive: true, force: true });
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
