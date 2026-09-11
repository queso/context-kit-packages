import { describe, test, expect } from "bun:test";

describe("client entry point", () => {
  test("createAuthClient is exported and callable", async () => {
    const clientModule = await import("../client");
    expect(typeof clientModule.createAuthClient).toBe("function");
  });

  test("createAuthClient returns an object with expected auth methods", async () => {
    const { createAuthClient } = await import("../client");
    const client = createAuthClient({ baseURL: "http://localhost:3000" });
    expect(typeof client.useSession).toBe("function");
    expect(typeof client.signIn).toBe("function");
    expect(typeof client.signUp).toBe("function");
    expect(typeof client.signOut).toBe("function");
  });

  test("client module does not re-export server-only modules", async () => {
    // Importing the client module must not throw due to server-side imports
    // (e.g. next/headers, drizzle adapter). If it does, the module is polluted.
    const clientModule = await import("../client");
    // createAuthClient should be the only named export from our entry point
    expect("createAuthClient" in clientModule).toBe(true);
    // Ensure server-only identifiers are not present
    expect("drizzleAdapter" in clientModule).toBe(false);
    expect("createAuth" in clientModule).toBe(false);
  });
});
