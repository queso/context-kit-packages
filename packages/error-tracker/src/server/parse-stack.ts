import type { StackFrame } from "../types.js";

/**
 * Regex for parsing V8-style stack frame lines.
 * Handles both file paths and full URLs (e.g., http://localhost:3000/...).
 * Captures: [1] prefix (whitespace + "at" + optional function name),
 *           [2] function name (if present), [3] file path or URL,
 *           [4] line number, [5] column number.
 */
const FRAME_RE =
  /^(\s*at\s+(?:(.+?)\s+\()?)((?:https?:\/\/[^)]+?|[^()\s]+))(?::(\d+):(\d+))\)?/;

export interface ParsedFrameLine {
  /** Everything before the file reference (e.g., "    at MyComponent (") */
  prefix: string;
  /** Function name if present */
  functionName?: string;
  /** File path or URL */
  file: string;
  /** Line number */
  line: number;
  /** Column number */
  column: number;
}

/**
 * Parse a single stack trace line into its components.
 * Returns null if the line doesn't match a V8 stack frame pattern.
 */
export function parseFrameLine(line: string): ParsedFrameLine | null {
  const match = line.match(FRAME_RE);
  if (!match) return null;
  return {
    prefix: match[1],
    functionName: match[2] ?? undefined,
    file: match[3],
    line: parseInt(match[4], 10),
    column: parseInt(match[5], 10),
  };
}

/**
 * Parse all frames from a full stack trace string.
 * Returns an array of StackFrame objects (used for fingerprinting).
 */
export function parseFrames(stack: string): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const line of stack.split("\n")) {
    const parsed = parseFrameLine(line);
    if (parsed) {
      frames.push({
        file: parsed.file,
        line: parsed.line,
        column: parsed.column,
        functionName: parsed.functionName,
      });
    }
  }
  return frames;
}
