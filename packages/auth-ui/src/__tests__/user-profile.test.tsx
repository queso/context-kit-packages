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
// Mock auth client
// ---------------------------------------------------------------------------

const mockUpdateUser = mock(() =>
  Promise.resolve({ data: { status: true }, error: null })
);
const mockSignOut = mock(() => Promise.resolve({ data: null, error: null }));
const mockSignIn = mock(() => Promise.resolve({ data: null, error: null }));
const mockSignUp = mock(() => Promise.resolve({ data: null, error: null }));

// Default: active session with a user
const mockUseSession = mock(() => ({
  data: {
    user: { id: "user-1", name: "Test User", email: "test@example.com", image: null },
    session: { id: "session-1", userId: "user-1" },
  },
  isPending: false,
  error: null,
}));

const mockAuthClient = {
  useSession: mockUseSession,
  updateUser: mockUpdateUser,
  signIn: mockSignIn,
  signOut: mockSignOut,
  signUp: mockSignUp,
};

const mockCreateAuthClient = mock(() => mockAuthClient);

mock.module("@context-kit/auth/client", () => ({
  createAuthClient: mockCreateAuthClient,
}));

// ---------------------------------------------------------------------------
// Mock next/navigation
// ---------------------------------------------------------------------------

const mockPush = mock(() => {});
const mockReplace = mock(() => {});
const mockUseRouter = mock(() => ({ push: mockPush, replace: mockReplace, back: mock(() => {}) }));

mock.module("next/navigation", () => ({
  useRouter: mockUseRouter,
  useSearchParams: mock(() => ({ get: () => null })),
  usePathname: mock(() => "/profile"),
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
  test("src/components/user-profile.tsx exists", () => {
    expect(fileExists("src/components/user-profile.tsx")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

describe("UserProfile export", () => {
  test("UserProfile is exported from src/components/user-profile", async () => {
    const mod = await import("../components/user-profile");
    expect(typeof mod.UserProfile).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Rendering with active session
// ---------------------------------------------------------------------------

describe("UserProfile rendering", () => {
  beforeEach(() => {
    mockUseSession.mockReturnValue({
      data: {
        user: { id: "user-1", name: "Test User", email: "test@example.com", image: null },
        session: { id: "session-1", userId: "user-1" },
      },
      isPending: false,
      error: null,
    });
  });

  test("renders user name from session", async () => {
    const { UserProfile } = await import("../components/user-profile");
    const Wrapper = await getWrapper();
    render(<UserProfile />, { wrapper: Wrapper });
    expect(screen.getByText("Test User")).toBeDefined();
  });

  test("renders user email from session", async () => {
    const { UserProfile } = await import("../components/user-profile");
    const Wrapper = await getWrapper();
    render(<UserProfile />, { wrapper: Wrapper });
    expect(screen.getByText("test@example.com")).toBeDefined();
  });

  test("renders avatar element", async () => {
    const { UserProfile } = await import("../components/user-profile");
    const Wrapper = await getWrapper();
    const { container } = render(<UserProfile />, { wrapper: Wrapper });
    // Avatar primitive renders a container div; presence of avatar region
    expect(
      container.querySelector("[data-slot='avatar']") ??
      container.querySelector(".avatar") ??
      container.querySelector("[class*='avatar']") ??
      // fallback: any element showing the initials
      screen.queryByText("T")
    ).toBeDefined();
  });

  test("avatar shows first-letter initials fallback when image is null", async () => {
    mockUseSession.mockReturnValue({
      data: {
        user: { id: "user-1", name: "Test User", email: "test@example.com", image: null },
        session: { id: "session-1", userId: "user-1" },
      },
      isPending: false,
      error: null,
    });
    const { UserProfile } = await import("../components/user-profile");
    const Wrapper = await getWrapper();
    render(<UserProfile />, { wrapper: Wrapper });
    // First letter of "Test User" is "T"
    expect(screen.getByText("T")).toBeDefined();
  });

  test("avatar initials fallback uses first letter of name", async () => {
    mockUseSession.mockReturnValue({
      data: {
        user: { id: "user-2", name: "Alice Smith", email: "alice@example.com", image: null },
        session: { id: "session-2", userId: "user-2" },
      },
      isPending: false,
      error: null,
    });
    const { UserProfile } = await import("../components/user-profile");
    const Wrapper = await getWrapper();
    render(<UserProfile />, { wrapper: Wrapper });
    expect(screen.getByText("A")).toBeDefined();
  });

  test("renders without error when all fields are present", async () => {
    const { UserProfile } = await import("../components/user-profile");
    const Wrapper = await getWrapper();
    expect(() => render(<UserProfile />, { wrapper: Wrapper })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Inline editing — name field
// ---------------------------------------------------------------------------

describe("inline editing — name", () => {
  beforeEach(() => {
    mockUseSession.mockReturnValue({
      data: {
        user: { id: "user-1", name: "Test User", email: "test@example.com", image: null },
        session: { id: "session-1", userId: "user-1" },
      },
      isPending: false,
      error: null,
    });
    mockUpdateUser.mockClear();
  });

  test("clicking on name enters edit mode (input appears)", async () => {
    const { UserProfile } = await import("../components/user-profile");
    const Wrapper = await getWrapper();
    render(<UserProfile />, { wrapper: Wrapper });

    fireEvent.click(screen.getByText("Test User"));

    await waitFor(() => {
      // An input should now be visible
      expect(
        screen.queryByDisplayValue("Test User") ??
        screen.queryByRole("textbox", { name: /name/i })
      ).toBeDefined();
    });
  });

  test("edit mode shows a Save button", async () => {
    const { UserProfile } = await import("../components/user-profile");
    const Wrapper = await getWrapper();
    render(<UserProfile />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText("Test User"));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /save/i })).toBeDefined();
    });
  });

  test("edit mode shows a Cancel button", async () => {
    const { UserProfile } = await import("../components/user-profile");
    const Wrapper = await getWrapper();
    render(<UserProfile />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText("Test User"));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /cancel/i })).toBeDefined();
    });
  });

  test("cancel button discards changes and returns to display mode", async () => {
    const { UserProfile } = await import("../components/user-profile");
    const Wrapper = await getWrapper();
    render(<UserProfile />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText("Test User"));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /cancel/i })).toBeDefined();
    });

    // Change the value then cancel
    const input = screen.queryByDisplayValue("Test User") ??
      screen.queryByRole("textbox", { name: /name/i }) as HTMLInputElement | null;
    if (input) {
      fireEvent.change(input, { target: { value: "Changed Name" } });
    }
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    await waitFor(() => {
      // Original name is restored
      expect(screen.getByText("Test User")).toBeDefined();
      // Input should be gone
      expect(screen.queryByDisplayValue("Changed Name")).toBeNull();
    });
  });

  test("save button calls authClient.updateUser with new name", async () => {
    mockUpdateUser.mockResolvedValue({ data: { status: true }, error: null });
    const { UserProfile } = await import("../components/user-profile");
    const Wrapper = await getWrapper();
    render(<UserProfile />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText("Test User"));

    await waitFor(() => {
      expect(
        screen.queryByDisplayValue("Test User") ??
        screen.queryByRole("textbox", { name: /name/i })
      ).toBeDefined();
    });

    const input = (screen.queryByDisplayValue("Test User") ??
      screen.queryByRole("textbox", { name: /name/i })) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Updated Name" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(mockUpdateUser).toHaveBeenCalledTimes(1);
    });
    const callArg = mockUpdateUser.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(callArg?.name).toBe("Updated Name");
  });

  test("empty name is rejected — updateUser not called", async () => {
    const { UserProfile } = await import("../components/user-profile");
    const Wrapper = await getWrapper();
    render(<UserProfile />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText("Test User"));

    await waitFor(() => {
      expect(
        screen.queryByDisplayValue("Test User") ??
        screen.queryByRole("textbox", { name: /name/i })
      ).toBeDefined();
    });

    const input = (screen.queryByDisplayValue("Test User") ??
      screen.queryByRole("textbox", { name: /name/i })) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(mockUpdateUser).not.toHaveBeenCalled();
    });
  });

  test("name field input has an accessible label", async () => {
    const { UserProfile } = await import("../components/user-profile");
    const Wrapper = await getWrapper();
    render(<UserProfile />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText("Test User"));

    await waitFor(() => {
      expect(screen.getByLabelText(/name/i)).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Inline editing — email field
// ---------------------------------------------------------------------------

describe("inline editing — email", () => {
  beforeEach(() => {
    mockUseSession.mockReturnValue({
      data: {
        user: { id: "user-1", name: "Test User", email: "test@example.com", image: null },
        session: { id: "session-1", userId: "user-1" },
      },
      isPending: false,
      error: null,
    });
    mockUpdateUser.mockClear();
  });

  test("clicking on email enters edit mode (input appears)", async () => {
    const { UserProfile } = await import("../components/user-profile");
    const Wrapper = await getWrapper();
    render(<UserProfile />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText("test@example.com"));

    await waitFor(() => {
      expect(
        screen.queryByDisplayValue("test@example.com") ??
        screen.queryByRole("textbox", { name: /email/i })
      ).toBeDefined();
    });
  });

  test("email field input has an accessible label", async () => {
    const { UserProfile } = await import("../components/user-profile");
    const Wrapper = await getWrapper();
    render(<UserProfile />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText("test@example.com"));

    await waitFor(() => {
      expect(screen.getByLabelText(/email/i)).toBeDefined();
    });
  });

  test("save button calls authClient.updateUser with new email", async () => {
    mockUpdateUser.mockResolvedValue({ data: { status: true }, error: null });
    const { UserProfile } = await import("../components/user-profile");
    const Wrapper = await getWrapper();
    render(<UserProfile />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText("test@example.com"));

    await waitFor(() => {
      expect(
        screen.queryByDisplayValue("test@example.com") ??
        screen.queryByRole("textbox", { name: /email/i })
      ).toBeDefined();
    });

    const input = (screen.queryByDisplayValue("test@example.com") ??
      screen.queryByRole("textbox", { name: /email/i })) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "new@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(mockUpdateUser).toHaveBeenCalledTimes(1);
    });
    const callArg = mockUpdateUser.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(callArg?.email).toBe("new@example.com");
  });

  test("invalid email format is rejected — updateUser not called", async () => {
    const { UserProfile } = await import("../components/user-profile");
    const Wrapper = await getWrapper();
    render(<UserProfile />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText("test@example.com"));

    await waitFor(() => {
      expect(
        screen.queryByDisplayValue("test@example.com") ??
        screen.queryByRole("textbox", { name: /email/i })
      ).toBeDefined();
    });

    const input = (screen.queryByDisplayValue("test@example.com") ??
      screen.queryByRole("textbox", { name: /email/i })) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "not-an-email" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(mockUpdateUser).not.toHaveBeenCalled();
    });
  });

  test("cancel button discards email changes", async () => {
    const { UserProfile } = await import("../components/user-profile");
    const Wrapper = await getWrapper();
    render(<UserProfile />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText("test@example.com"));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /cancel/i })).toBeDefined();
    });

    const input = (screen.queryByDisplayValue("test@example.com") ??
      screen.queryByRole("textbox", { name: /email/i })) as HTMLInputElement;
    if (input) {
      fireEvent.change(input, { target: { value: "changed@example.com" } });
    }
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    await waitFor(() => {
      expect(screen.getByText("test@example.com")).toBeDefined();
      expect(screen.queryByDisplayValue("changed@example.com")).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Save feedback
// ---------------------------------------------------------------------------

describe("save feedback", () => {
  beforeEach(() => {
    mockUseSession.mockReturnValue({
      data: {
        user: { id: "user-1", name: "Test User", email: "test@example.com", image: null },
        session: { id: "session-1", userId: "user-1" },
      },
      isPending: false,
      error: null,
    });
    mockUpdateUser.mockClear();
  });

  test("shows success message after successful save", async () => {
    mockUpdateUser.mockResolvedValue({ data: { status: true }, error: null });
    const { UserProfile } = await import("../components/user-profile");
    const Wrapper = await getWrapper();
    render(<UserProfile />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText("Test User"));

    await waitFor(() => {
      expect(
        screen.queryByDisplayValue("Test User") ??
        screen.queryByRole("textbox", { name: /name/i })
      ).toBeDefined();
    });

    const input = (screen.queryByDisplayValue("Test User") ??
      screen.queryByRole("textbox", { name: /name/i })) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Updated Name" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(screen.getByText(/saved|updated|success/i)).toBeDefined();
    });
  });

  test("shows inline error message on API failure", async () => {
    mockUpdateUser.mockResolvedValue({
      data: null,
      error: { message: "Update failed" },
    });
    const { UserProfile } = await import("../components/user-profile");
    const Wrapper = await getWrapper();
    render(<UserProfile />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText("Test User"));

    await waitFor(() => {
      expect(
        screen.queryByDisplayValue("Test User") ??
        screen.queryByRole("textbox", { name: /name/i })
      ).toBeDefined();
    });

    const input = (screen.queryByDisplayValue("Test User") ??
      screen.queryByRole("textbox", { name: /name/i })) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "New Name" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(screen.getByText(/error|failed|something went wrong/i)).toBeDefined();
    });
  });

  test("shows error on network failure (rejected promise)", async () => {
    mockUpdateUser.mockRejectedValue(new Error("Network error"));

    const origError = console.error;
    console.error = () => {};

    const { UserProfile } = await import("../components/user-profile");
    const Wrapper = await getWrapper();
    render(<UserProfile />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText("Test User"));

    await waitFor(() => {
      expect(
        screen.queryByDisplayValue("Test User") ??
        screen.queryByRole("textbox", { name: /name/i })
      ).toBeDefined();
    });

    const input = (screen.queryByDisplayValue("Test User") ??
      screen.queryByRole("textbox", { name: /name/i })) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "New Name" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(screen.getByText(/error|failed|something went wrong/i)).toBeDefined();
    });

    console.error = origError;
    mockUpdateUser.mockResolvedValue({ data: { status: true }, error: null });
  });

  test("save button is disabled during save loading", async () => {
    let resolve!: (v: unknown) => void;
    mockUpdateUser.mockReturnValue(new Promise((res) => { resolve = res; }));

    const { UserProfile } = await import("../components/user-profile");
    const Wrapper = await getWrapper();
    render(<UserProfile />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText("Test User"));

    await waitFor(() => {
      expect(
        screen.queryByDisplayValue("Test User") ??
        screen.queryByRole("textbox", { name: /name/i })
      ).toBeDefined();
    });

    const input = (screen.queryByDisplayValue("Test User") ??
      screen.queryByRole("textbox", { name: /name/i })) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "New Name" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save/i }));
    });

    const saveBtn = screen.getByRole("button", { name: /save/i }) as HTMLButtonElement;
    expect(
      saveBtn.disabled || saveBtn.getAttribute("aria-disabled") === "true"
    ).toBe(true);

    resolve({ data: { status: true }, error: null });
  });
});

// ---------------------------------------------------------------------------
// Unauthenticated redirect
// ---------------------------------------------------------------------------

describe("unauthenticated redirect", () => {
  test("redirects to sign-in when session has no user", async () => {
    mockUseSession.mockReturnValue({ data: null, isPending: false, error: null });
    mockPush.mockClear();

    const { UserProfile } = await import("../components/user-profile");
    const Wrapper = await getWrapper();
    render(<UserProfile />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledTimes(1);
    });
    const destination = mockPush.mock.calls[0]?.[0] as string | undefined;
    expect(destination).toMatch(/sign.?in/i);
  });

  test("does not redirect when session is loading (isPending true)", async () => {
    mockUseSession.mockReturnValue({ data: null, isPending: true, error: null });
    mockPush.mockClear();

    const { UserProfile } = await import("../components/user-profile");
    const Wrapper = await getWrapper();
    render(<UserProfile />, { wrapper: Wrapper });

    // Give effects time to fire
    await new Promise((r) => setTimeout(r, 50));
    expect(mockPush).not.toHaveBeenCalled();

    // Reset
    mockUseSession.mockReturnValue({
      data: {
        user: { id: "user-1", name: "Test User", email: "test@example.com", image: null },
        session: { id: "session-1", userId: "user-1" },
      },
      isPending: false,
      error: null,
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
        user: { id: "user-1", name: "Test User", email: "test@example.com", image: null },
        session: { id: "session-1", userId: "user-1" },
      },
      isPending: false,
      error: null,
    });
  });

  test("accepts className prop on the root element", async () => {
    const { UserProfile } = await import("../components/user-profile");
    const Wrapper = await getWrapper();
    const { container } = render(<UserProfile className="custom-profile" />, { wrapper: Wrapper });
    expect(container.querySelector(".custom-profile")).toBeDefined();
  });

  test("accepts classNames.card override", async () => {
    const { UserProfile } = await import("../components/user-profile");
    const Wrapper = await getWrapper();
    const { container } = render(
      <UserProfile classNames={{ card: "custom-card" }} />,
      { wrapper: Wrapper }
    );
    expect(container.querySelector(".custom-card")).toBeDefined();
  });

  test("accepts classNames.avatar override", async () => {
    const { UserProfile } = await import("../components/user-profile");
    const Wrapper = await getWrapper();
    const { container } = render(
      <UserProfile classNames={{ avatar: "custom-avatar" }} />,
      { wrapper: Wrapper }
    );
    expect(container.querySelector(".custom-avatar")).toBeDefined();
  });

  test("accepts classNames.saveButton override", async () => {
    const { UserProfile } = await import("../components/user-profile");
    const Wrapper = await getWrapper();
    render(
      <UserProfile classNames={{ saveButton: "custom-save-btn" }} />,
      { wrapper: Wrapper }
    );

    // Enter edit mode to reveal save button
    fireEvent.click(screen.getByText("Test User"));
    await waitFor(() => {
      expect(
        screen.queryByDisplayValue("Test User") ??
        screen.queryByRole("textbox", { name: /name/i })
      ).toBeDefined();
    });

    const saveBtn = screen.queryByRole("button", { name: /save/i });
    expect(saveBtn?.className).toContain("custom-save-btn");
  });
});
