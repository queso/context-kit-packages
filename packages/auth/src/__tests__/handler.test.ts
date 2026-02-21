import { describe, test, expect } from "bun:test";
import { validConfig, setupEnvGuard } from "./helpers";

setupEnvGuard();

describe("toNextJsHandler", () => {
  test("returns an object with GET and POST functions", async () => {
    const { createAuth } = await import("../create-auth");
    const { toNextJsHandler } = await import("../handler");
    const auth = createAuth(validConfig());
    const handlers = toNextJsHandler(auth);

    expect(handlers).toBeDefined();
    expect(typeof handlers.GET).toBe("function");
    expect(typeof handlers.POST).toBe("function");
  });

  test("GET handler is callable and returns a Response", async () => {
    const { createAuth } = await import("../create-auth");
    const { toNextJsHandler } = await import("../handler");
    const auth = createAuth(validConfig());
    const { GET } = toNextJsHandler(auth);

    const request = new Request("http://localhost:3000/api/auth/session");
    const response = await GET(request);
    expect(response).toBeInstanceOf(Response);
  });

  test("POST handler is callable and returns a Response", async () => {
    const { createAuth } = await import("../create-auth");
    const { toNextJsHandler } = await import("../handler");
    const auth = createAuth(validConfig());
    const { POST } = toNextJsHandler(auth);

    const request = new Request("http://localhost:3000/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "test@example.com",
        password: "test-password-123",
        name: "Test User",
      }),
    });
    const response = await POST(request);
    expect(response).toBeInstanceOf(Response);
  });
});
