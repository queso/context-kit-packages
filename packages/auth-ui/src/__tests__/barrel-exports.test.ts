import { describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { resolve } from "path";

const pkgRoot = resolve(import.meta.dir, "../..");

describe("barrel exports", () => {
  describe("main entry point (src/index.ts)", () => {
    test("should export all form components as functions", async () => {
      const mod = await import("../index");
      const formComponents = [
        "SignIn",
        "SignUp",
        "ForgotPassword",
        "ResetPassword",
        "UserProfile",
        "ChangePassword",
        "SessionManagement",
      ];
      for (const name of formComponents) {
        expect(typeof (mod as Record<string, unknown>)[name]).toBe("function");
      }
    });

    test("should export utility components as functions", async () => {
      const mod = await import("../index");
      const utilityComponents = ["UserButton", "AuthGuard", "SocialButton"];
      for (const name of utilityComponents) {
        expect(typeof (mod as Record<string, unknown>)[name]).toBe("function");
      }
    });

    test("should export AuthRouter as a function", async () => {
      const mod = await import("../index");
      expect(typeof (mod as Record<string, unknown>)["AuthRouter"]).toBe(
        "function"
      );
    });

    test("should export all page components as functions", async () => {
      const mod = await import("../index");
      const pageComponents = [
        "SignInPage",
        "SignUpPage",
        "ForgotPasswordPage",
        "ResetPasswordPage",
        "UserProfilePage",
        "ChangePasswordPage",
        "SessionManagementPage",
      ];
      for (const name of pageComponents) {
        expect(typeof (mod as Record<string, unknown>)[name]).toBe("function");
      }
    });

    test("should NOT export client-only symbols (AuthProvider, useAuth, useSession)", async () => {
      const mod = await import("../index");
      expect((mod as Record<string, unknown>)["AuthProvider"]).toBeUndefined();
      expect((mod as Record<string, unknown>)["useAuth"]).toBeUndefined();
      expect((mod as Record<string, unknown>)["useSession"]).toBeUndefined();
    });
  });

  describe("client entry point (src/client.ts)", () => {
    test("should export AuthProvider, useAuth, and useSession as functions", async () => {
      const mod = await import("../client");
      expect(typeof (mod as Record<string, unknown>)["AuthProvider"]).toBe(
        "function"
      );
      expect(typeof (mod as Record<string, unknown>)["useAuth"]).toBe(
        "function"
      );
      expect(typeof (mod as Record<string, unknown>)["useSession"]).toBe(
        "function"
      );
    });

    test("should only export AuthProvider, useAuth, and useSession", async () => {
      const mod = await import("../client");
      const exportedKeys = Object.keys(mod);
      const allowedExports = ["AuthProvider", "useAuth", "useSession"];
      for (const key of exportedKeys) {
        expect(allowedExports).toContain(key);
      }
    });
  });

  describe("build artifacts", () => {
    test("build produces dist/index.js and dist/client.js", () => {
      execSync("bun run build", { cwd: pkgRoot, stdio: "pipe" });
      expect(existsSync(resolve(pkgRoot, "dist/index.js"))).toBe(true);
      expect(existsSync(resolve(pkgRoot, "dist/client.js"))).toBe(true);
    });

    test("build produces declaration files dist/index.d.ts and dist/client.d.ts", () => {
      // Build already ran in previous test; just check outputs exist
      expect(existsSync(resolve(pkgRoot, "dist/index.d.ts"))).toBe(true);
      expect(existsSync(resolve(pkgRoot, "dist/client.d.ts"))).toBe(true);
    });
  });
});
