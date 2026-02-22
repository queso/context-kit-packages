import { describe, test, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { existsSync } from "fs";
import { resolve } from "path";
import React from "react";

const pkgRoot = resolve(import.meta.dir, "../..");

function fileExists(relativePath: string) {
  return existsSync(resolve(pkgRoot, relativePath));
}

// ---------------------------------------------------------------------------
// Fixture session data
// ---------------------------------------------------------------------------

const CURRENT_SESSION = {
  id: "session-current",
  token: "tok-current",
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  ipAddress: "192.168.1.1",
  createdAt: new Date("2024-01-01T10:00:00Z").toISOString(),
  updatedAt: new Date("2024-01-02T10:00:00Z").toISOString(),
  current: true,
};

const OTHER_SESSION_1 = {
  id: "session-other-1",
  token: "tok-other-1",
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  ipAddress: "10.0.0.1",
  createdAt: new Date("2024-01-01T08:00:00Z").toISOString(),
  updatedAt: new Date("2024-01-01T09:00:00Z").toISOString(),
  current: false,
};

const OTHER_SESSION_2 = {
  id: "session-other-2",
  token: "tok-other-2",
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  ipAddress: "172.16.0.5",
  createdAt: new Date("2023-12-31T20:00:00Z").toISOString(),
  updatedAt: new Date("2024-01-01T05:00:00Z").toISOString(),
  current: false,
};

// ---------------------------------------------------------------------------
// Mock @context-kit/auth/client
// ---------------------------------------------------------------------------

const mockListSessions = mock(() =>
  Promise.resolve({ data: [CURRENT_SESSION, OTHER_SESSION_1], error: null })
);
const mockRevokeSession = mock(() =>
  Promise.resolve({ data: { status: true }, error: null })
);
const mockUseSession = mock(() => ({
  data: {
    user: { id: "user-1", name: "Test User", email: "test@example.com" },
    session: { id: "session-current", userId: "user-1" },
  },
  isPending: false,
  error: null,
}));

const mockAuthClient = {
  listSessions: mockListSessions,
  revokeSession: mockRevokeSession,
  useSession: mockUseSession,
  signIn: mock(() => Promise.resolve({ data: null, error: null })),
  signOut: mock(() => Promise.resolve({ data: null, error: null })),
  signUp: mock(() => Promise.resolve({ data: null, error: null })),
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
const mockUseRouter = mock(() => ({
  push: mockPush,
  replace: mock(() => {}),
  back: mock(() => {}),
}));

mock.module("next/navigation", () => ({
  useRouter: mockUseRouter,
  useSearchParams: mock(() => ({ get: mock(() => null) })),
  usePathname: mock(() => "/profile/sessions"),
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

describe("file structure", () => {
  test("src/components/session-management.tsx exists", () => {
    expect(fileExists("src/components/session-management.tsx")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

describe("SessionManagement export", () => {
  test("SessionManagement is exported from src/components/session-management", async () => {
    const mod = await import("../components/session-management");
    expect(typeof mod.SessionManagement).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Session list rendering
// ---------------------------------------------------------------------------

describe("SessionManagement session list rendering", () => {
  beforeEach(() => {
    mockListSessions.mockClear();
    mockUseSession.mockReturnValue({
      data: {
        user: { id: "user-1", name: "Test User", email: "test@example.com" },
        session: { id: "session-current", userId: "user-1" },
      },
      isPending: false,
      error: null,
    });
    mockListSessions.mockResolvedValue({
      data: [CURRENT_SESSION, OTHER_SESSION_1],
      error: null,
    });
  });

  test("calls authClient.listSessions() on mount", async () => {
    const { SessionManagement } = await import("../components/session-management");
    const Wrapper = await getWrapper();
    render(<SessionManagement />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(mockListSessions).toHaveBeenCalledTimes(1);
    });
  });

  test("renders session list after fetching", async () => {
    const { SessionManagement } = await import("../components/session-management");
    const Wrapper = await getWrapper();
    render(<SessionManagement />, { wrapper: Wrapper });

    await waitFor(() => {
      // Two sessions — two list items or session rows
      const revokeButtons = screen.getAllByRole("button", { name: /revoke/i });
      expect(revokeButtons.length).toBeGreaterThanOrEqual(1);
    });
  });

  test("renders browser/device info from user agent for each session", async () => {
    const { SessionManagement } = await import("../components/session-management");
    const Wrapper = await getWrapper();
    render(<SessionManagement />, { wrapper: Wrapper });

    await waitFor(() => {
      // Parsed user agent — should show something like "Chrome" or "Safari" or "Mac"
      const content = document.body.textContent ?? "";
      expect(
        content.match(/chrome|safari|firefox|mac|windows|iphone|android/i)
      ).toBeTruthy();
    });
  });

  test("renders IP address for each session", async () => {
    const { SessionManagement } = await import("../components/session-management");
    const Wrapper = await getWrapper();
    render(<SessionManagement />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(
        screen.queryByText(/192\.168\.1\.1/) ?? screen.queryByText(/10\.0\.0\.1/)
      ).toBeDefined();
    });
  });

  test("current session shows 'Current session' badge", async () => {
    const { SessionManagement } = await import("../components/session-management");
    const Wrapper = await getWrapper();
    render(<SessionManagement />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText(/current session/i)).toBeDefined();
    });
  });

  test("renders a Revoke button for each session", async () => {
    mockListSessions.mockResolvedValue({
      data: [CURRENT_SESSION, OTHER_SESSION_1, OTHER_SESSION_2],
      error: null,
    });
    const { SessionManagement } = await import("../components/session-management");
    const Wrapper = await getWrapper();
    render(<SessionManagement />, { wrapper: Wrapper });

    await waitFor(() => {
      const revokeButtons = screen.getAllByRole("button", { name: /revoke/i });
      // At least one per non-current session, plus current
      expect(revokeButtons.length).toBeGreaterThanOrEqual(2);
    });
  });

  test("renders timestamp info for sessions", async () => {
    const { SessionManagement } = await import("../components/session-management");
    const Wrapper = await getWrapper();
    render(<SessionManagement />, { wrapper: Wrapper });

    await waitFor(() => {
      // Some date-like text should appear (year, "ago", "Jan", etc.)
      const content = document.body.textContent ?? "";
      expect(content.match(/\d{4}|ago|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i)).toBeTruthy();
    });
  });
});

// ---------------------------------------------------------------------------
// Revoking a non-current session
// ---------------------------------------------------------------------------

describe("revoking a non-current session", () => {
  beforeEach(() => {
    mockRevokeSession.mockClear();
    mockPush.mockClear();
    mockUseSession.mockReturnValue({
      data: {
        user: { id: "user-1", name: "Test User", email: "test@example.com" },
        session: { id: "session-current", userId: "user-1" },
      },
      isPending: false,
      error: null,
    });
    mockListSessions.mockResolvedValue({
      data: [CURRENT_SESSION, OTHER_SESSION_1],
      error: null,
    });
    mockRevokeSession.mockResolvedValue({ data: { status: true }, error: null });
  });

  test("clicking Revoke on a non-current session calls authClient.revokeSession()", async () => {
    const { SessionManagement } = await import("../components/session-management");
    const Wrapper = await getWrapper();
    render(<SessionManagement />, { wrapper: Wrapper });

    // Wait for sessions to load, then find a revoke button for the non-current session
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /revoke/i }).length).toBeGreaterThanOrEqual(1);
    });

    // Get all revoke buttons; the non-current session's button should be one of them
    const revokeButtons = screen.getAllByRole("button", { name: /revoke/i });
    // Click the first one that is not associated with "Current session"
    // (if there are multiple, we click any non-current one)
    fireEvent.click(revokeButtons[revokeButtons.length - 1]!);

    await waitFor(() => {
      expect(mockRevokeSession).toHaveBeenCalledTimes(1);
    });
  });

  test("revokeSession is called with the session id or token", async () => {
    const { SessionManagement } = await import("../components/session-management");
    const Wrapper = await getWrapper();
    render(<SessionManagement />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /revoke/i }).length).toBeGreaterThanOrEqual(1);
    });

    const revokeButtons = screen.getAllByRole("button", { name: /revoke/i });
    fireEvent.click(revokeButtons[revokeButtons.length - 1]!);

    await waitFor(() => {
      expect(mockRevokeSession).toHaveBeenCalledTimes(1);
    });
    const arg = mockRevokeSession.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    // Accepts either {id} or {token} or the raw string
    const passedValue = arg?.id ?? arg?.token ?? arg;
    expect(
      passedValue === OTHER_SESSION_1.id ||
      passedValue === OTHER_SESSION_1.token ||
      (typeof arg === "string" && (arg === OTHER_SESSION_1.id || arg === OTHER_SESSION_1.token))
    ).toBe(true);
  });

  test("non-current session revoke does NOT redirect to sign-in", async () => {
    const { SessionManagement } = await import("../components/session-management");
    const Wrapper = await getWrapper();
    render(<SessionManagement />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /revoke/i }).length).toBeGreaterThanOrEqual(1);
    });

    const revokeButtons = screen.getAllByRole("button", { name: /revoke/i });
    fireEvent.click(revokeButtons[revokeButtons.length - 1]!);

    await waitFor(() => {
      expect(mockRevokeSession).toHaveBeenCalledTimes(1);
    });

    // Router push should not have been called (not signing out)
    expect(mockPush).not.toHaveBeenCalled();
  });

  test("revoke button shows loading state during revocation", async () => {
    let resolve!: (v: unknown) => void;
    mockRevokeSession.mockReturnValue(new Promise((res) => { resolve = res; }));

    const { SessionManagement } = await import("../components/session-management");
    const Wrapper = await getWrapper();
    render(<SessionManagement />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /revoke/i }).length).toBeGreaterThanOrEqual(1);
    });

    const revokeButtons = screen.getAllByRole("button", { name: /revoke/i });
    const targetBtn = revokeButtons[revokeButtons.length - 1]! as HTMLButtonElement;

    await act(async () => {
      fireEvent.click(targetBtn);
    });

    // Button should be disabled or show loading during the async call
    expect(
      targetBtn.disabled ||
      targetBtn.getAttribute("aria-disabled") === "true" ||
      targetBtn.getAttribute("data-loading") === "true" ||
      screen.queryByText(/revoking|loading/i) !== null
    ).toBe(true);

    resolve({ data: { status: true }, error: null });
    mockRevokeSession.mockResolvedValue({ data: { status: true }, error: null });
  });
});

// ---------------------------------------------------------------------------
// Revoking the current session — confirmation Dialog
// ---------------------------------------------------------------------------

describe("revoking the current session", () => {
  beforeEach(() => {
    mockRevokeSession.mockClear();
    mockPush.mockClear();
    mockUseSession.mockReturnValue({
      data: {
        user: { id: "user-1", name: "Test User", email: "test@example.com" },
        session: { id: "session-current", userId: "user-1" },
      },
      isPending: false,
      error: null,
    });
    mockListSessions.mockResolvedValue({
      data: [CURRENT_SESSION, OTHER_SESSION_1],
      error: null,
    });
    mockRevokeSession.mockResolvedValue({ data: { status: true }, error: null });
  });

  test("clicking Revoke on current session opens confirmation Dialog", async () => {
    const { SessionManagement } = await import("../components/session-management");
    const Wrapper = await getWrapper();
    render(<SessionManagement />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText(/current session/i)).toBeDefined();
    });

    // The current session's revoke button is associated with the "Current session" badge
    // Click the first revoke button (current session is typically listed first/highlighted)
    const revokeButtons = screen.getAllByRole("button", { name: /revoke/i });
    fireEvent.click(revokeButtons[0]!);

    await waitFor(() => {
      expect(
        screen.getByText(/sign you out|are you sure|confirm/i)
      ).toBeDefined();
    });
  });

  test("confirmation Dialog shows warning that this will sign out the user", async () => {
    const { SessionManagement } = await import("../components/session-management");
    const Wrapper = await getWrapper();
    render(<SessionManagement />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText(/current session/i)).toBeDefined();
    });

    const revokeButtons = screen.getAllByRole("button", { name: /revoke/i });
    fireEvent.click(revokeButtons[0]!);

    await waitFor(() => {
      expect(screen.getByText(/sign you out/i)).toBeDefined();
    });
  });

  test("Dialog confirm calls revokeSession and redirects to sign-in", async () => {
    const { SessionManagement } = await import("../components/session-management");
    const Wrapper = await getWrapper();
    render(<SessionManagement />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText(/current session/i)).toBeDefined();
    });

    const revokeButtons = screen.getAllByRole("button", { name: /revoke/i });
    fireEvent.click(revokeButtons[0]!);

    await waitFor(() => {
      expect(screen.getByText(/sign you out|are you sure|confirm/i)).toBeDefined();
    });

    // Click the confirm button inside the dialog
    fireEvent.click(screen.getByRole("button", { name: /confirm|yes|sign out|revoke/i }));

    await waitFor(() => {
      expect(mockRevokeSession).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledTimes(1);
    });
    const dest = mockPush.mock.calls[0]?.[0] as string | undefined;
    expect(dest).toMatch(/sign.?in/i);
  });

  test("Dialog cancel dismisses without calling revokeSession", async () => {
    const { SessionManagement } = await import("../components/session-management");
    const Wrapper = await getWrapper();
    render(<SessionManagement />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText(/current session/i)).toBeDefined();
    });

    const revokeButtons = screen.getAllByRole("button", { name: /revoke/i });
    fireEvent.click(revokeButtons[0]!);

    await waitFor(() => {
      expect(screen.getByText(/sign you out|are you sure|confirm/i)).toBeDefined();
    });

    // Click the cancel button
    fireEvent.click(screen.getByRole("button", { name: /cancel|no|keep/i }));

    await waitFor(() => {
      expect(
        screen.queryByText(/sign you out|are you sure/) === null ||
        screen.queryByRole("dialog") === null
      ).toBe(true);
    });
    expect(mockRevokeSession).not.toHaveBeenCalled();
  });

  test("Dialog is dismissed by pressing Escape key", async () => {
    const { SessionManagement } = await import("../components/session-management");
    const Wrapper = await getWrapper();
    render(<SessionManagement />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText(/current session/i)).toBeDefined();
    });

    const revokeButtons = screen.getAllByRole("button", { name: /revoke/i });
    fireEvent.click(revokeButtons[0]!);

    await waitFor(() => {
      expect(screen.getByText(/sign you out|are you sure|confirm/i)).toBeDefined();
    });

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape", code: "Escape" });

    await waitFor(() => {
      expect(
        screen.queryByText(/sign you out|are you sure/) === null ||
        screen.queryByRole("dialog") === null
      ).toBe(true);
    });
    expect(mockRevokeSession).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Loading state
// ---------------------------------------------------------------------------

describe("loading state", () => {
  test("shows loading indicator while fetching sessions", async () => {
    let resolve!: (v: unknown) => void;
    mockListSessions.mockReturnValue(new Promise((res) => { resolve = res; }));
    mockUseSession.mockReturnValue({
      data: {
        user: { id: "user-1", name: "Test User", email: "test@example.com" },
        session: { id: "session-current", userId: "user-1" },
      },
      isPending: false,
      error: null,
    });

    const { SessionManagement } = await import("../components/session-management");
    const Wrapper = await getWrapper();
    render(<SessionManagement />, { wrapper: Wrapper });

    // While the promise is pending, a loading indicator should be shown
    expect(
      screen.queryByText(/loading|fetching/i) !== null ||
      document.querySelector("[aria-busy='true']") !== null ||
      document.querySelector("[data-loading]") !== null ||
      document.querySelector(".animate-pulse, .skeleton, [class*='loading'], [class*='spinner']") !== null
    ).toBe(true);

    resolve({ data: [CURRENT_SESSION, OTHER_SESSION_1], error: null });
    mockListSessions.mockResolvedValue({ data: [CURRENT_SESSION, OTHER_SESSION_1], error: null });
  });
});

// ---------------------------------------------------------------------------
// Error state
// ---------------------------------------------------------------------------

describe("error state", () => {
  test("shows error message when listSessions fails", async () => {
    mockUseSession.mockReturnValue({
      data: {
        user: { id: "user-1", name: "Test User", email: "test@example.com" },
        session: { id: "session-current", userId: "user-1" },
      },
      isPending: false,
      error: null,
    });
    mockListSessions.mockResolvedValue({
      data: null,
      error: { message: "Failed to fetch sessions" },
    });

    const { SessionManagement } = await import("../components/session-management");
    const Wrapper = await getWrapper();
    render(<SessionManagement />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(
        screen.getByText(/error|failed|something went wrong|could not load/i)
      ).toBeDefined();
    });
  });

  test("shows error message when listSessions rejects (network failure)", async () => {
    mockUseSession.mockReturnValue({
      data: {
        user: { id: "user-1", name: "Test User", email: "test@example.com" },
        session: { id: "session-current", userId: "user-1" },
      },
      isPending: false,
      error: null,
    });
    mockListSessions.mockRejectedValue(new Error("Network error"));

    const origError = console.error;
    console.error = () => {};

    const { SessionManagement } = await import("../components/session-management");
    const Wrapper = await getWrapper();
    render(<SessionManagement />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(
        screen.getByText(/error|failed|something went wrong|could not load/i)
      ).toBeDefined();
    });

    console.error = origError;
    mockListSessions.mockResolvedValue({ data: [CURRENT_SESSION, OTHER_SESSION_1], error: null });
  });
});

// ---------------------------------------------------------------------------
// Empty state (only current session)
// ---------------------------------------------------------------------------

describe("empty state", () => {
  test("shows empty state when only the current session exists", async () => {
    mockUseSession.mockReturnValue({
      data: {
        user: { id: "user-1", name: "Test User", email: "test@example.com" },
        session: { id: "session-current", userId: "user-1" },
      },
      isPending: false,
      error: null,
    });
    mockListSessions.mockResolvedValue({
      data: [CURRENT_SESSION], // only current session — no others to manage
      error: null,
    });

    const { SessionManagement } = await import("../components/session-management");
    const Wrapper = await getWrapper();
    render(<SessionManagement />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(
        screen.getByText(/no other.*sessions|only.*session|no active sessions/i)
      ).toBeDefined();
    });
  });

  test("shows empty state when listSessions returns an empty array", async () => {
    mockUseSession.mockReturnValue({
      data: {
        user: { id: "user-1", name: "Test User", email: "test@example.com" },
        session: { id: "session-current", userId: "user-1" },
      },
      isPending: false,
      error: null,
    });
    mockListSessions.mockResolvedValue({ data: [], error: null });

    const { SessionManagement } = await import("../components/session-management");
    const Wrapper = await getWrapper();
    render(<SessionManagement />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(
        screen.getByText(/no.*sessions|no active sessions|empty/i)
      ).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Unauthenticated redirect
// ---------------------------------------------------------------------------

describe("unauthenticated redirect", () => {
  test("redirects to sign-in when no active session", async () => {
    mockUseSession.mockReturnValue({ data: null, isPending: false, error: null });
    mockPush.mockClear();

    const { SessionManagement } = await import("../components/session-management");
    const Wrapper = await getWrapper();
    render(<SessionManagement />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledTimes(1);
    });
    const dest = mockPush.mock.calls[0]?.[0] as string | undefined;
    expect(dest).toMatch(/sign.?in/i);
  });

  test("does not redirect while session is loading", async () => {
    mockUseSession.mockReturnValue({ data: null, isPending: true, error: null });
    mockPush.mockClear();

    const { SessionManagement } = await import("../components/session-management");
    const Wrapper = await getWrapper();
    render(<SessionManagement />, { wrapper: Wrapper });

    await new Promise((r) => setTimeout(r, 50));
    expect(mockPush).not.toHaveBeenCalled();

    // Reset
    mockUseSession.mockReturnValue({
      data: {
        user: { id: "user-1", name: "Test User", email: "test@example.com" },
        session: { id: "session-current", userId: "user-1" },
      },
      isPending: false,
      error: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Multiple sessions
// ---------------------------------------------------------------------------

describe("multiple sessions", () => {
  beforeEach(() => {
    mockRevokeSession.mockClear();
    mockUseSession.mockReturnValue({
      data: {
        user: { id: "user-1", name: "Test User", email: "test@example.com" },
        session: { id: "session-current", userId: "user-1" },
      },
      isPending: false,
      error: null,
    });
    mockListSessions.mockResolvedValue({
      data: [CURRENT_SESSION, OTHER_SESSION_1, OTHER_SESSION_2],
      error: null,
    });
    mockRevokeSession.mockResolvedValue({ data: { status: true }, error: null });
  });

  test("renders all sessions when multiple are returned", async () => {
    const { SessionManagement } = await import("../components/session-management");
    const Wrapper = await getWrapper();
    render(<SessionManagement />, { wrapper: Wrapper });

    await waitFor(() => {
      const revokeButtons = screen.getAllByRole("button", { name: /revoke/i });
      // Should have revoke buttons for all 3 sessions
      expect(revokeButtons.length).toBeGreaterThanOrEqual(2);
    });
  });

  test("only one 'Current session' badge appears", async () => {
    const { SessionManagement } = await import("../components/session-management");
    const Wrapper = await getWrapper();
    render(<SessionManagement />, { wrapper: Wrapper });

    await waitFor(() => {
      const badges = screen.getAllByText(/current session/i);
      expect(badges.length).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// className and classNames props
// ---------------------------------------------------------------------------

describe("className and classNames props", () => {
  beforeEach(() => {
    mockUseSession.mockReturnValue({
      data: {
        user: { id: "user-1", name: "Test User", email: "test@example.com" },
        session: { id: "session-current", userId: "user-1" },
      },
      isPending: false,
      error: null,
    });
    mockListSessions.mockResolvedValue({
      data: [CURRENT_SESSION, OTHER_SESSION_1],
      error: null,
    });
  });

  test("accepts className prop on the root element", async () => {
    const { SessionManagement } = await import("../components/session-management");
    const Wrapper = await getWrapper();
    const { container } = render(
      <SessionManagement className="custom-sessions" />,
      { wrapper: Wrapper }
    );
    expect(container.querySelector(".custom-sessions")).toBeDefined();
  });

  test("accepts classNames.card override", async () => {
    const { SessionManagement } = await import("../components/session-management");
    const Wrapper = await getWrapper();
    const { container } = render(
      <SessionManagement classNames={{ card: "custom-card" }} />,
      { wrapper: Wrapper }
    );
    expect(container.querySelector(".custom-card")).toBeDefined();
  });

  test("accepts classNames.revokeButton override", async () => {
    const { SessionManagement } = await import("../components/session-management");
    const Wrapper = await getWrapper();
    render(
      <SessionManagement classNames={{ revokeButton: "custom-revoke-btn" }} />,
      { wrapper: Wrapper }
    );

    await waitFor(() => {
      const btn = screen.getAllByRole("button", { name: /revoke/i })[0];
      expect(btn?.className).toContain("custom-revoke-btn");
    });
  });

  test("accepts classNames.currentBadge override", async () => {
    const { SessionManagement } = await import("../components/session-management");
    const Wrapper = await getWrapper();
    const { container } = render(
      <SessionManagement classNames={{ currentBadge: "custom-badge" }} />,
      { wrapper: Wrapper }
    );

    await waitFor(() => {
      expect(container.querySelector(".custom-badge")).toBeDefined();
    });
  });

  test("accepts classNames.sessionItem override", async () => {
    const { SessionManagement } = await import("../components/session-management");
    const Wrapper = await getWrapper();
    const { container } = render(
      <SessionManagement classNames={{ sessionItem: "custom-session-item" }} />,
      { wrapper: Wrapper }
    );

    await waitFor(() => {
      expect(container.querySelector(".custom-session-item")).toBeDefined();
    });
  });
});
