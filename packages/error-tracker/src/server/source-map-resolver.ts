import fsp from "node:fs/promises";
import { basename, join } from "node:path";
import {
  type BasicSourceMapConsumer,
  type IndexedSourceMapConsumer,
  SourceMapConsumer,
} from "source-map";
import { parseFrameLine } from "./parse-stack.js";

type SourceMapConsumerInstance =
  | BasicSourceMapConsumer
  | IndexedSourceMapConsumer;

export interface ResolveStackOptions {
  sourceMapDir?: string;
}

const DEFAULT_SOURCE_MAP_DIR = ".next/static/chunks";

// A client-submitted stack frame's filename must look like a plain script
// name before it touches the filesystem. Rejects path traversal segments
// (e.g. "../../etc/passwd") and anything outside word/dot/dash characters.
const SAFE_MAP_FILENAME_RE = /^[\w.-]+\.(m?js)$/;

// Map file paths that were probed and did not exist. Bounded so repeated
// misses for the same chunk (a very common case — most frames belong to
// chunks with no source map at all) skip re-probing the filesystem. Cleared
// wholesale on overflow rather than evicting individually: it is a cheap
// negative cache, not a source of truth.
const negativeMapCache = new Set<string>();
const NEGATIVE_CACHE_LIMIT = 200;

function rememberMiss(mapPath: string): void {
  if (negativeMapCache.size >= NEGATIVE_CACHE_LIMIT) {
    negativeMapCache.clear();
  }
  negativeMapCache.add(mapPath);
}

// A missing-file error from the read itself (not a corrupt map, not a
// permissions issue), the case the negative cache exists for. Anything else
// (EISDIR, EACCES, transient I/O errors) is left out of the cache so it gets
// retried on the next lookup instead of being remembered as a permanent miss.
function isMissingFileError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err.code === "ENOENT" || err.code === "ENOTDIR")
  );
}

// Pure: validates the filename and builds the candidate map path. Performs no
// filesystem I/O — existence is discovered by the read in loadConsumer(), not
// probed here, so callers must check the negative cache themselves before
// attempting a load.
function getMapFilePath(sourceMapDir: string, fileRef: string): string | null {
  // Extract just the filename portion (last path segment)
  let fileName: string;
  try {
    // Handle full URLs like http://localhost:3000/_next/static/chunks/app.js
    const url = new URL(fileRef);
    fileName = basename(url.pathname);
  } catch {
    fileName = basename(fileRef);
  }

  // Reject anything that isn't a plain script filename before touching disk.
  if (!SAFE_MAP_FILENAME_RE.test(fileName)) {
    return null;
  }

  return join(sourceMapDir, `${fileName}.map`);
}

// Cache parsed source maps to avoid re-reading from disk on repeated errors.
// Entries are SourceMapConsumer instances keyed by map file path. A hit
// deletes and re-sets the key so Map iteration order reflects recency
// (true LRU, not insertion order). Limited to 20 entries to bound memory;
// the least-recently-used entry is evicted on overflow.
const sourceMapCache = new Map<string, SourceMapConsumerInstance>();
const SOURCE_MAP_CACHE_LIMIT = 20;

// An evicted consumer isn't destroyed right away: a caller may already be
// holding it (getCachedConsumer already returned it and the caller hasn't
// called originalPositionFor yet) when a concurrent insert evicts it here.
// Destroying it out from under that caller would use freed WASM memory.
// Instead the entry is removed from the cache immediately (so it can't be
// handed out again) and destroy() is deferred until any in-flight use has
// had time to finish. Callers use a consumer synchronously right after
// awaiting getCachedConsumer, so this window only needs to outlast that.
const DEFAULT_EVICTED_CONSUMER_GRACE_MS = 30_000;
let evictedConsumerGraceMs = DEFAULT_EVICTED_CONSUMER_GRACE_MS;

// Test-only: shortens (or restores) the eviction grace period so tests don't
// have to wait out the real 30s window. Never called from production code.
export function __setEvictedConsumerGraceMs(ms?: number): void {
  evictedConsumerGraceMs = ms ?? DEFAULT_EVICTED_CONSUMER_GRACE_MS;
}

// In-flight loads keyed by map file path, so concurrent cache misses for the
// same chunk share one read + parse instead of each performing its own.
const inFlightLoads = new Map<string, Promise<SourceMapConsumerInstance>>();

async function loadConsumer(
  mapFilePath: string
): Promise<SourceMapConsumerInstance> {
  let rawMap: string;
  try {
    rawMap = await fsp.readFile(mapFilePath, "utf-8");
  } catch (err) {
    // A missing map file surfaces here, from the read, instead of from a
    // separate existsSync() pre-check. Record it as a miss so the next
    // lookup for this path skips straight to the fallback; any other error
    // (EISDIR, EACCES, etc.) is left unrecorded so it gets retried.
    if (isMissingFileError(err)) {
      rememberMiss(mapFilePath);
    }
    throw err;
  }
  const sourceMap = JSON.parse(rawMap);
  return await new SourceMapConsumer(sourceMap);
}

async function getCachedConsumer(
  mapFilePath: string
): Promise<SourceMapConsumerInstance> {
  const cached = sourceMapCache.get(mapFilePath);
  if (cached) {
    // Re-insert on hit so this key becomes the most recently used.
    sourceMapCache.delete(mapFilePath);
    sourceMapCache.set(mapFilePath, cached);
    return cached;
  }

  let pending = inFlightLoads.get(mapFilePath);
  if (!pending) {
    pending = loadConsumer(mapFilePath);
    // On rejection, clear the in-flight entry right away so a later call
    // retries instead of being stuck on a rejected promise. On success, the
    // entry is cleared inside insertOrReuseConsumer below, only after the
    // consumer has actually been inserted into the cache: deleting it here
    // instead (as soon as `pending` settles) would open a window where a
    // caller arriving between settlement and insertion finds no in-flight
    // entry and no cache entry, and starts a redundant duplicate load. The
    // `.catch` also marks this derived promise as handled; `pending` itself
    // is untouched, so its other awaiters still see the real result/error.
    pending.catch(() => {
      inFlightLoads.delete(mapFilePath);
    });
    inFlightLoads.set(mapFilePath, pending);
  }

  const consumer = await pending;
  return insertOrReuseConsumer(mapFilePath, consumer);
}

// Reconciles a freshly loaded consumer against the cache. Every awaiter of
// one `pending` promise receives the same instance, so the common case here
// is a no-op merge. But if a duplicate load still raced past the dedup
// window above (or, in a test, is constructed directly), a concurrent caller
// may have already cached a different consumer for this path by the time
// this one is ready: that cached instance is the one to keep, and this one,
// never handed to any caller, is destroyed rather than leaked. Otherwise
// this consumer is inserted (evicting the LRU entry if the cache is full),
// and only now is the in-flight marker for this path cleared, so a caller
// arriving mid-load always joins `pending` instead of starting a duplicate.
function insertOrReuseConsumer(
  mapFilePath: string,
  consumer: SourceMapConsumerInstance
): SourceMapConsumerInstance {
  // Whatever happens below, this load is finished: clear the in-flight
  // marker here rather than only on insert, so a discarded duplicate's
  // promise cannot linger and hand a destroyed consumer to a later caller.
  inFlightLoads.delete(mapFilePath);

  const existing = sourceMapCache.get(mapFilePath);
  if (existing) {
    if (existing !== consumer) {
      consumer.destroy();
    }
    return existing;
  }

  if (sourceMapCache.size >= SOURCE_MAP_CACHE_LIMIT) {
    const oldestKey = sourceMapCache.keys().next().value;
    if (oldestKey) {
      const evicted = sourceMapCache.get(oldestKey);
      sourceMapCache.delete(oldestKey);
      if (evicted) {
        const timer = setTimeout(() => {
          // If the same consumer instance has been re-inserted under this
          // path within the grace period, it's back in active use: leave
          // it alone and let a future eviction destroy it instead.
          if (sourceMapCache.get(oldestKey) === evicted) {
            return;
          }
          evicted.destroy();
        }, evictedConsumerGraceMs);
        if (typeof timer.unref === "function") {
          timer.unref();
        }
      }
    }
  }
  sourceMapCache.set(mapFilePath, consumer);
  return consumer;
}

// Test-only: exercises the post-load cache reconciliation directly, so tests
// can simulate two independently loaded consumers racing for the same path
// without having to force the real (and now much narrower) timing window.
// Never called from production code.
export function __reconcileLoadedConsumerForTest(
  mapFilePath: string,
  consumer: SourceMapConsumerInstance
): SourceMapConsumerInstance {
  return insertOrReuseConsumer(mapFilePath, consumer);
}

export async function resolveStack(
  rawStack: string,
  options?: ResolveStackOptions
): Promise<string> {
  const sourceMapDir = options?.sourceMapDir ?? DEFAULT_SOURCE_MAP_DIR;

  try {
    const lines = rawStack.split("\n");
    const resolved: string[] = [];

    for (const line of lines) {
      const parsed = parseFrameLine(line);
      if (!parsed) {
        resolved.push(line);
        continue;
      }

      const mapFilePath = getMapFilePath(sourceMapDir, parsed.file);
      if (!mapFilePath || negativeMapCache.has(mapFilePath)) {
        resolved.push(line);
        continue;
      }

      try {
        const consumer = await getCachedConsumer(mapFilePath);
        const pos = consumer.originalPositionFor({
          line: parsed.line,
          column: parsed.column,
        });
        if (pos.source) {
          const sourceName = pos.name
            ? `${pos.name} (${pos.source}:${pos.line}:${pos.column})`
            : `${pos.source}:${pos.line}:${pos.column}`;
          resolved.push(`${parsed.prefix}${sourceName}`);
        } else {
          resolved.push(line);
        }
      } catch {
        // Corrupt or unparseable map — fall back to raw line
        resolved.push(line);
      }
    }

    return resolved.join("\n");
  } catch {
    // Never throw — always return something
    return rawStack;
  }
}
