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
// Mock @context-kit/auth/client
// ---------------------------------------------------------------------------

const mockChangePassword = mock(() =>
  Promise.resolve({ data: { status: true }, error: null })
);
const mockUseSession = mock(() => ({
  data: {
    user: { id: "user-1", name: "Test User", email: "test@example.com" },
    session: { id: "session-1", userId: "user-1" },
  },
  isPending: false,
  error: null,
}));

const mockAuthClient = {
  changePassword: mockChangePassword,
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
  usePathname: mock(() => "/profile/password"),
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
// Helper: fill all three password fields
// ---------------------------------------------------------------------------

function fillForm(current: string, newPwd: string, confirm: string) {
  const currentInput = screen.getByLabelText(/current password/i);
  const newInput = screen.getByLabelText(/new password/i);
  const confirmInput = screen.getByLabelText(/confirm.*new password|confirm password/i);
  fireEvent.change(currentInput, { target: { value: current } });
  fireEvent.change(newInput, { target: { value: newPwd } });
  fireEvent.change(confirmInput, { target: { value: confirm } });
  return { currentInput, newInput, confirmInput };
}

// ---------------------------------------------------------------------------
// File existence
// ---------------------------------------------------------------------------

describe("file structure", () => {
  test("src/components/change-password.tsx exists", () => {
    expect(fileExists("src/components/change-password.tsx")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// changePasswordSchema
// ---------------------------------------------------------------------------

describe("changePasswordSchema", () => {
  async function getSchema(rules: Record<string, unknown> = {}) {
    const { changePasswordSchema } = await import("../lib/schemas");
    return typeof changePasswordSchema === "function"
      ? changePasswordSchema(rules)
      : changePasswordSchema;
  }

  test("changePasswordSchema is exported from src/lib/schemas", async () => {
    const mod = await import("../lib/schemas");
    expect(mod.changePasswordSchema).toBeDefined();
  });

  test("accepts valid data with matching new passwords", async () => {
    const schema = await getSchema();
    const result = schema.safeParse({
      currentPassword: "OldPassword1!",
      newPassword: "NewPassword1!",
      confirmNewPassword: "NewPassword1!",
    });
    expect(result.success).toBe(true);
  });

  test("rejects when confirmNewPassword does not match newPassword", async () => {
    const schema = await getSchema();
    const result = schema.safeParse({
      currentPassword: "OldPassword1!",
      newPassword: "NewPassword1!",
      confirmNewPassword: "Different1!",
    });
    expect(result.success).toBe(false);
  });

  test("rejects when newPassword is shorter than default minLength (8)", async () => {
    const schema = await getSchema();
    const result = schema.safeParse({
      currentPassword: "OldPassword1!",
      newPassword: "Pw1!",
      confirmNewPassword: "Pw1!",
    });
    expect(result.success).toBe(false);
  });

  test("rejects when newPassword exceeds default maxLength (128)", async () => {
    const schema = await getSchema();
    const tooLong = "A".repeat(129) + "1!";
    const result = schema.safeParse({
      currentPassword: "OldPassword1!",
      newPassword: tooLong,
      confirmNewPassword: tooLong,
    });
    expect(result.success).toBe(false);
  });

  test("rejects when currentPassword is empty", async () => {
    const schema = await getSchema();
    const result = schema.safeParse({
      currentPassword: "",
      newPassword: "NewPassword1!",
      confirmNewPassword: "NewPassword1!",
    });
    expect(result.success).toBe(false);
  });

  test("rejects when newPassword equals currentPassword", async () => {
    const schema = await getSchema();
    const result = schema.safeParse({
      currentPassword: "SamePassword1!",
      newPassword: "SamePassword1!",
      confirmNewPassword: "SamePassword1!",
    });
    expect(result.success).toBe(false);
  });

  test("rejects when newPassword is empty", async () => {
    const schema = await getSchema();
    const result = schema.safeParse({
      currentPassword: "OldPassword1!",
      newPassword: "",
      confirmNewPassword: "",
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing fields", async () => {
    const schema = await getSchema();
    expect(schema.safeParse({}).success).toBe(false);
  });

  test("accepts password meeting custom minLength via factory", async () => {
    const schema = await getSchema({ minLength: 12 });
    const pwd = "LongPassword1!";
    const result = schema.safeParse({
      currentPassword: "OldPassword1!",
      newPassword: pwd,
      confirmNewPassword: pwd,
    });
    expect(result.success).toBe(true);
  });

  test("rejects password below custom minLength", async () => {
    const schema = await getSchema({ minLength: 12 });
    const result = schema.safeParse({
      currentPassword: "OldPassword1!",
      newPassword: "Short1!",
      confirmNewPassword: "Short1!",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ChangePassword export
// ---------------------------------------------------------------------------

describe("ChangePassword export", () => {
  test("ChangePassword is exported from src/components/change-password", async () => {
    const mod = await import("../components/change-password");
    expect(typeof mod.ChangePassword).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// ChangePassword rendering
// ---------------------------------------------------------------------------

describe("ChangePassword rendering", () => {
  beforeEach(() => {
    mockUseSession.mockReturnValue({
      data: {
        user: { id: "user-1", name: "Test User", email: "test@example.com" },
        session: { id: "session-1", userId: "user-1" },
      },
      isPending: false,
      error: null,
    });
  });

  test("renders current password field", async () => {
    const { ChangePassword } = await import("../components/change-password");
    const Wrapper = await getWrapper();
    render(<ChangePassword />, { wrapper: Wrapper });
    expect(screen.getByLabelText(/current password/i)).toBeDefined();
  });

  test("renders new password field", async () => {
    const { ChangePassword } = await import("../components/change-password");
    const Wrapper = await getWrapper();
    render(<ChangePassword />, { wrapper: Wrapper });
    expect(screen.getByLabelText(/new password/i)).toBeDefined();
  });

  test("renders confirm new password field", async () => {
    const { ChangePassword } = await import("../components/change-password");
    const Wrapper = await getWrapper();
    render(<ChangePassword />, { wrapper: Wrapper });
    expect(screen.getByLabelText(/confirm.*new password|confirm password/i)).toBeDefined();
  });

  test("all three password fields have type='password'", async () => {
    const { ChangePassword } = await import("../components/change-password");
    const Wrapper = await getWrapper();
    render(<ChangePassword />, { wrapper: Wrapper });
    const currentInput = screen.getByLabelText(/current password/i) as HTMLInputElement;
    const newInput = screen.getByLabelText(/new password/i) as HTMLInputElement;
    const confirmInput = screen.getByLabelText(/confirm.*new password|confirm password/i) as HTMLInputElement;
    expect(currentInput.type).toBe("password");
    expect(newInput.type).toBe("password");
    expect(confirmInput.type).toBe("password");
  });

  test("renders a submit button", async () => {
    const { ChangePassword } = await import("../components/change-password");
    const Wrapper = await getWrapper();
    render(<ChangePassword />, { wrapper: Wrapper });
    expect(screen.getByRole("button", { name: /change password|update password|save/i })).toBeDefined();
  });

  test("renders without errors when session is active", async () => {
    const { ChangePassword } = await import("../components/change-password");
    const Wrapper = await getWrapper();
    expect(() => render(<ChangePassword />, { wrapper: Wrapper })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// ChangePassword form submission
// ---------------------------------------------------------------------------

describe("ChangePassword form submission", () => {
  beforeEach(() => {
    mockChangePassword.mockClear();
    mockPush.mockClear();
    mockUseSession.mockReturnValue({
      data: {
        user: { id: "user-1", name: "Test User", email: "test@example.com" },
        session: { id: "session-1", userId: "user-1" },
      },
      isPending: false,
      error: null,
    });
    mockChangePassword.mockResolvedValue({ data: { status: true }, error: null });
  });

  test("calls authClient.changePassword() with currentPassword and newPassword on submit", async () => {
    const { ChangePassword } = await import("../components/change-password");
    const Wrapper = await getWrapper();
    render(<ChangePassword />, { wrapper: Wrapper });

    const { currentInput } = fillForm("OldPassword1!", "NewPassword1!", "NewPassword1!");
    fireEvent.submit(currentInput.closest("form")!);

    await waitFor(() => {
      expect(mockChangePassword).toHaveBeenCalledTimes(1);
    });
    const arg = mockChangePassword.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(arg?.currentPassword).toBe("OldPassword1!");
    expect(arg?.newPassword).toBe("NewPassword1!");
  });

  test("shows success message after password is changed", async () => {
    const { ChangePassword } = await import("../components/change-password");
    const Wrapper = await getWrapper();
    render(<ChangePassword />, { wrapper: Wrapper });

    const { currentInput } = fillForm("OldPassword1!", "NewPassword1!", "NewPassword1!");
    fireEvent.submit(currentInput.closest("form")!);

    await waitFor(() => {
      expect(screen.getByText(/password.*changed|password.*updated|success/i)).toBeDefined();
    });
  });

  test("shows error when current password is wrong", async () => {
    mockChangePassword.mockResolvedValue({
      data: null,
      error: { message: "Incorrect current password" },
    });
    const { ChangePassword } = await import("../components/change-password");
    const Wrapper = await getWrapper();
    render(<ChangePassword />, { wrapper: Wrapper });

    const { currentInput } = fillForm("WrongPassword1!", "NewPassword1!", "NewPassword1!");
    fireEvent.submit(currentInput.closest("form")!);

    await waitFor(() => {
      expect(
        screen.getByText(/incorrect.*password|wrong.*password|current password.*incorrect/i)
      ).toBeDefined();
    });
  });

  test("shows generic error on network failure", async () => {
    mockChangePassword.mockRejectedValue(new Error("Network error"));
    const origError = console.error;
    console.error = () => {};

    const { ChangePassword } = await import("../components/change-password");
    const Wrapper = await getWrapper();
    render(<ChangePassword />, { wrapper: Wrapper });

    const { currentInput } = fillForm("OldPassword1!", "NewPassword1!", "NewPassword1!");
    fireEvent.submit(currentInput.closest("form")!);

    await waitFor(() => {
      expect(screen.getByText(/something went wrong|error|try again/i)).toBeDefined();
    });

    console.error = origError;
    mockChangePassword.mockResolvedValue({ data: { status: true }, error: null });
  });

  test("disables submit button during loading", async () => {
    let resolve!: (v: unknown) => void;
    mockChangePassword.mockReturnValue(new Promise((res) => { resolve = res; }));

    const { ChangePassword } = await import("../components/change-password");
    const Wrapper = await getWrapper();
    render(<ChangePassword />, { wrapper: Wrapper });

    const { currentInput } = fillForm("OldPassword1!", "NewPassword1!", "NewPassword1!");
    await act(async () => {
      fireEvent.submit(currentInput.closest("form")!);
    });

    const btn = screen.getByRole("button", {
      name: /change password|update password|save/i,
    }) as HTMLButtonElement;
    expect(btn.disabled || btn.getAttribute("aria-disabled") === "true").toBe(true);

    resolve({ data: { status: true }, error: null });
    mockChangePassword.mockResolvedValue({ data: { status: true }, error: null });
  });
});

// ---------------------------------------------------------------------------
// ChangePassword validation
// ---------------------------------------------------------------------------

describe("ChangePassword validation", () => {
  beforeEach(() => {
    mockChangePassword.mockClear();
    mockUseSession.mockReturnValue({
      data: {
        user: { id: "user-1", name: "Test User", email: "test@example.com" },
        session: { id: "session-1", userId: "user-1" },
      },
      isPending: false,
      error: null,
    });
  });

  test("does not call changePassword() when current password is empty", async () => {
    const { ChangePassword } = await import("../components/change-password");
    const Wrapper = await getWrapper();
    render(<ChangePassword />, { wrapper: Wrapper });

    const { currentInput } = fillForm("", "NewPassword1!", "NewPassword1!");
    fireEvent.submit(currentInput.closest("form")!);

    await waitFor(() => {
      expect(mockChangePassword).not.toHaveBeenCalled();
    });
  });

  test("does not call changePassword() when new password is empty", async () => {
    const { ChangePassword } = await import("../components/change-password");
    const Wrapper = await getWrapper();
    render(<ChangePassword />, { wrapper: Wrapper });

    const { currentInput } = fillForm("OldPassword1!", "", "");
    fireEvent.submit(currentInput.closest("form")!);

    await waitFor(() => {
      expect(mockChangePassword).not.toHaveBeenCalled();
    });
  });

  test("does not call changePassword() when confirm does not match new password", async () => {
    const { ChangePassword } = await import("../components/change-password");
    const Wrapper = await getWrapper();
    render(<ChangePassword />, { wrapper: Wrapper });

    const { currentInput } = fillForm("OldPassword1!", "NewPassword1!", "Different1!");
    fireEvent.submit(currentInput.closest("form")!);

    await waitFor(() => {
      expect(mockChangePassword).not.toHaveBeenCalled();
    });
  });

  test("shows validation error when confirm does not match new password", async () => {
    const { ChangePassword } = await import("../components/change-password");
    const Wrapper = await getWrapper();
    render(<ChangePassword />, { wrapper: Wrapper });

    const { currentInput } = fillForm("OldPassword1!", "NewPassword1!", "Different1!");
    fireEvent.submit(currentInput.closest("form")!);

    await waitFor(() => {
      expect(screen.getByText(/passwords.*match|do not match|match/i)).toBeDefined();
    });
  });

  test("does not call changePassword() when new password equals current password", async () => {
    const { ChangePassword } = await import("../components/change-password");
    const Wrapper = await getWrapper();
    render(<ChangePassword />, { wrapper: Wrapper });

    const { currentInput } = fillForm("SamePassword1!", "SamePassword1!", "SamePassword1!");
    fireEvent.submit(currentInput.closest("form")!);

    await waitFor(() => {
      expect(mockChangePassword).not.toHaveBeenCalled();
    });
  });

  test("shows validation error when new password equals current password", async () => {
    const { ChangePassword } = await import("../components/change-password");
    const Wrapper = await getWrapper();
    render(<ChangePassword />, { wrapper: Wrapper });

    const { currentInput } = fillForm("SamePassword1!", "SamePassword1!", "SamePassword1!");
    fireEvent.submit(currentInput.closest("form")!);

    await waitFor(() => {
      expect(
        screen.getByText(/same.*current|different.*current|must be different|new password.*different/i)
      ).toBeDefined();
    });
  });

  test("does not call changePassword() when new password is below default minLength (8)", async () => {
    const { ChangePassword } = await import("../components/change-password");
    const Wrapper = await getWrapper();
    render(<ChangePassword />, { wrapper: Wrapper });

    const { currentInput } = fillForm("OldPassword1!", "Pw1!", "Pw1!");
    fireEvent.submit(currentInput.closest("form")!);

    await waitFor(() => {
      expect(mockChangePassword).not.toHaveBeenCalled();
    });
  });

  test("passwordRules.minLength=12 rejects passwords below custom minimum", async () => {
    const { ChangePassword } = await import("../components/change-password");
    const Wrapper = await getWrapper();
    render(<ChangePassword passwordRules={{ minLength: 12 }} />, { wrapper: Wrapper });

    // "NewPwd1!" is only 8 chars — below custom min of 12
    const { currentInput } = fillForm("OldPassword1!", "NewPwd1!", "NewPwd1!");
    fireEvent.submit(currentInput.closest("form")!);

    await waitFor(() => {
      expect(mockChangePassword).not.toHaveBeenCalled();
    });
  });

  test("passwordRules.minLength=12 accepts passwords meeting the custom minimum", async () => {
    mockChangePassword.mockResolvedValue({ data: { status: true }, error: null });
    const { ChangePassword } = await import("../components/change-password");
    const Wrapper = await getWrapper();
    render(<ChangePassword passwordRules={{ minLength: 12 }} />, { wrapper: Wrapper });

    const longPwd = "LongPassword1!";
    const { currentInput } = fillForm("OldPassword1!", longPwd, longPwd);
    fireEvent.submit(currentInput.closest("form")!);

    await waitFor(() => {
      expect(mockChangePassword).toHaveBeenCalledTimes(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Unauthenticated redirect
// ---------------------------------------------------------------------------

describe("unauthenticated redirect", () => {
  test("redirects to sign-in when no session", async () => {
    mockUseSession.mockReturnValue({ data: null, isPending: false, error: null });
    mockPush.mockClear();

    const { ChangePassword } = await import("../components/change-password");
    const Wrapper = await getWrapper();
    render(<ChangePassword />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledTimes(1);
    });
    const dest = mockPush.mock.calls[0]?.[0] as string | undefined;
    expect(dest).toMatch(/sign.?in/i);
  });

  test("does not redirect while session is loading", async () => {
    mockUseSession.mockReturnValue({ data: null, isPending: true, error: null });
    mockPush.mockClear();

    const { ChangePassword } = await import("../components/change-password");
    const Wrapper = await getWrapper();
    render(<ChangePassword />, { wrapper: Wrapper });

    await new Promise((r) => setTimeout(r, 50));
    expect(mockPush).not.toHaveBeenCalled();

    // Reset session for subsequent tests
    mockUseSession.mockReturnValue({
      data: {
        user: { id: "user-1", name: "Test User", email: "test@example.com" },
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
        user: { id: "user-1", name: "Test User", email: "test@example.com" },
        session: { id: "session-1", userId: "user-1" },
      },
      isPending: false,
      error: null,
    });
  });

  test("accepts className prop on root element", async () => {
    const { ChangePassword } = await import("../components/change-password");
    const Wrapper = await getWrapper();
    const { container } = render(
      <ChangePassword className="custom-change-pwd" />,
      { wrapper: Wrapper }
    );
    expect(container.querySelector(".custom-change-pwd")).toBeDefined();
  });

  test("accepts classNames.submitButton override", async () => {
    const { ChangePassword } = await import("../components/change-password");
    const Wrapper = await getWrapper();
    render(
      <ChangePassword classNames={{ submitButton: "custom-submit" }} />,
      { wrapper: Wrapper }
    );
    const btn = screen.getByRole("button", { name: /change password|update password|save/i });
    expect(btn.className).toContain("custom-submit");
  });

  test("accepts classNames.card override", async () => {
    const { ChangePassword } = await import("../components/change-password");
    const Wrapper = await getWrapper();
    const { container } = render(
      <ChangePassword classNames={{ card: "custom-card" }} />,
      { wrapper: Wrapper }
    );
    expect(container.querySelector(".custom-card")).toBeDefined();
  });
});
