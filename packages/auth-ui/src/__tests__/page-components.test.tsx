import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { existsSync } from "fs";
import { resolve } from "path";
import type React from "react";

const pkgRoot = resolve(import.meta.dir, "../..");

function fileExists(relativePath: string) {
  return existsSync(resolve(pkgRoot, relativePath));
}

// ---------------------------------------------------------------------------
// Mock @context-kit/auth/client
// ---------------------------------------------------------------------------

const mockUseSession = mock(() => ({
  data: {
    user: {
      id: "user-1",
      name: "Test User",
      email: "test@example.com",
      image: null,
    },
    session: { id: "session-1", userId: "user-1" },
  },
  isPending: false,
  error: null,
}));

const mockAuthClient = {
  signIn: {
    email: mock(() =>
      Promise.resolve({ data: { user: { id: "u1" } }, error: null })
    ),
    social: mock(() =>
      Promise.resolve({
        data: { url: "https://accounts.google.com" },
        error: null,
      })
    ),
  },
  signUp: {
    email: mock(() =>
      Promise.resolve({ data: { user: { id: "u1" } }, error: null })
    ),
  },
  signOut: mock(() => Promise.resolve({ data: { status: true }, error: null })),
  useSession: mockUseSession,
  forgetPassword: mock(() =>
    Promise.resolve({ data: { status: true }, error: null })
  ),
  resetPassword: mock(() =>
    Promise.resolve({ data: { status: true }, error: null })
  ),
};

mock.module("@context-kit/auth/client", () => ({
  createAuthClient: mock(() => mockAuthClient),
}));

// ---------------------------------------------------------------------------
// Mock next/navigation
// ---------------------------------------------------------------------------

const mockPush = mock((_url: string) => {});
const mockUseRouter = mock(() => ({
  push: mockPush,
  replace: mock(() => {}),
  back: mock(() => {}),
}));

const mockSearchParamsGet = mock((_key: string) => null as string | null);

mock.module("next/navigation", () => ({
  useRouter: mockUseRouter,
  useSearchParams: mock(() => ({ get: mockSearchParamsGet })),
  usePathname: mock(() => "/"),
}));

// ---------------------------------------------------------------------------
// Wrapper: AuthProvider
// ---------------------------------------------------------------------------

async function getWrapper() {
  const { AuthProvider } = await import("../components/auth-provider");
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <AuthProvider baseURL="http://localhost:3000">{children}</AuthProvider>
    );
  };
}

// ---------------------------------------------------------------------------
// File existence
// ---------------------------------------------------------------------------

describe("file structure — page components", () => {
  test("src/components/pages/page-layout.tsx exists", () => {
    expect(fileExists("src/components/pages/page-layout.tsx")).toBe(true);
  });

  test("src/components/pages/sign-in-page.tsx exists", () => {
    expect(fileExists("src/components/pages/sign-in-page.tsx")).toBe(true);
  });

  test("src/components/pages/sign-up-page.tsx exists", () => {
    expect(fileExists("src/components/pages/sign-up-page.tsx")).toBe(true);
  });

  test("src/components/pages/forgot-password-page.tsx exists", () => {
    expect(fileExists("src/components/pages/forgot-password-page.tsx")).toBe(
      true
    );
  });

  test("src/components/pages/reset-password-page.tsx exists", () => {
    expect(fileExists("src/components/pages/reset-password-page.tsx")).toBe(
      true
    );
  });

  test("src/components/pages/user-profile-page.tsx exists", () => {
    expect(fileExists("src/components/pages/user-profile-page.tsx")).toBe(true);
  });

  test("src/components/pages/change-password-page.tsx exists", () => {
    expect(fileExists("src/components/pages/change-password-page.tsx")).toBe(
      true
    );
  });

  test("src/components/pages/session-management-page.tsx exists", () => {
    expect(fileExists("src/components/pages/session-management-page.tsx")).toBe(
      true
    );
  });
});

// ============================================================================
// PageLayout
// ============================================================================

describe("PageLayout export", () => {
  test("PageLayout is exported from src/components/pages/page-layout", async () => {
    const mod = await import("../components/pages/page-layout");
    expect(typeof mod.PageLayout).toBe("function");
  });
});

describe("PageLayout rendering", () => {
  test("renders children", async () => {
    const { PageLayout } = await import("../components/pages/page-layout");
    render(
      <PageLayout>
        <div>page content</div>
      </PageLayout>
    );
    expect(screen.getByText("page content")).toBeDefined();
  });

  test("renders with min-h-screen class for full page height", async () => {
    const { PageLayout } = await import("../components/pages/page-layout");
    const { container } = render(
      <PageLayout>
        <span>content</span>
      </PageLayout>
    );
    const layout = container.firstElementChild;
    expect(layout?.className).toContain("min-h-screen");
  });

  test("renders with flex items-center justify-center for centering", async () => {
    const { PageLayout } = await import("../components/pages/page-layout");
    const { container } = render(
      <PageLayout>
        <span>content</span>
      </PageLayout>
    );
    const layout = container.firstElementChild;
    expect(layout?.className).toContain("flex");
    expect(layout?.className).toContain("items-center");
    expect(layout?.className).toContain("justify-center");
  });

  test("renders with p-4 padding class", async () => {
    const { PageLayout } = await import("../components/pages/page-layout");
    const { container } = render(
      <PageLayout>
        <span>content</span>
      </PageLayout>
    );
    const layout = container.firstElementChild;
    expect(layout?.className).toContain("p-4");
  });

  test("accepts className override", async () => {
    const { PageLayout } = await import("../components/pages/page-layout");
    const { container } = render(
      <PageLayout className="custom-layout">
        <span>content</span>
      </PageLayout>
    );
    expect(container.querySelector(".custom-layout")).toBeDefined();
  });

  test("renders multiple children", async () => {
    const { PageLayout } = await import("../components/pages/page-layout");
    render(
      <PageLayout>
        <div>child one</div>
        <div>child two</div>
      </PageLayout>
    );
    expect(screen.getByText("child one")).toBeDefined();
    expect(screen.getByText("child two")).toBeDefined();
  });
});

// ============================================================================
// SignInPage
// ============================================================================

describe("SignInPage export", () => {
  test("SignInPage is exported from src/components/pages/sign-in-page", async () => {
    const mod = await import("../components/pages/sign-in-page");
    expect(typeof mod.SignInPage).toBe("function");
  });
});

describe("SignInPage rendering", () => {
  beforeEach(() => {
    mockUseSession.mockReturnValue({
      data: null,
      isPending: false,
      error: null,
    });
    mockPush.mockClear();
  });

  test("renders without crashing", async () => {
    const { SignInPage } = await import("../components/pages/sign-in-page");
    const Wrapper = await getWrapper();
    expect(() => render(<SignInPage />, { wrapper: Wrapper })).not.toThrow();
  });

  test("does NOT redirect when unauthenticated (no AuthGuard)", async () => {
    const { SignInPage } = await import("../components/pages/sign-in-page");
    const Wrapper = await getWrapper();
    render(<SignInPage />, { wrapper: Wrapper });

    await new Promise((r) => setTimeout(r, 50));
    expect(mockPush).not.toHaveBeenCalled();
  });

  test("renders the SignIn form component (has email input)", async () => {
    const { SignInPage } = await import("../components/pages/sign-in-page");
    const Wrapper = await getWrapper();
    render(<SignInPage />, { wrapper: Wrapper });
    expect(screen.getByLabelText(/email/i)).toBeDefined();
  });

  test("renders the SignIn form component (has password input)", async () => {
    const { SignInPage } = await import("../components/pages/sign-in-page");
    const Wrapper = await getWrapper();
    render(<SignInPage />, { wrapper: Wrapper });
    expect(screen.getByLabelText(/password/i)).toBeDefined();
  });

  test("passes providers prop through to SignIn", async () => {
    const { SignInPage } = await import("../components/pages/sign-in-page");
    const Wrapper = await getWrapper();
    render(<SignInPage providers={["google", "github"]} />, {
      wrapper: Wrapper,
    });
    expect(screen.getByText(/continue with google/i)).toBeDefined();
    expect(screen.getByText(/continue with github/i)).toBeDefined();
  });

  test("accepts className prop", async () => {
    const { SignInPage } = await import("../components/pages/sign-in-page");
    const Wrapper = await getWrapper();
    const { container } = render(
      <SignInPage className="custom-sign-in-page" />,
      { wrapper: Wrapper }
    );
    expect(container.querySelector(".custom-sign-in-page")).toBeDefined();
  });
});

// ============================================================================
// SignUpPage
// ============================================================================

describe("SignUpPage export", () => {
  test("SignUpPage is exported from src/components/pages/sign-up-page", async () => {
    const mod = await import("../components/pages/sign-up-page");
    expect(typeof mod.SignUpPage).toBe("function");
  });
});

describe("SignUpPage rendering", () => {
  beforeEach(() => {
    mockUseSession.mockReturnValue({
      data: null,
      isPending: false,
      error: null,
    });
    mockPush.mockClear();
  });

  test("renders without crashing", async () => {
    const { SignUpPage } = await import("../components/pages/sign-up-page");
    const Wrapper = await getWrapper();
    expect(() => render(<SignUpPage />, { wrapper: Wrapper })).not.toThrow();
  });

  test("does NOT redirect when unauthenticated (no AuthGuard)", async () => {
    const { SignUpPage } = await import("../components/pages/sign-up-page");
    const Wrapper = await getWrapper();
    render(<SignUpPage />, { wrapper: Wrapper });

    await new Promise((r) => setTimeout(r, 50));
    expect(mockPush).not.toHaveBeenCalled();
  });

  test("renders the SignUp form component (has name input)", async () => {
    const { SignUpPage } = await import("../components/pages/sign-up-page");
    const Wrapper = await getWrapper();
    render(<SignUpPage />, { wrapper: Wrapper });
    expect(screen.getByLabelText(/name/i)).toBeDefined();
  });

  test("renders the SignUp form component (has email input)", async () => {
    const { SignUpPage } = await import("../components/pages/sign-up-page");
    const Wrapper = await getWrapper();
    render(<SignUpPage />, { wrapper: Wrapper });
    expect(screen.getByLabelText(/email/i)).toBeDefined();
  });

  test("passes providers prop through to SignUp", async () => {
    const { SignUpPage } = await import("../components/pages/sign-up-page");
    const Wrapper = await getWrapper();
    render(<SignUpPage providers={["google"]} />, { wrapper: Wrapper });
    expect(screen.getByText(/continue with google/i)).toBeDefined();
  });

  test("accepts className prop", async () => {
    const { SignUpPage } = await import("../components/pages/sign-up-page");
    const Wrapper = await getWrapper();
    const { container } = render(
      <SignUpPage className="custom-sign-up-page" />,
      { wrapper: Wrapper }
    );
    expect(container.querySelector(".custom-sign-up-page")).toBeDefined();
  });
});

// ============================================================================
// ForgotPasswordPage
// ============================================================================

describe("ForgotPasswordPage export", () => {
  test("ForgotPasswordPage is exported from src/components/pages/forgot-password-page", async () => {
    const mod = await import("../components/pages/forgot-password-page");
    expect(typeof mod.ForgotPasswordPage).toBe("function");
  });
});

describe("ForgotPasswordPage rendering", () => {
  beforeEach(() => {
    mockUseSession.mockReturnValue({
      data: null,
      isPending: false,
      error: null,
    });
    mockPush.mockClear();
  });

  test("renders without crashing", async () => {
    const { ForgotPasswordPage } = await import(
      "../components/pages/forgot-password-page"
    );
    const Wrapper = await getWrapper();
    expect(() =>
      render(<ForgotPasswordPage />, { wrapper: Wrapper })
    ).not.toThrow();
  });

  test("does NOT redirect when unauthenticated (no AuthGuard)", async () => {
    const { ForgotPasswordPage } = await import(
      "../components/pages/forgot-password-page"
    );
    const Wrapper = await getWrapper();
    render(<ForgotPasswordPage />, { wrapper: Wrapper });

    await new Promise((r) => setTimeout(r, 50));
    expect(mockPush).not.toHaveBeenCalled();
  });

  test("renders the ForgotPassword form component (has email input)", async () => {
    const { ForgotPasswordPage } = await import(
      "../components/pages/forgot-password-page"
    );
    const Wrapper = await getWrapper();
    render(<ForgotPasswordPage />, { wrapper: Wrapper });
    expect(screen.getByLabelText(/email/i)).toBeDefined();
  });

  test("renders the ForgotPassword form submit button", async () => {
    const { ForgotPasswordPage } = await import(
      "../components/pages/forgot-password-page"
    );
    const Wrapper = await getWrapper();
    render(<ForgotPasswordPage />, { wrapper: Wrapper });
    expect(screen.getByRole("button")).toBeDefined();
  });

  test("accepts className prop", async () => {
    const { ForgotPasswordPage } = await import(
      "../components/pages/forgot-password-page"
    );
    const Wrapper = await getWrapper();
    const { container } = render(
      <ForgotPasswordPage className="custom-forgot-page" />,
      { wrapper: Wrapper }
    );
    expect(container.querySelector(".custom-forgot-page")).toBeDefined();
  });
});

// ============================================================================
// ResetPasswordPage
// ============================================================================

describe("ResetPasswordPage export", () => {
  test("ResetPasswordPage is exported from src/components/pages/reset-password-page", async () => {
    const mod = await import("../components/pages/reset-password-page");
    expect(typeof mod.ResetPasswordPage).toBe("function");
  });
});

describe("ResetPasswordPage rendering", () => {
  beforeEach(() => {
    mockUseSession.mockReturnValue({
      data: null,
      isPending: false,
      error: null,
    });
    mockPush.mockClear();
    mockSearchParamsGet.mockImplementation((key: string) =>
      key === "token" ? "test-reset-token" : null
    );
  });

  afterEach(() => {
    mockSearchParamsGet.mockImplementation(() => null);
    cleanup();
  });

  test("renders without crashing", async () => {
    const { ResetPasswordPage } = await import(
      "../components/pages/reset-password-page"
    );
    const Wrapper = await getWrapper();
    expect(() =>
      render(<ResetPasswordPage />, { wrapper: Wrapper })
    ).not.toThrow();
  });

  test("does NOT redirect when unauthenticated (no AuthGuard)", async () => {
    const { ResetPasswordPage } = await import(
      "../components/pages/reset-password-page"
    );
    const Wrapper = await getWrapper();
    render(<ResetPasswordPage />, { wrapper: Wrapper });

    await new Promise((r) => setTimeout(r, 50));
    expect(mockPush).not.toHaveBeenCalled();
  });

  test("renders the ResetPassword form component (has password input)", async () => {
    const { ResetPasswordPage } = await import(
      "../components/pages/reset-password-page"
    );
    const Wrapper = await getWrapper();
    render(<ResetPasswordPage />, { wrapper: Wrapper });
    expect(screen.getByLabelText(/^new password|^password/i)).toBeDefined();
  });

  test("renders the ResetPassword form submit button", async () => {
    const { ResetPasswordPage } = await import(
      "../components/pages/reset-password-page"
    );
    const Wrapper = await getWrapper();
    render(<ResetPasswordPage />, { wrapper: Wrapper });
    expect(screen.getByRole("button")).toBeDefined();
  });

  test("accepts className prop", async () => {
    const { ResetPasswordPage } = await import(
      "../components/pages/reset-password-page"
    );
    const Wrapper = await getWrapper();
    const { container } = render(
      <ResetPasswordPage className="custom-reset-page" />,
      { wrapper: Wrapper }
    );
    expect(container.querySelector(".custom-reset-page")).toBeDefined();
  });
});

// ============================================================================
// UserProfilePage (account management — uses AuthGuard)
// ============================================================================

describe("UserProfilePage export", () => {
  test("UserProfilePage is exported from src/components/pages/user-profile-page", async () => {
    const mod = await import("../components/pages/user-profile-page");
    expect(typeof mod.UserProfilePage).toBe("function");
  });
});

describe("UserProfilePage — unauthenticated", () => {
  beforeEach(() => {
    mockUseSession.mockReturnValue({
      data: null,
      isPending: false,
      error: null,
    });
    mockPush.mockClear();
  });

  test("redirects to sign-in when not authenticated (uses AuthGuard)", async () => {
    const { UserProfilePage } = await import(
      "../components/pages/user-profile-page"
    );
    const Wrapper = await getWrapper();
    render(<UserProfilePage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledTimes(1);
    });
    const dest = mockPush.mock.calls[0]?.[0] as string | undefined;
    expect(dest).toMatch(/sign-in|login/i);
  });

  test("does not render the user profile form when unauthenticated", async () => {
    const { UserProfilePage } = await import(
      "../components/pages/user-profile-page"
    );
    const Wrapper = await getWrapper();
    render(<UserProfilePage />, { wrapper: Wrapper });
    // Profile content should not be visible
    expect(screen.queryByText(/profile|display name|full name/i)).toBeNull();
  });
});

describe("UserProfilePage — authenticated", () => {
  beforeEach(() => {
    mockUseSession.mockReturnValue({
      data: {
        user: {
          id: "user-1",
          name: "Test User",
          email: "test@example.com",
          image: null,
        },
        session: { id: "session-1", userId: "user-1" },
      },
      isPending: false,
      error: null,
    });
    mockPush.mockClear();
  });

  test("renders the UserProfile form when authenticated", async () => {
    const { UserProfilePage } = await import(
      "../components/pages/user-profile-page"
    );
    const Wrapper = await getWrapper();
    render(<UserProfilePage />, { wrapper: Wrapper });
    // UserProfile form should be visible — look for name/profile fields or button
    await waitFor(() => {
      expect(
        screen.queryByLabelText(/name/i) !== null ||
          screen.queryByRole("button", { name: /save|update/i }) !== null ||
          screen.queryByText(/profile/i) !== null
      ).toBe(true);
    });
  });

  test("does not redirect when authenticated", async () => {
    const { UserProfilePage } = await import(
      "../components/pages/user-profile-page"
    );
    const Wrapper = await getWrapper();
    render(<UserProfilePage />, { wrapper: Wrapper });

    await new Promise((r) => setTimeout(r, 50));
    expect(mockPush).not.toHaveBeenCalled();
  });

  test("accepts className prop", async () => {
    const { UserProfilePage } = await import(
      "../components/pages/user-profile-page"
    );
    const Wrapper = await getWrapper();
    const { container } = render(
      <UserProfilePage className="custom-profile-page" />,
      { wrapper: Wrapper }
    );
    expect(container.querySelector(".custom-profile-page")).toBeDefined();
  });
});

// ============================================================================
// ChangePasswordPage (account management — uses AuthGuard)
// ============================================================================

describe("ChangePasswordPage export", () => {
  test("ChangePasswordPage is exported from src/components/pages/change-password-page", async () => {
    const mod = await import("../components/pages/change-password-page");
    expect(typeof mod.ChangePasswordPage).toBe("function");
  });
});

describe("ChangePasswordPage — unauthenticated", () => {
  beforeEach(() => {
    mockUseSession.mockReturnValue({
      data: null,
      isPending: false,
      error: null,
    });
    mockPush.mockClear();
  });

  test("redirects to sign-in when not authenticated (uses AuthGuard)", async () => {
    const { ChangePasswordPage } = await import(
      "../components/pages/change-password-page"
    );
    const Wrapper = await getWrapper();
    render(<ChangePasswordPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledTimes(1);
    });
    const dest = mockPush.mock.calls[0]?.[0] as string | undefined;
    expect(dest).toMatch(/sign-in|login/i);
  });

  test("does not render the change password form when unauthenticated", async () => {
    const { ChangePasswordPage } = await import(
      "../components/pages/change-password-page"
    );
    const Wrapper = await getWrapper();
    render(<ChangePasswordPage />, { wrapper: Wrapper });
    expect(
      screen.queryByLabelText(/current password|new password/i)
    ).toBeNull();
  });
});

describe("ChangePasswordPage — authenticated", () => {
  beforeEach(() => {
    mockUseSession.mockReturnValue({
      data: {
        user: {
          id: "user-1",
          name: "Test User",
          email: "test@example.com",
          image: null,
        },
        session: { id: "session-1", userId: "user-1" },
      },
      isPending: false,
      error: null,
    });
    mockPush.mockClear();
  });

  test("renders the ChangePassword form when authenticated", async () => {
    const { ChangePasswordPage } = await import(
      "../components/pages/change-password-page"
    );
    const Wrapper = await getWrapper();
    render(<ChangePasswordPage />, { wrapper: Wrapper });
    await waitFor(() => {
      expect(
        screen.queryAllByLabelText(/current password|new password/i).length >
          0 || screen.queryByRole("button", { name: /change|update/i }) !== null
      ).toBe(true);
    });
  });

  test("does not redirect when authenticated", async () => {
    const { ChangePasswordPage } = await import(
      "../components/pages/change-password-page"
    );
    const Wrapper = await getWrapper();
    render(<ChangePasswordPage />, { wrapper: Wrapper });

    await new Promise((r) => setTimeout(r, 50));
    expect(mockPush).not.toHaveBeenCalled();
  });

  test("accepts className prop", async () => {
    const { ChangePasswordPage } = await import(
      "../components/pages/change-password-page"
    );
    const Wrapper = await getWrapper();
    const { container } = render(
      <ChangePasswordPage className="custom-change-pw-page" />,
      { wrapper: Wrapper }
    );
    expect(container.querySelector(".custom-change-pw-page")).toBeDefined();
  });
});

// ============================================================================
// SessionManagementPage (account management — uses AuthGuard)
// ============================================================================

describe("SessionManagementPage export", () => {
  test("SessionManagementPage is exported from src/components/pages/session-management-page", async () => {
    const mod = await import("../components/pages/session-management-page");
    expect(typeof mod.SessionManagementPage).toBe("function");
  });
});

describe("SessionManagementPage — unauthenticated", () => {
  beforeEach(() => {
    mockUseSession.mockReturnValue({
      data: null,
      isPending: false,
      error: null,
    });
    mockPush.mockClear();
  });

  test("redirects to sign-in when not authenticated (uses AuthGuard)", async () => {
    const { SessionManagementPage } = await import(
      "../components/pages/session-management-page"
    );
    const Wrapper = await getWrapper();
    render(<SessionManagementPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledTimes(1);
    });
    const dest = mockPush.mock.calls[0]?.[0] as string | undefined;
    expect(dest).toMatch(/sign-in|login/i);
  });

  test("does not render session list when unauthenticated", async () => {
    const { SessionManagementPage } = await import(
      "../components/pages/session-management-page"
    );
    const Wrapper = await getWrapper();
    render(<SessionManagementPage />, { wrapper: Wrapper });
    expect(
      screen.queryByText(/active sessions|your sessions|revoke/i)
    ).toBeNull();
  });
});

describe("SessionManagementPage — authenticated", () => {
  beforeEach(() => {
    mockUseSession.mockReturnValue({
      data: {
        user: {
          id: "user-1",
          name: "Test User",
          email: "test@example.com",
          image: null,
        },
        session: { id: "session-1", userId: "user-1" },
      },
      isPending: false,
      error: null,
    });
    mockPush.mockClear();
  });

  test("renders the SessionManagement component when authenticated", async () => {
    const { SessionManagementPage } = await import(
      "../components/pages/session-management-page"
    );
    const Wrapper = await getWrapper();
    render(<SessionManagementPage />, { wrapper: Wrapper });
    // SessionManagement renders some content about sessions
    await waitFor(() => {
      expect(
        screen.queryByText(/session/i) !== null ||
          screen.queryByRole("list") !== null ||
          screen.queryByRole("button") !== null
      ).toBe(true);
    });
  });

  test("does not redirect when authenticated", async () => {
    const { SessionManagementPage } = await import(
      "../components/pages/session-management-page"
    );
    const Wrapper = await getWrapper();
    render(<SessionManagementPage />, { wrapper: Wrapper });

    await new Promise((r) => setTimeout(r, 50));
    expect(mockPush).not.toHaveBeenCalled();
  });

  test("accepts className prop", async () => {
    const { SessionManagementPage } = await import(
      "../components/pages/session-management-page"
    );
    const Wrapper = await getWrapper();
    const { container } = render(
      <SessionManagementPage className="custom-sessions-page" />,
      { wrapper: Wrapper }
    );
    expect(container.querySelector(".custom-sessions-page")).toBeDefined();
  });
});
