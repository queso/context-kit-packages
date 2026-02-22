import { describe, test, expect, mock, beforeEach } from "bun:test";
import { render, screen } from "@testing-library/react";
import { existsSync } from "fs";
import { resolve } from "path";
import React from "react";

const pkgRoot = resolve(import.meta.dir, "../..");

function fileExists(relativePath: string) {
  return existsSync(resolve(pkgRoot, relativePath));
}

// ---------------------------------------------------------------------------
// Mock @context-kit/auth/client so tests run without a real Better Auth setup
// ---------------------------------------------------------------------------

const mockUseSession = mock(() => ({
  data: null,
  isPending: false,
  error: null,
}));

const mockAuthClient = {
  signIn: {
    email: mock(() => Promise.resolve({ data: { user: { id: "u1" } }, error: null })),
    social: mock(() => Promise.resolve({ data: { url: "https://accounts.google.com" }, error: null })),
  },
  signUp: {
    email: mock(() => Promise.resolve({ data: { user: { id: "u1" } }, error: null })),
  },
  signOut: mock(() => Promise.resolve({ data: { status: true }, error: null })),
  useSession: mockUseSession,
  forgetPassword: mock(() => Promise.resolve({ data: { status: true }, error: null })),
  resetPassword: mock(() => Promise.resolve({ data: { status: true }, error: null })),
};

mock.module("@context-kit/auth/client", () => ({
  createAuthClient: mock(() => mockAuthClient),
}));

// ---------------------------------------------------------------------------
// Mock next/navigation
// ---------------------------------------------------------------------------

const mockPush = mock((_url: string) => {});

mock.module("next/navigation", () => ({
  useRouter: mock(() => ({
    push: mockPush,
    replace: mock(() => {}),
    back: mock(() => {}),
  })),
  useSearchParams: mock(() => ({ get: mock(() => null) })),
  usePathname: mock(() => "/"),
}));

// ---------------------------------------------------------------------------
// Mock page components so routing logic can be tested independently
// ---------------------------------------------------------------------------

mock.module("../components/pages/sign-in-page", () => ({
  SignInPage: (props: Record<string, unknown>) =>
    React.createElement("div", { "data-testid": "sign-in-page", ...props }),
}));

mock.module("../components/pages/sign-up-page", () => ({
  SignUpPage: (props: Record<string, unknown>) =>
    React.createElement("div", { "data-testid": "sign-up-page", ...props }),
}));

mock.module("../components/pages/forgot-password-page", () => ({
  ForgotPasswordPage: (props: Record<string, unknown>) =>
    React.createElement("div", { "data-testid": "forgot-password-page", ...props }),
}));

mock.module("../components/pages/reset-password-page", () => ({
  ResetPasswordPage: (props: Record<string, unknown>) =>
    React.createElement("div", { "data-testid": "reset-password-page", ...props }),
}));

mock.module("../components/pages/user-profile-page", () => ({
  UserProfilePage: (props: Record<string, unknown>) =>
    React.createElement("div", { "data-testid": "user-profile-page", ...props }),
}));

mock.module("../components/pages/change-password-page", () => ({
  ChangePasswordPage: (props: Record<string, unknown>) =>
    React.createElement("div", { "data-testid": "change-password-page", ...props }),
}));

mock.module("../components/pages/session-management-page", () => ({
  SessionManagementPage: (props: Record<string, unknown>) =>
    React.createElement("div", { "data-testid": "session-management-page", ...props }),
}));

// ---------------------------------------------------------------------------
// Wrapper: AuthProvider
// ---------------------------------------------------------------------------

async function getWrapper() {
  const { AuthProvider } = await import("../components/auth-provider");
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <AuthProvider baseURL="http://localhost:3000">{children}</AuthProvider>;
  };
}

// ---------------------------------------------------------------------------
// File existence
// ---------------------------------------------------------------------------

describe("file structure — AuthRouter", () => {
  test("src/components/auth-router.tsx exists", () => {
    expect(fileExists("src/components/auth-router.tsx")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AuthRouter export
// ---------------------------------------------------------------------------

describe("AuthRouter export", () => {
  test("AuthRouter is exported from src/components/auth-router", async () => {
    const mod = await import("../components/auth-router");
    expect(typeof mod.AuthRouter).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Default routing — each default path renders the correct component
// ---------------------------------------------------------------------------

describe("AuthRouter — default path routing", () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  test('["sign-in"] renders SignInPage', async () => {
    const { AuthRouter } = await import("../components/auth-router");
    const Wrapper = await getWrapper();
    render(<AuthRouter params={{ authPath: ["sign-in"] }} />, { wrapper: Wrapper });
    expect(screen.getByTestId("sign-in-page")).toBeDefined();
  });

  test('["sign-up"] renders SignUpPage', async () => {
    const { AuthRouter } = await import("../components/auth-router");
    const Wrapper = await getWrapper();
    render(<AuthRouter params={{ authPath: ["sign-up"] }} />, { wrapper: Wrapper });
    expect(screen.getByTestId("sign-up-page")).toBeDefined();
  });

  test('["forgot-password"] renders ForgotPasswordPage', async () => {
    const { AuthRouter } = await import("../components/auth-router");
    const Wrapper = await getWrapper();
    render(<AuthRouter params={{ authPath: ["forgot-password"] }} />, { wrapper: Wrapper });
    expect(screen.getByTestId("forgot-password-page")).toBeDefined();
  });

  test('["reset-password"] renders ResetPasswordPage', async () => {
    const { AuthRouter } = await import("../components/auth-router");
    const Wrapper = await getWrapper();
    render(<AuthRouter params={{ authPath: ["reset-password"] }} />, { wrapper: Wrapper });
    expect(screen.getByTestId("reset-password-page")).toBeDefined();
  });

  test('["profile"] renders UserProfilePage', async () => {
    const { AuthRouter } = await import("../components/auth-router");
    const Wrapper = await getWrapper();
    render(<AuthRouter params={{ authPath: ["profile"] }} />, { wrapper: Wrapper });
    expect(screen.getByTestId("user-profile-page")).toBeDefined();
  });

  test('["profile", "password"] renders ChangePasswordPage', async () => {
    const { AuthRouter } = await import("../components/auth-router");
    const Wrapper = await getWrapper();
    render(<AuthRouter params={{ authPath: ["profile", "password"] }} />, { wrapper: Wrapper });
    expect(screen.getByTestId("change-password-page")).toBeDefined();
  });

  test('["profile", "sessions"] renders SessionManagementPage', async () => {
    const { AuthRouter } = await import("../components/auth-router");
    const Wrapper = await getWrapper();
    render(<AuthRouter params={{ authPath: ["profile", "sessions"] }} />, { wrapper: Wrapper });
    expect(screen.getByTestId("session-management-page")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 404 handling — unknown paths render "Page not found"
// ---------------------------------------------------------------------------

describe("AuthRouter — 404 handling", () => {
  test("unknown path shows 'Page not found'", async () => {
    const { AuthRouter } = await import("../components/auth-router");
    const Wrapper = await getWrapper();
    render(<AuthRouter params={{ authPath: ["unknown-route"] }} />, { wrapper: Wrapper });
    expect(screen.getByText(/page not found/i)).toBeDefined();
  });

  test("unknown path renders a link to sign-in", async () => {
    const { AuthRouter } = await import("../components/auth-router");
    const Wrapper = await getWrapper();
    render(<AuthRouter params={{ authPath: ["unknown-route"] }} />, { wrapper: Wrapper });
    const link = screen.getByRole("link");
    expect(link).toBeDefined();
    const href = link.getAttribute("href") ?? "";
    expect(href).toMatch(/sign-in|login/i);
  });

  test("deeply unknown multi-segment path shows 'Page not found'", async () => {
    const { AuthRouter } = await import("../components/auth-router");
    const Wrapper = await getWrapper();
    render(<AuthRouter params={{ authPath: ["profile", "nonexistent"] }} />, { wrapper: Wrapper });
    expect(screen.getByText(/page not found/i)).toBeDefined();
  });

  test("empty authPath array shows 'Page not found'", async () => {
    const { AuthRouter } = await import("../components/auth-router");
    const Wrapper = await getWrapper();
    render(<AuthRouter params={{ authPath: [] }} />, { wrapper: Wrapper });
    expect(screen.getByText(/page not found/i)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// pathMap — custom path maps override defaults
// ---------------------------------------------------------------------------

describe("AuthRouter — pathMap customization", () => {
  test("pathMap can map a custom path to signIn", async () => {
    const { AuthRouter } = await import("../components/auth-router");
    const Wrapper = await getWrapper();
    render(
      <AuthRouter
        params={{ authPath: ["login"] }}
        pathMap={{ "/login": "signIn" }}
      />,
      { wrapper: Wrapper }
    );
    expect(screen.getByTestId("sign-in-page")).toBeDefined();
  });

  test("pathMap can map a custom path to signUp", async () => {
    const { AuthRouter } = await import("../components/auth-router");
    const Wrapper = await getWrapper();
    render(
      <AuthRouter
        params={{ authPath: ["register"] }}
        pathMap={{ "/register": "signUp" }}
      />,
      { wrapper: Wrapper }
    );
    expect(screen.getByTestId("sign-up-page")).toBeDefined();
  });

  test("pathMap does not affect unrelated paths", async () => {
    const { AuthRouter } = await import("../components/auth-router");
    const Wrapper = await getWrapper();
    render(
      <AuthRouter
        params={{ authPath: ["sign-in"] }}
        pathMap={{ "/login": "signIn" }}
      />,
      { wrapper: Wrapper }
    );
    // The default sign-in path still works
    expect(screen.getByTestId("sign-in-page")).toBeDefined();
  });

  test("pathMap with unknown key still shows 404 for that custom path", async () => {
    const { AuthRouter } = await import("../components/auth-router");
    const Wrapper = await getWrapper();
    render(
      <AuthRouter
        params={{ authPath: ["mystery"] }}
        pathMap={{ "/login": "signIn" }}
      />,
      { wrapper: Wrapper }
    );
    expect(screen.getByText(/page not found/i)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Props passthrough — page-specific props are forwarded to the right component
// ---------------------------------------------------------------------------

describe("AuthRouter — props passthrough", () => {
  test("signInProps are passed to SignInPage", async () => {
    const { AuthRouter } = await import("../components/auth-router");
    const Wrapper = await getWrapper();
    render(
      <AuthRouter
        params={{ authPath: ["sign-in"] }}
        signInProps={{ className: "custom-sign-in" }}
      />,
      { wrapper: Wrapper }
    );
    const page = screen.getByTestId("sign-in-page");
    expect(page.className).toContain("custom-sign-in");
  });

  test("signUpProps are passed to SignUpPage", async () => {
    const { AuthRouter } = await import("../components/auth-router");
    const Wrapper = await getWrapper();
    render(
      <AuthRouter
        params={{ authPath: ["sign-up"] }}
        signUpProps={{ className: "custom-sign-up" }}
      />,
      { wrapper: Wrapper }
    );
    const page = screen.getByTestId("sign-up-page");
    expect(page.className).toContain("custom-sign-up");
  });

  test("signInProps are not passed to SignUpPage", async () => {
    const { AuthRouter } = await import("../components/auth-router");
    const Wrapper = await getWrapper();
    render(
      <AuthRouter
        params={{ authPath: ["sign-up"] }}
        signInProps={{ className: "sign-in-only-class" }}
      />,
      { wrapper: Wrapper }
    );
    const page = screen.getByTestId("sign-up-page");
    expect(page.className ?? "").not.toContain("sign-in-only-class");
  });
});

// ---------------------------------------------------------------------------
// className — wrapper element accepts className
// ---------------------------------------------------------------------------

describe("AuthRouter — className prop", () => {
  test("accepts className prop and applies it to a wrapper element", async () => {
    const { AuthRouter } = await import("../components/auth-router");
    const Wrapper = await getWrapper();
    const { container } = render(
      <AuthRouter
        params={{ authPath: ["sign-in"] }}
        className="custom-auth-router"
      />,
      { wrapper: Wrapper }
    );
    expect(container.querySelector(".custom-auth-router")).toBeDefined();
  });

  test("className does not interfere with routing", async () => {
    const { AuthRouter } = await import("../components/auth-router");
    const Wrapper = await getWrapper();
    render(
      <AuthRouter
        params={{ authPath: ["sign-up"] }}
        className="wrapper-class"
      />,
      { wrapper: Wrapper }
    );
    expect(screen.getByTestId("sign-up-page")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Multi-segment paths
// ---------------------------------------------------------------------------

describe("AuthRouter — multi-segment paths", () => {
  test('["profile", "password"] correctly navigates to ChangePasswordPage', async () => {
    const { AuthRouter } = await import("../components/auth-router");
    const Wrapper = await getWrapper();
    render(<AuthRouter params={{ authPath: ["profile", "password"] }} />, { wrapper: Wrapper });
    expect(screen.getByTestId("change-password-page")).toBeDefined();
    expect(screen.queryByTestId("user-profile-page")).toBeNull();
  });

  test('["profile", "sessions"] correctly navigates to SessionManagementPage', async () => {
    const { AuthRouter } = await import("../components/auth-router");
    const Wrapper = await getWrapper();
    render(<AuthRouter params={{ authPath: ["profile", "sessions"] }} />, { wrapper: Wrapper });
    expect(screen.getByTestId("session-management-page")).toBeDefined();
    expect(screen.queryByTestId("user-profile-page")).toBeNull();
  });

  test('["profile"] does not render ChangePasswordPage', async () => {
    const { AuthRouter } = await import("../components/auth-router");
    const Wrapper = await getWrapper();
    render(<AuthRouter params={{ authPath: ["profile"] }} />, { wrapper: Wrapper });
    expect(screen.queryByTestId("change-password-page")).toBeNull();
    expect(screen.getByTestId("user-profile-page")).toBeDefined();
  });

  test('["profile"] does not render SessionManagementPage', async () => {
    const { AuthRouter } = await import("../components/auth-router");
    const Wrapper = await getWrapper();
    render(<AuthRouter params={{ authPath: ["profile"] }} />, { wrapper: Wrapper });
    expect(screen.queryByTestId("session-management-page")).toBeNull();
    expect(screen.getByTestId("user-profile-page")).toBeDefined();
  });
});
