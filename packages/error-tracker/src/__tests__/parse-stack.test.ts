import { describe, expect, test } from "bun:test";
import { computeFingerprint } from "../server/ingestion";
import { parseFrameLine, parseFrames } from "../server/parse-stack";

// ─── parseFrameLine — URL-form frames ──────────────────────────────────────────
//
// FRAME_RE advertises support for full http(s):// URLs alongside plain file
// paths (used by browser stacks pointing at bundled chunks), not just
// Node-style file paths. These tests pin down that URL frames, including a
// port and a query string, parse the same way a Node file-path frame would.

describe("parseFrameLine — URL-form frames", () => {
  test("extracts file, line, and column from an http:// frame with a query string", () => {
    const line =
      "    at handleClick (http://localhost:3000/_next/static/chunks/app.js?v=123:1:100)";
    const result = parseFrameLine(line);
    expect(result).not.toBeNull();
    expect(result?.functionName).toBe("handleClick");
    expect(result?.file).toBe(
      "http://localhost:3000/_next/static/chunks/app.js?v=123"
    );
    expect(result?.line).toBe(1);
    expect(result?.column).toBe(100);
  });

  test("extracts file, line, and column from an https:// frame with a port and query string", () => {
    const line =
      "    at Component (https://cdn.example.com:8443/assets/app.js?v=abc&x=1:20:5)";
    const result = parseFrameLine(line);
    expect(result).not.toBeNull();
    expect(result?.functionName).toBe("Component");
    expect(result?.file).toBe(
      "https://cdn.example.com:8443/assets/app.js?v=abc&x=1"
    );
    expect(result?.line).toBe(20);
    expect(result?.column).toBe(5);
  });

  test("extracts file, line, and column from an anonymous (no function name) URL frame", () => {
    const line =
      "    at http://localhost:3000/_next/static/chunks/app.js?v=123:5:10";
    const result = parseFrameLine(line);
    expect(result).not.toBeNull();
    expect(result?.functionName).toBeUndefined();
    expect(result?.file).toBe(
      "http://localhost:3000/_next/static/chunks/app.js?v=123"
    );
    expect(result?.line).toBe(5);
    expect(result?.column).toBe(10);
  });

  test("still extracts a plain file-path frame (non-URL) unaffected by the URL branch", () => {
    const line = "  at Component (app.js:1:100)";
    const result = parseFrameLine(line);
    expect(result).not.toBeNull();
    expect(result?.functionName).toBe("Component");
    expect(result?.file).toBe("app.js");
    expect(result?.line).toBe(1);
    expect(result?.column).toBe(100);
  });
});

// ─── parseFrames — full stack ──────────────────────────────────────────────────

describe("parseFrames — realistic browser stack", () => {
  const stack = [
    "TypeError: Cannot read properties of undefined (reading 'foo')",
    "    at handleClick (http://localhost:3000/_next/static/chunks/app.js?v=123:1:100)",
    "    at onClick (http://localhost:3000/_next/static/chunks/app.js?v=123:2:50)",
    "    at HTMLButtonElement.callCallback (http://localhost:3000/_next/static/chunks/react-dom.js:1:1)",
  ].join("\n");

  test("returns one frame per stack line, in original order", () => {
    const frames = parseFrames(stack);
    expect(frames).toHaveLength(3);
    expect(frames[0].functionName).toBe("handleClick");
    expect(frames[1].functionName).toBe("onClick");
    expect(frames[2].functionName).toBe("HTMLButtonElement.callCallback");
  });

  test("preserves the query string as part of each frame's file", () => {
    const frames = parseFrames(stack);
    expect(frames[0].file).toBe(
      "http://localhost:3000/_next/static/chunks/app.js?v=123"
    );
    expect(frames[1].file).toBe(
      "http://localhost:3000/_next/static/chunks/app.js?v=123"
    );
  });

  test("skips the non-frame message line at the top of the stack", () => {
    const frames = parseFrames(stack);
    expect(frames.every((f) => f.file.length > 0)).toBe(true);
    expect(frames).toHaveLength(3);
  });
});

// ─── computeFingerprint — feeds from URL-form frames ───────────────────────────

describe("computeFingerprint — stability with URL-form frames", () => {
  const stack = [
    "TypeError: boom",
    "    at handleClick (http://localhost:3000/_next/static/chunks/app.js?v=123:1:100)",
    "    at onClick (http://localhost:3000/_next/static/chunks/app.js?v=123:2:50)",
  ].join("\n");

  test("is stable across two calls with the same message and frames", () => {
    const frames = parseFrames(stack);
    const first = computeFingerprint("boom", frames);
    const second = computeFingerprint("boom", frames);
    expect(first).toBe(second);
  });

  test("changes when the top frame's location changes", () => {
    const frames = parseFrames(stack);
    const changedStack = [
      "TypeError: boom",
      "    at handleClick (http://localhost:3000/_next/static/chunks/app.js?v=123:9:900)",
      "    at onClick (http://localhost:3000/_next/static/chunks/app.js?v=123:2:50)",
    ].join("\n");
    const changedFrames = parseFrames(changedStack);

    const original = computeFingerprint("boom", frames);
    const changed = computeFingerprint("boom", changedFrames);
    expect(original).not.toBe(changed);
  });
});
