import { readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { SourceMapConsumer } from "source-map";

export interface ResolveStackOptions {
  sourceMapDir?: string;
}

const DEFAULT_SOURCE_MAP_DIR = ".next/static/chunks";

// Parse a stack frame line, returns null if it doesn't match
function parseFrameLine(line: string): { before: string; file: string; line: number; col: number } | null {
  // Matches "    at Something (path/to/file.js:LINE:COL)" or "    at path/to/file.js:LINE:COL"
  const match = line.match(/^(\s*at\s+(?:.+\s+\()?)((?:https?:\/\/[^)]+?|[^()\s]+))(?::(\d+):(\d+))\)?/);
  if (!match) return null;
  return {
    before: match[1],
    file: match[2],
    line: parseInt(match[3], 10),
    col: parseInt(match[4], 10),
  };
}

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
        const rawMap = readFileSync(mapFilePath, "utf-8");
        const sourceMap = JSON.parse(rawMap);
        const consumer = await new SourceMapConsumer(sourceMap);
        try {
          const pos = consumer.originalPositionFor({ line: parsed.line, column: parsed.col });
          if (pos.source) {
            const sourceName = pos.name ? `${pos.name} (${pos.source}:${pos.line}:${pos.column})` : `${pos.source}:${pos.line}:${pos.column}`;
            resolved.push(`${parsed.before}${sourceName}`);
          } else {
            resolved.push(line);
          }
        } finally {
          consumer.destroy();
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
