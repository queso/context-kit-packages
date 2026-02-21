import { describe, test, expect } from "bun:test";
import { validConfig, setupEnvGuard } from "./helpers";

setupEnvGuard();

describe("social provider configuration", () => {
  test("auth works with no social providers (omitted)", async () => {
    const { createAuth } = await import("../create-auth");
    const auth = createAuth(validConfig());
    expect(auth).toBeDefined();
    expect(typeof auth.handler).toBe("function");
  });

  test("auth works with socialProviders explicitly undefined", async () => {
    const { createAuth } = await import("../create-auth");
    const auth = createAuth(validConfig({ socialProviders: undefined }));
    expect(auth).toBeDefined();
    expect(typeof auth.handler).toBe("function");
  });

  test("google provider configured correctly via record", async () => {
    const { createAuth } = await import("../create-auth");
    const auth = createAuth(
      validConfig({
        socialProviders: {
          google: {
            clientId: "google-client-id",
            clientSecret: "google-client-secret",
          },
        },
      })
    );
    expect(auth).toBeDefined();
    expect(typeof auth.handler).toBe("function");
  });

  test("missing clientId throws error naming the provider and field", async () => {
    const { createAuth } = await import("../create-auth");
    expect(() =>
      createAuth(
        validConfig({
          socialProviders: {
            google: {
              clientId: "",
              clientSecret: "google-client-secret",
            },
          },
        })
      )
    ).toThrow(/google.*clientId/i);
  });

  test("missing clientSecret throws error naming the provider and field", async () => {
    const { createAuth } = await import("../create-auth");
    expect(() =>
      createAuth(
        validConfig({
          socialProviders: {
            github: {
              clientId: "github-client-id",
              clientSecret: "",
            },
          },
        })
      )
    ).toThrow(/github.*clientSecret/i);
  });

  test("multiple providers can be configured simultaneously", async () => {
    const { createAuth } = await import("../create-auth");
    const auth = createAuth(
      validConfig({
        socialProviders: {
          google: {
            clientId: "google-client-id",
            clientSecret: "google-client-secret",
          },
          github: {
            clientId: "github-client-id",
            clientSecret: "github-client-secret",
          },
        },
      })
    );
    expect(auth).toBeDefined();
    expect(typeof auth.handler).toBe("function");
  });
});
