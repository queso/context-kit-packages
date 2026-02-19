import { describe, test, expect } from "bun:test";

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
