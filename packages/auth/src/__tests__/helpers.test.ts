import { describe, test, expect } from "bun:test";
import { memoizeAsync } from "./helpers";

describe("memoizeAsync", () => {
  test("does not cache a rejected first call, so a later call retries the factory", async () => {
    let calls = 0;
    const memoized = memoizeAsync(async () => {
      calls++;
      if (calls === 1) {
        throw new Error("transient failure");
      }
      return "ok";
    });

    await expect(memoized()).rejects.toThrow("transient failure");
    expect(calls).toBe(1);

    await expect(memoized()).resolves.toBe("ok");
    expect(calls).toBe(2);
  });

  test("caches a resolved call, so the factory runs once across repeated calls", async () => {
    let calls = 0;
    const memoized = memoizeAsync(async () => {
      calls++;
      return calls;
    });

    const [a, b, c] = await Promise.all([memoized(), memoized(), memoized()]);
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(c).toBe(1);
    expect(calls).toBe(1);

    const d = await memoized();
    expect(d).toBe(1);
    expect(calls).toBe(1);
  });
});
