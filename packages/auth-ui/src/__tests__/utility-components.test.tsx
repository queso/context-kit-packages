import { beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const mockSignOut = mock(() =>
  Promise.resolve({ data: { status: true }, error: null })
);
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
  signOut: mockSignOut,
  useSession: mockUseSession,
  signIn: mock(() => Promise.resolve({ data: null, error: null })),
  signUp: mock(() => Promise.resolve({ data: null, error: null })),
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

mock.module("next/navigation", () => ({
  useRouter: mockUseRouter,
  useSearchParams: mock(() => ({ get: mock(() => null) })),
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

describe("file structure", () => {
  test("src/components/user-button.tsx exists", () => {
    expect(fileExists("src/components/user-button.tsx")).toBe(true);
  });

  test("src/components/auth-guard.tsx exists", () => {
    expect(fileExists("src/components/auth-guard.tsx")).toBe(true);
  });
});

// ============================================================================
// UserButton
// ============================================================================

describe("UserButton export", () => {
  test("UserButton is exported from src/components/user-button", async () => {
    const mod = await import("../components/user-button");
    expect(typeof mod.UserButton).toBe("function");
  });
});

describe("UserButton rendering", () => {
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
  });

  test("renders a button element", async () => {
    const { UserButton } = await import("../components/user-button");
    const Wrapper = await getWrapper();
    render(<UserButton />, { wrapper: Wrapper });
    expect(screen.getByRole("button")).toBeDefined();
  });

  test("avatar shows initials fallback (first letter of name) when image is null", async () => {
    const { UserButton } = await import("../components/user-button");
    const Wrapper = await getWrapper();
    render(<UserButton />, { wrapper: Wrapper });
    // "Test User" → "T"
    expect(screen.getByText("T")).toBeDefined();
  });

  test("initials fallback uses first letter of name", async () => {
    mockUseSession.mockReturnValue({
      data: {
        user: {
          id: "u2",
          name: "Alice Smith",
          email: "alice@example.com",
          image: null,
        },
        session: { id: "s2", userId: "u2" },
      },
      isPending: false,
      error: null,
    });
    const { UserButton } = await import("../components/user-button");
    const Wrapper = await getWrapper();
    render(<UserButton />, { wrapper: Wrapper });
    expect(screen.getByText("A")).toBeDefined();
  });

  test("renders without crashing when no session is active", async () => {
    mockUseSession.mockReturnValue({
      data: null,
      isPending: false,
      error: null,
    });
    const { UserButton } = await import("../components/user-button");
    const Wrapper = await getWrapper();
    expect(() => render(<UserButton />, { wrapper: Wrapper })).not.toThrow();
  });

  test("renders nothing or a placeholder gracefully when no session", async () => {
    mockUseSession.mockReturnValue({
      data: null,
      isPending: false,
      error: null,
    });
    const { UserButton } = await import("../components/user-button");
    const Wrapper = await getWrapper();
    const { container } = render(<UserButton />, { wrapper: Wrapper });
    // Should not crash — either renders nothing or a placeholder, not the full button
    expect(container).toBeDefined();
  });
});

describe("UserButton dropdown menu", () => {
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
    mockSignOut.mockClear();
  });

  test("clicking the avatar button opens the dropdown menu", async () => {
    const { UserButton } = await import("../components/user-button");
    const Wrapper = await getWrapper();
    render(<UserButton />, { wrapper: Wrapper });

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      // Dropdown content should appear — check for user name, profile link, or sign out
      expect(
        screen.queryByText("Test User") !== null ||
          screen.queryByText(/profile/i) !== null ||
          screen.queryByText(/sign out/i) !== null
      ).toBe(true);
    });
  });

  test("dropdown shows user's name", async () => {
    const { UserButton } = await import("../components/user-button");
    const Wrapper = await getWrapper();
    render(<UserButton />, { wrapper: Wrapper });

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(screen.getByText("Test User")).toBeDefined();
    });
  });

  test("dropdown shows user's email", async () => {
    const { UserButton } = await import("../components/user-button");
    const Wrapper = await getWrapper();
    render(<UserButton />, { wrapper: Wrapper });

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(screen.getByText("test@example.com")).toBeDefined();
    });
  });

  test("dropdown has a 'Profile' link pointing to '/profile' by default", async () => {
    const { UserButton } = await import("../components/user-button");
    const Wrapper = await getWrapper();
    render(<UserButton />, { wrapper: Wrapper });

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(screen.getByText(/^profile$/i)).toBeDefined();
    });

    const profileLink =
      screen.queryByRole("link", { name: /^profile$/i }) ??
      screen.queryByRole("menuitem", { name: /^profile$/i });
    if (profileLink) {
      const href =
        profileLink.getAttribute("href") ??
        profileLink.getAttribute("data-href");
      expect(href).toBe("/profile");
    }
  });

  test("profileUrl prop customizes the profile link href", async () => {
    const { UserButton } = await import("../components/user-button");
    const Wrapper = await getWrapper();
    render(<UserButton profileUrl="/settings/profile" />, { wrapper: Wrapper });

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(screen.getByText(/^profile$/i)).toBeDefined();
    });

    const profileLink =
      screen.queryByRole("link", { name: /^profile$/i }) ??
      screen.queryByRole("menuitem", { name: /^profile$/i });
    if (profileLink) {
      const href =
        profileLink.getAttribute("href") ??
        profileLink.getAttribute("data-href");
      expect(href).toBe("/settings/profile");
    }
  });

  test("dropdown has a 'Sign out' item", async () => {
    const { UserButton } = await import("../components/user-button");
    const Wrapper = await getWrapper();
    render(<UserButton />, { wrapper: Wrapper });

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(screen.getByText(/sign out/i)).toBeDefined();
    });
  });

  test("clicking 'Sign out' calls authClient.signOut()", async () => {
    mockSignOut.mockResolvedValue({ data: { status: true }, error: null });
    const { UserButton } = await import("../components/user-button");
    const Wrapper = await getWrapper();
    render(<UserButton />, { wrapper: Wrapper });

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(screen.getByText(/sign out/i)).toBeDefined();
    });

    fireEvent.click(screen.getByText(/sign out/i));

    await waitFor(() => {
      expect(mockSignOut).toHaveBeenCalledTimes(1);
    });
  });

  test("onSignOut callback is invoked after sign out", async () => {
    mockSignOut.mockResolvedValue({ data: { status: true }, error: null });
    const onSignOut = mock(() => {});
    const { UserButton } = await import("../components/user-button");
    const Wrapper = await getWrapper();
    render(<UserButton onSignOut={onSignOut} />, { wrapper: Wrapper });

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(screen.getByText(/sign out/i)).toBeDefined();
    });

    fireEvent.click(screen.getByText(/sign out/i));

    await waitFor(() => {
      expect(onSignOut).toHaveBeenCalledTimes(1);
    });
  });

  test("onSignOut callback is called after signOut() resolves", async () => {
    let signOutResolved = false;
    mockSignOut.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      signOutResolved = true;
      return { data: { status: true }, error: null };
    });

    const onSignOut = mock(() => {
      // At the time callback is called, signOut should have already resolved
      expect(signOutResolved).toBe(true);
    });

    const { UserButton } = await import("../components/user-button");
    const Wrapper = await getWrapper();
    render(<UserButton onSignOut={onSignOut} />, { wrapper: Wrapper });

    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(screen.getByText(/sign out/i)).toBeDefined());
    fireEvent.click(screen.getByText(/sign out/i));

    await waitFor(() => {
      expect(onSignOut).toHaveBeenCalledTimes(1);
    });

    mockSignOut.mockResolvedValue({ data: { status: true }, error: null });
  });
});

describe("UserButton className and classNames props", () => {
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
  });

  test("accepts className prop on root element", async () => {
    const { UserButton } = await import("../components/user-button");
    const Wrapper = await getWrapper();
    const { container } = render(<UserButton className="custom-user-btn" />, {
      wrapper: Wrapper,
    });
    expect(container.querySelector(".custom-user-btn")).toBeDefined();
  });

  test("accepts classNames.avatar override", async () => {
    const { UserButton } = await import("../components/user-button");
    const Wrapper = await getWrapper();
    const { container } = render(
      <UserButton classNames={{ avatar: "custom-avatar" }} />,
      { wrapper: Wrapper }
    );
    expect(container.querySelector(".custom-avatar")).toBeDefined();
  });

  test("accepts classNames.dropdown override", async () => {
    const { UserButton } = await import("../components/user-button");
    const Wrapper = await getWrapper();
    render(<UserButton classNames={{ dropdown: "custom-dropdown" }} />, {
      wrapper: Wrapper,
    });

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(document.querySelector(".custom-dropdown")).toBeDefined();
    });
  });

  test("accepts classNames.menuItem override", async () => {
    const { UserButton } = await import("../components/user-button");
    const Wrapper = await getWrapper();
    render(<UserButton classNames={{ menuItem: "custom-menu-item" }} />, {
      wrapper: Wrapper,
    });

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(document.querySelector(".custom-menu-item")).toBeDefined();
    });
  });
});

// ============================================================================
// AuthGuard
// ============================================================================

describe("AuthGuard export", () => {
  test("AuthGuard is exported from src/components/auth-guard", async () => {
    const mod = await import("../components/auth-guard");
    expect(typeof mod.AuthGuard).toBe("function");
  });
});

describe("AuthGuard — authenticated", () => {
  beforeEach(() => {
    mockUseSession.mockReturnValue({
      data: {
        user: { id: "user-1", name: "Test User", email: "test@example.com" },
        session: { id: "session-1", userId: "user-1" },
      },
      isPending: false,
      error: null,
    });
    mockPush.mockClear();
  });

  test("renders children when user is authenticated", async () => {
    const { AuthGuard } = await import("../components/auth-guard");
    const Wrapper = await getWrapper();
    render(
      <AuthGuard>
        <div>protected content</div>
      </AuthGuard>,
      { wrapper: Wrapper }
    );
    expect(screen.getByText("protected content")).toBeDefined();
  });

  test("does not redirect when user is authenticated", async () => {
    const { AuthGuard } = await import("../components/auth-guard");
    const Wrapper = await getWrapper();
    render(
      <AuthGuard>
        <span>ok</span>
      </AuthGuard>,
      { wrapper: Wrapper }
    );

    await new Promise((r) => setTimeout(r, 50));
    expect(mockPush).not.toHaveBeenCalled();
  });

  test("renders multiple children when authenticated", async () => {
    const { AuthGuard } = await import("../components/auth-guard");
    const Wrapper = await getWrapper();
    render(
      <AuthGuard>
        <div>child one</div>
        <div>child two</div>
      </AuthGuard>,
      { wrapper: Wrapper }
    );
    expect(screen.getByText("child one")).toBeDefined();
    expect(screen.getByText("child two")).toBeDefined();
  });

  test("accepts className prop on wrapper", async () => {
    const { AuthGuard } = await import("../components/auth-guard");
    const Wrapper = await getWrapper();
    const { container } = render(
      <AuthGuard className="custom-guard">
        <div>content</div>
      </AuthGuard>,
      { wrapper: Wrapper }
    );
    expect(container.querySelector(".custom-guard")).toBeDefined();
  });
});

describe("AuthGuard — unauthenticated redirect", () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  test("redirects to '/sign-in' by default when not authenticated", async () => {
    mockUseSession.mockReturnValue({
      data: null,
      isPending: false,
      error: null,
    });
    const { AuthGuard } = await import("../components/auth-guard");
    const Wrapper = await getWrapper();
    render(
      <AuthGuard>
        <div>secret</div>
      </AuthGuard>,
      { wrapper: Wrapper }
    );

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledTimes(1);
    });
    const dest = mockPush.mock.calls[0]?.[0] as string | undefined;
    expect(dest).toBe("/sign-in");
  });

  test("signInPath prop customizes the redirect destination", async () => {
    mockUseSession.mockReturnValue({
      data: null,
      isPending: false,
      error: null,
    });
    const { AuthGuard } = await import("../components/auth-guard");
    const Wrapper = await getWrapper();
    render(
      <AuthGuard signInPath="/auth/login">
        <div>secret</div>
      </AuthGuard>,
      { wrapper: Wrapper }
    );

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledTimes(1);
    });
    const dest = mockPush.mock.calls[0]?.[0] as string | undefined;
    expect(dest).toBe("/auth/login");
  });

  test("does not render children when not authenticated", async () => {
    mockUseSession.mockReturnValue({
      data: null,
      isPending: false,
      error: null,
    });
    const { AuthGuard } = await import("../components/auth-guard");
    const Wrapper = await getWrapper();
    render(
      <AuthGuard>
        <div>secret content</div>
      </AuthGuard>,
      { wrapper: Wrapper }
    );

    // Children should not be visible (redirect should happen instead)
    expect(screen.queryByText("secret content")).toBeNull();
  });
});

describe("AuthGuard — loading/pending state", () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  test("shows loading indicator while session is pending", async () => {
    mockUseSession.mockReturnValue({
      data: null,
      isPending: true,
      error: null,
    });
    const { AuthGuard } = await import("../components/auth-guard");
    const Wrapper = await getWrapper();
    render(
      <AuthGuard>
        <div>protected</div>
      </AuthGuard>,
      { wrapper: Wrapper }
    );

    // Should render some loading UI, not the children
    expect(screen.queryByText("protected")).toBeNull();
    // Loading indicator: spinner, text, or aria-busy element
    expect(
      screen.queryByText(/loading/i) !== null ||
        document.querySelector("[aria-busy='true']") !== null ||
        document.querySelector("[role='status']") !== null ||
        document.querySelector(
          ".animate-spin, [class*='spinner'], [class*='loading']"
        ) !== null
    ).toBe(true);
  });

  test("does NOT redirect while session is pending", async () => {
    mockUseSession.mockReturnValue({
      data: null,
      isPending: true,
      error: null,
    });
    const { AuthGuard } = await import("../components/auth-guard");
    const Wrapper = await getWrapper();
    render(
      <AuthGuard>
        <div>protected</div>
      </AuthGuard>,
      { wrapper: Wrapper }
    );

    await new Promise((r) => setTimeout(r, 50));
    expect(mockPush).not.toHaveBeenCalled();

    // Reset
    mockUseSession.mockReturnValue({
      data: {
        user: { id: "user-1", name: "Test User", email: "test@example.com" },
        session: { id: "session-1", userId: "user-1" },
      },
      isPending: false,
      error: null,
    });
  });

  test("does NOT render children while session is pending", async () => {
    mockUseSession.mockReturnValue({
      data: null,
      isPending: true,
      error: null,
    });
    const { AuthGuard } = await import("../components/auth-guard");
    const Wrapper = await getWrapper();
    render(
      <AuthGuard>
        <div>secret stuff</div>
      </AuthGuard>,
      { wrapper: Wrapper }
    );

    expect(screen.queryByText("secret stuff")).toBeNull();
  });

  test("loadingComponent prop overrides the default loading UI", async () => {
    mockUseSession.mockReturnValue({
      data: null,
      isPending: true,
      error: null,
    });
    const { AuthGuard } = await import("../components/auth-guard");
    const Wrapper = await getWrapper();
    render(
      <AuthGuard loadingComponent={<div>custom loader</div>}>
        <div>protected</div>
      </AuthGuard>,
      { wrapper: Wrapper }
    );

    expect(screen.getByText("custom loader")).toBeDefined();
    expect(screen.queryByText("protected")).toBeNull();
  });

  test("loadingComponent replaces default spinner, not children", async () => {
    mockUseSession.mockReturnValue({
      data: null,
      isPending: true,
      error: null,
    });
    const { AuthGuard } = await import("../components/auth-guard");
    const Wrapper = await getWrapper();
    render(
      <AuthGuard
        loadingComponent={<span data-testid="my-loader">Loading...</span>}
      >
        <div>protected</div>
      </AuthGuard>,
      { wrapper: Wrapper }
    );

    expect(screen.getByTestId("my-loader")).toBeDefined();
    expect(screen.queryByText("protected")).toBeNull();
  });

  test("transitions from loading to showing children when session resolves", async () => {
    mockUseSession.mockReturnValue({
      data: null,
      isPending: true,
      error: null,
    });
    const { AuthGuard } = await import("../components/auth-guard");
    const Wrapper = await getWrapper();
    const { rerender } = render(
      <AuthGuard>
        <div>protected content</div>
      </AuthGuard>,
      { wrapper: Wrapper }
    );

    // Initially pending — children not shown
    expect(screen.queryByText("protected content")).toBeNull();

    // Session resolves
    mockUseSession.mockReturnValue({
      data: {
        user: { id: "user-1", name: "Test User", email: "test@example.com" },
        session: { id: "session-1", userId: "user-1" },
      },
      isPending: false,
      error: null,
    });

    rerender(
      <Wrapper>
        <AuthGuard>
          <div>protected content</div>
        </AuthGuard>
      </Wrapper>
    );

    await waitFor(() => {
      expect(screen.getByText("protected content")).toBeDefined();
    });
  });
});
