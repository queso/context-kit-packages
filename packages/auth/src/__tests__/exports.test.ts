import { describe, test, expect } from "bun:test";
import type { AuthDialect } from "../index";

describe("barrel exports", () => {
  test("index module exports createAuth, toNextJsHandler, getSession, getUser", async () => {
    const indexModule = await import("../index");
    expect(typeof indexModule.createAuth).toBe("function");
    expect(typeof indexModule.toNextJsHandler).toBe("function");
    expect(typeof indexModule.getSession).toBe("function");
    expect(typeof indexModule.getUser).toBe("function");
  });

  test("middleware module exports createAuthMiddleware", async () => {
    const middlewareModule = await import("../middleware");
    expect(typeof middlewareModule.createAuthMiddleware).toBe("function");
  });

  test("client module exports createAuthClient", async () => {
    const clientModule = await import("../client");
    expect(typeof clientModule.createAuthClient).toBe("function");
  });

});

// `AuthDialect` is a type-only export, so the barrel re-export is checked by
// `tsc --noEmit`, not at runtime: the `import type` above and this `satisfies`
// both fail to compile if `index.ts` stops exporting it. There is nothing a
// runtime assertion could add, so none is made.
"sqlite" satisfies AuthDialect;
