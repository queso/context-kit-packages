import { readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { SourceMapConsumer, type BasicSourceMapConsumer, type IndexedSourceMapConsumer } from "source-map";
import { parseFrameLine } from "./parse-stack.js";

type SourceMapConsumerInstance = BasicSourceMapConsumer | IndexedSourceMapConsumer;

export interface ResolveStackOptions {
  sourceMapDir?: string;
}

const DEFAULT_SOURCE_MAP_DIR = ".next/static/chunks";


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
  const mapPath = join(sourceMapDir, `${fileName}.map`);
  return existsSync(mapPath) ? mapPath : null;
}

// Cache parsed source maps to avoid re-reading from disk on repeated errors.
// Entries are SourceMapConsumer instances keyed by map file path.
// Limited to 20 entries to bound memory; oldest entry evicted on overflow.
const sourceMapCache = new Map<string, SourceMapConsumerInstance>();
const SOURCE_MAP_CACHE_LIMIT = 20;

async function getCachedConsumer(mapFilePath: string): Promise<SourceMapConsumerInstance> {
  const cached = sourceMapCache.get(mapFilePath);
  if (cached) return cached;

  const rawMap = readFileSync(mapFilePath, "utf-8");
  const sourceMap = JSON.parse(rawMap);
  const consumer = await new SourceMapConsumer(sourceMap);

  // Evict oldest entry if at limit
  if (sourceMapCache.size >= SOURCE_MAP_CACHE_LIMIT) {
    const firstKey = sourceMapCache.keys().next().value;
    if (firstKey) {
      sourceMapCache.get(firstKey)?.destroy();
      sourceMapCache.delete(firstKey);
    }
  }
  sourceMapCache.set(mapFilePath, consumer);
  return consumer;
}

export async function resolveStack(rawStack: string, options?: ResolveStackOptions): Promise<string> {
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
      if (!mapFilePath) {
        resolved.push(line);
        continue;
      }

      try {
        const consumer = await getCachedConsumer(mapFilePath);
        const pos = consumer.originalPositionFor({ line: parsed.line, column: parsed.column });
        if (pos.source) {
          const sourceName = pos.name ? `${pos.name} (${pos.source}:${pos.line}:${pos.column})` : `${pos.source}:${pos.line}:${pos.column}`;
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
