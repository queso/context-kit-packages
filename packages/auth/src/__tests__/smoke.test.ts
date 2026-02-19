import { describe, test, expect } from "bun:test";

describe("bun:test infrastructure", () => {
  test("test runner is working", () => {
    expect(true).toBe(true);
  });

  test("basic arithmetic", () => {
    expect(1 + 1).toBe(2);
  });
});
