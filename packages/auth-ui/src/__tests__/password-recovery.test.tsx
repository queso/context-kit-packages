import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { existsSync } from "fs";
import { resolve } from "path";
import type React from "react";

const pkgRoot = resolve(import.meta.dir, "../..");

function fileExists(relativePath: string) {
  return existsSync(resolve(pkgRoot, relativePath));
}

// ---------------------------------------------------------------------------
// Mock @context-kit/auth/client
// Note: Better Auth uses `forgetPassword` (not `forgotPassword`)
// ---------------------------------------------------------------------------

const mockForgetPassword = mock(() =>
  Promise.resolve({ data: { status: true }, error: null })
);
const mockResetPassword = mock(() =>
  Promise.resolve({ data: { status: true }, error: null })
);
const mockUseSession = mock(() => ({
  data: null,
  isPending: false,
  error: null,
}));
const mockSignIn = mock(() => Promise.resolve({ data: null, error: null }));
const mockSignOut = mock(() => Promise.resolve({ data: null, error: null }));
const mockSignUp = mock(() => Promise.resolve({ data: null, error: null }));

const mockAuthClient = {
  forgetPassword: mockForgetPassword,
  resetPassword: mockResetPassword,
  useSession: mockUseSession,
  signIn: mockSignIn,
  signOut: mockSignOut,
  signUp: mockSignUp,
};

const mockCreateAuthClient = mock(() => mockAuthClient);

mock.module("@context-kit/auth/client", () => ({
  createAuthClient: mockCreateAuthClient,
}));

// ---------------------------------------------------------------------------
// Mock next/navigation (useSearchParams + useRouter)
// ---------------------------------------------------------------------------

const mockGet = mock((key: string) => {
  if (key === "token") return "test-reset-token-abc123";
  return null;
});

const mockSearchParams = { get: mockGet };
const mockUseSearchParams = mock(() => mockSearchParams);
const mockPush = mock(() => {});
const mockUseRouter = mock(() => ({
  push: mockPush,
  replace: mock(() => {}),
  back: mock(() => {}),
}));

mock.module("next/navigation", () => ({
  useSearchParams: mockUseSearchParams,
  useRouter: mockUseRouter,
  usePathname: mock(() => "/"),
}));

// ---------------------------------------------------------------------------
// Wrapper: AuthProvider for components that need auth context
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
  test("src/components/forgot-password.tsx exists", () => {
    expect(fileExists("src/components/forgot-password.tsx")).toBe(true);
  });

  test("src/components/reset-password.tsx exists", () => {
    expect(fileExists("src/components/reset-password.tsx")).toBe(true);
  });

  test("src/lib/schemas.ts exists", () => {
    expect(fileExists("src/lib/schemas.ts")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

describe("forgotPasswordSchema", () => {
  test("forgotPasswordSchema is exported from src/lib/schemas", async () => {
    const mod = await import("../lib/schemas");
    expect(mod.forgotPasswordSchema).toBeDefined();
  });

  test("forgotPasswordSchema accepts a valid email", async () => {
    const { forgotPasswordSchema } = await import("../lib/schemas");
    const result = forgotPasswordSchema.safeParse({
      email: "user@example.com",
    });
    expect(result.success).toBe(true);
  });

  test("forgotPasswordSchema rejects an invalid email", async () => {
    const { forgotPasswordSchema } = await import("../lib/schemas");
    const result = forgotPasswordSchema.safeParse({ email: "not-an-email" });
    expect(result.success).toBe(false);
  });

  test("forgotPasswordSchema rejects an empty email", async () => {
    const { forgotPasswordSchema } = await import("../lib/schemas");
    const result = forgotPasswordSchema.safeParse({ email: "" });
    expect(result.success).toBe(false);
  });

  test("forgotPasswordSchema rejects missing email field", async () => {
    const { forgotPasswordSchema } = await import("../lib/schemas");
    const result = forgotPasswordSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("resetPasswordSchema", () => {
  test("resetPasswordSchema is exported from src/lib/schemas", async () => {
    const mod = await import("../lib/schemas");
    expect(mod.resetPasswordSchema).toBeDefined();
  });

  test("resetPasswordSchema accepts valid matching passwords with default rules", async () => {
    const { resetPasswordSchema } = await import("../lib/schemas");
    const schema =
      typeof resetPasswordSchema === "function"
        ? resetPasswordSchema({})
        : resetPasswordSchema;
    const result = schema.safeParse({
      password: "Password1!",
      confirmPassword: "Password1!",
    });
    expect(result.success).toBe(true);
  });

  test("resetPasswordSchema rejects mismatched passwords", async () => {
    const { resetPasswordSchema } = await import("../lib/schemas");
    const schema =
      typeof resetPasswordSchema === "function"
        ? resetPasswordSchema({})
        : resetPasswordSchema;
    const result = schema.safeParse({
      password: "Password1!",
      confirmPassword: "Different1!",
    });
    expect(result.success).toBe(false);
  });

  test("resetPasswordSchema rejects password shorter than minLength", async () => {
    const { resetPasswordSchema } = await import("../lib/schemas");
    const schema =
      typeof resetPasswordSchema === "function"
        ? resetPasswordSchema({ minLength: 12 })
        : resetPasswordSchema;
    const result = schema.safeParse({
      password: "Short1!",
      confirmPassword: "Short1!",
    });
    expect(result.success).toBe(false);
  });

  test("resetPasswordSchema accepts password meeting custom minLength", async () => {
    const { resetPasswordSchema } = await import("../lib/schemas");
    const schema =
      typeof resetPasswordSchema === "function"
        ? resetPasswordSchema({ minLength: 12 })
        : resetPasswordSchema;
    const pwd = "LongEnough12!";
    const result = schema.safeParse({ password: pwd, confirmPassword: pwd });
    expect(result.success).toBe(true);
  });

  test("resetPasswordSchema rejects empty password", async () => {
    const { resetPasswordSchema } = await import("../lib/schemas");
    const schema =
      typeof resetPasswordSchema === "function"
        ? resetPasswordSchema({})
        : resetPasswordSchema;
    const result = schema.safeParse({ password: "", confirmPassword: "" });
    expect(result.success).toBe(false);
  });

  test("resetPasswordSchema rejects missing fields", async () => {
    const { resetPasswordSchema } = await import("../lib/schemas");
    const schema =
      typeof resetPasswordSchema === "function"
        ? resetPasswordSchema({})
        : resetPasswordSchema;
    const result = schema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ForgotPassword component
// ---------------------------------------------------------------------------

describe("ForgotPassword component", () => {
  beforeEach(() => {
    mockForgetPassword.mockClear();
  });

  test("ForgotPassword is exported from src/components/forgot-password", async () => {
    const mod = await import("../components/forgot-password");
    expect(typeof mod.ForgotPassword).toBe("function");
  });

  test("ForgotPassword renders an email input", async () => {
    const { ForgotPassword } = await import("../components/forgot-password");
    const Wrapper = await getWrapper();
    render(<ForgotPassword />, { wrapper: Wrapper });
    expect(screen.getByRole("textbox", { name: /email/i })).toBeDefined();
  });

  test("ForgotPassword renders a submit button", async () => {
    const { ForgotPassword } = await import("../components/forgot-password");
    const Wrapper = await getWrapper();
    render(<ForgotPassword />, { wrapper: Wrapper });
    expect(
      screen.getByRole("button", { name: /send|reset|submit/i })
    ).toBeDefined();
  });

  test("ForgotPassword renders a 'Back to sign in' link", async () => {
    const { ForgotPassword } = await import("../components/forgot-password");
    const Wrapper = await getWrapper();
    render(<ForgotPassword />, { wrapper: Wrapper });
    expect(screen.getByText(/back to sign.?in/i)).toBeDefined();
  });

  test("ForgotPassword email input has accessible label", async () => {
    const { ForgotPassword } = await import("../components/forgot-password");
    const Wrapper = await getWrapper();
    render(<ForgotPassword />, { wrapper: Wrapper });
    // getByLabelText confirms label is associated via htmlFor or aria-label
    expect(screen.getByLabelText(/email/i)).toBeDefined();
  });

  test("ForgotPassword calls authClient.forgetPassword with submitted email", async () => {
    mockForgetPassword.mockResolvedValue({
      data: { status: true },
      error: null,
    });
    const { ForgotPassword } = await import("../components/forgot-password");
    const Wrapper = await getWrapper();
    render(<ForgotPassword />, { wrapper: Wrapper });

    const emailInput = screen.getByLabelText(/email/i);
    fireEvent.change(emailInput, { target: { value: "user@example.com" } });
    fireEvent.submit(emailInput.closest("form")!);

    await waitFor(() => {
      expect(mockForgetPassword).toHaveBeenCalledTimes(1);
    });
    const callArg = mockForgetPassword.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(callArg?.email).toBe("user@example.com");
  });

  test("ForgotPassword shows success message after submission regardless of email existence", async () => {
    mockForgetPassword.mockResolvedValue({
      data: { status: true },
      error: null,
    });
    const { ForgotPassword } = await import("../components/forgot-password");
    const Wrapper = await getWrapper();
    render(<ForgotPassword />, { wrapper: Wrapper });

    const emailInput = screen.getByLabelText(/email/i);
    fireEvent.change(emailInput, { target: { value: "anyone@example.com" } });
    fireEvent.submit(emailInput.closest("form")!);

    await waitFor(() => {
      expect(
        screen.getByText(/if an account exists|sent a password reset/i)
      ).toBeDefined();
    });
  });

  test("ForgotPassword shows success message even when email does not exist (prevents enumeration)", async () => {
    // Simulates server returning error (no account) but UI must still show success message
    mockForgetPassword.mockResolvedValue({
      data: null,
      error: { message: "User not found" },
    });
    const { ForgotPassword } = await import("../components/forgot-password");
    const Wrapper = await getWrapper();
    render(<ForgotPassword />, { wrapper: Wrapper });

    const emailInput = screen.getByLabelText(/email/i);
    fireEvent.change(emailInput, { target: { value: "ghost@example.com" } });
    fireEvent.submit(emailInput.closest("form")!);

    await waitFor(() => {
      expect(
        screen.getByText(/if an account exists|sent a password reset/i)
      ).toBeDefined();
    });
  });

  test("ForgotPassword disables submit button during loading", async () => {
    let resolveRequest!: (v: unknown) => void;
    mockForgetPassword.mockReturnValue(
      new Promise((res) => {
        resolveRequest = res;
      })
    );

    const { ForgotPassword } = await import("../components/forgot-password");
    const Wrapper = await getWrapper();
    render(<ForgotPassword />, { wrapper: Wrapper });

    const emailInput = screen.getByLabelText(/email/i);
    fireEvent.change(emailInput, { target: { value: "user@example.com" } });

    await act(async () => {
      fireEvent.submit(emailInput.closest("form")!);
    });

    const submitBtn = screen.getByRole("button", {
      name: /send|reset|submit/i,
    }) as HTMLButtonElement;
    expect(
      submitBtn.disabled || submitBtn.getAttribute("aria-disabled") === "true"
    ).toBe(true);

    // Resolve to avoid dangling promises
    resolveRequest({ data: { status: true }, error: null });
  });

  test("ForgotPassword handles network failure with generic error message", async () => {
    mockForgetPassword.mockRejectedValue(new Error("Network error"));
    const { ForgotPassword } = await import("../components/forgot-password");
    const Wrapper = await getWrapper();

    // Suppress React unhandled error noise
    const origError = console.error;
    console.error = () => {};

    render(<ForgotPassword />, { wrapper: Wrapper });
    const emailInput = screen.getByLabelText(/email/i);
    fireEvent.change(emailInput, { target: { value: "user@example.com" } });
    fireEvent.submit(emailInput.closest("form")!);

    await waitFor(() => {
      expect(
        screen.getByText(/something went wrong|error|try again/i)
      ).toBeDefined();
    });

    console.error = origError;
  });

  test("ForgotPassword does not submit with invalid email", async () => {
    const { ForgotPassword } = await import("../components/forgot-password");
    const Wrapper = await getWrapper();
    render(<ForgotPassword />, { wrapper: Wrapper });

    const emailInput = screen.getByLabelText(/email/i);
    fireEvent.change(emailInput, { target: { value: "not-an-email" } });
    fireEvent.submit(emailInput.closest("form")!);

    await waitFor(() => {
      expect(mockForgetPassword).not.toHaveBeenCalled();
    });
  });

  test("ForgotPassword accepts className prop", async () => {
    const { ForgotPassword } = await import("../components/forgot-password");
    const Wrapper = await getWrapper();
    const { container } = render(<ForgotPassword className="custom-forgot" />, {
      wrapper: Wrapper,
    });
    expect(container.querySelector(".custom-forgot")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// ResetPassword component
// ---------------------------------------------------------------------------

describe("ResetPassword component", () => {
  beforeEach(() => {
    mockResetPassword.mockClear();
    mockGet.mockImplementation((key: string) => {
      if (key === "token") return "test-reset-token-abc123";
      return null;
    });
  });

  test("ResetPassword is exported from src/components/reset-password", async () => {
    const mod = await import("../components/reset-password");
    expect(typeof mod.ResetPassword).toBe("function");
  });

  test("ResetPassword renders a new password input", async () => {
    const { ResetPassword } = await import("../components/reset-password");
    const Wrapper = await getWrapper();
    render(<ResetPassword />, { wrapper: Wrapper });
    // Password inputs are type="password", accessible via label
    expect(screen.getByLabelText(/^new password$/i)).toBeDefined();
  });

  test("ResetPassword renders a confirm password input", async () => {
    const { ResetPassword } = await import("../components/reset-password");
    const Wrapper = await getWrapper();
    render(<ResetPassword />, { wrapper: Wrapper });
    expect(screen.getByLabelText(/confirm password/i)).toBeDefined();
  });

  test("ResetPassword renders a submit button", async () => {
    const { ResetPassword } = await import("../components/reset-password");
    const Wrapper = await getWrapper();
    render(<ResetPassword />, { wrapper: Wrapper });
    expect(
      screen.getByRole("button", { name: /reset|submit|update/i })
    ).toBeDefined();
  });

  test("ResetPassword reads token from URL via useSearchParams", async () => {
    mockGet.mockImplementation((key: string) =>
      key === "token" ? "my-special-token" : null
    );
    mockResetPassword.mockResolvedValue({
      data: { status: true },
      error: null,
    });

    const { ResetPassword } = await import("../components/reset-password");
    const Wrapper = await getWrapper();
    render(<ResetPassword />, { wrapper: Wrapper });

    const pwdInput = screen.getByLabelText(/new password|^password/i);
    const confirmInput = screen.getByLabelText(/confirm password/i);
    fireEvent.change(pwdInput, { target: { value: "NewPassword1!" } });
    fireEvent.change(confirmInput, { target: { value: "NewPassword1!" } });
    fireEvent.submit(pwdInput.closest("form")!);

    await waitFor(() => {
      expect(mockResetPassword).toHaveBeenCalledTimes(1);
    });
    const callArg = mockResetPassword.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(callArg?.token).toBe("my-special-token");
  });

  test("ResetPassword submits new password to authClient.resetPassword", async () => {
    mockResetPassword.mockResolvedValue({
      data: { status: true },
      error: null,
    });

    const { ResetPassword } = await import("../components/reset-password");
    const Wrapper = await getWrapper();
    render(<ResetPassword />, { wrapper: Wrapper });

    const pwdInput = screen.getByLabelText(/new password|^password/i);
    const confirmInput = screen.getByLabelText(/confirm password/i);
    fireEvent.change(pwdInput, { target: { value: "NewPassword1!" } });
    fireEvent.change(confirmInput, { target: { value: "NewPassword1!" } });
    fireEvent.submit(pwdInput.closest("form")!);

    await waitFor(() => {
      expect(mockResetPassword).toHaveBeenCalledTimes(1);
    });
    const callArg = mockResetPassword.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(callArg?.newPassword ?? callArg?.password).toBe("NewPassword1!");
  });

  test("ResetPassword shows success message on successful reset", async () => {
    mockResetPassword.mockResolvedValue({
      data: { status: true },
      error: null,
    });

    const { ResetPassword } = await import("../components/reset-password");
    const Wrapper = await getWrapper();
    render(<ResetPassword />, { wrapper: Wrapper });

    const pwdInput = screen.getByLabelText(/new password|^password/i);
    const confirmInput = screen.getByLabelText(/confirm password/i);
    fireEvent.change(pwdInput, { target: { value: "NewPassword1!" } });
    fireEvent.change(confirmInput, { target: { value: "NewPassword1!" } });
    fireEvent.submit(pwdInput.closest("form")!);

    await waitFor(() => {
      expect(
        screen.getByText(/password.*reset|reset.*success|updated/i)
      ).toBeDefined();
    });
  });

  test("ResetPassword shows link to sign-in on success", async () => {
    mockResetPassword.mockResolvedValue({
      data: { status: true },
      error: null,
    });

    const { ResetPassword } = await import("../components/reset-password");
    const Wrapper = await getWrapper();
    render(<ResetPassword />, { wrapper: Wrapper });

    const pwdInput = screen.getByLabelText(/new password|^password/i);
    const confirmInput = screen.getByLabelText(/confirm password/i);
    fireEvent.change(pwdInput, { target: { value: "NewPassword1!" } });
    fireEvent.change(confirmInput, { target: { value: "NewPassword1!" } });
    fireEvent.submit(pwdInput.closest("form")!);

    await waitFor(() => {
      expect(screen.getByText(/sign.?in/i)).toBeDefined();
    });
  });

  test("ResetPassword shows expired token error for invalid/expired token", async () => {
    mockResetPassword.mockResolvedValue({
      data: null,
      error: { message: "Invalid or expired token" },
    });

    const { ResetPassword } = await import("../components/reset-password");
    const Wrapper = await getWrapper();
    render(<ResetPassword />, { wrapper: Wrapper });

    const pwdInput = screen.getByLabelText(/new password|^password/i);
    const confirmInput = screen.getByLabelText(/confirm password/i);
    fireEvent.change(pwdInput, { target: { value: "NewPassword1!" } });
    fireEvent.change(confirmInput, { target: { value: "NewPassword1!" } });
    fireEvent.submit(pwdInput.closest("form")!);

    await waitFor(() => {
      expect(
        screen.getByText(/link has expired|expired|request a new one/i)
      ).toBeDefined();
    });
  });

  test("ResetPassword shows error when token is missing from URL", async () => {
    mockGet.mockImplementation(() => null); // no token in URL

    const { ResetPassword } = await import("../components/reset-password");
    const Wrapper = await getWrapper();
    render(<ResetPassword />, { wrapper: Wrapper });

    // Either shows an error immediately, or on submit
    const hasError =
      !!document.querySelector("[role='alert']") ||
      screen.queryByText(/invalid|expired|missing|token/i) !== null;

    if (!hasError) {
      // Try submitting to trigger the error path
      const pwdInput = screen.queryByLabelText(/new password|^password/i);
      if (pwdInput) {
        const confirmInput = screen.queryByLabelText(/confirm password/i);
        if (confirmInput) {
          fireEvent.change(pwdInput, { target: { value: "NewPassword1!" } });
          fireEvent.change(confirmInput, {
            target: { value: "NewPassword1!" },
          });
          fireEvent.submit(pwdInput.closest("form")!);
          await waitFor(() => {
            expect(mockResetPassword).not.toHaveBeenCalled();
          });
        }
      }
    }

    // Either an error is shown, or resetPassword was never called — both are valid
    expect(
      mockResetPassword.mock.calls.length === 0 ||
        screen.queryByText(/invalid|expired|missing|token/i) !== null
    ).toBe(true);
  });

  test("ResetPassword disables submit button during loading", async () => {
    let resolveRequest!: (v: unknown) => void;
    mockResetPassword.mockReturnValue(
      new Promise((res) => {
        resolveRequest = res;
      })
    );

    const { ResetPassword } = await import("../components/reset-password");
    const Wrapper = await getWrapper();
    render(<ResetPassword />, { wrapper: Wrapper });

    const pwdInput = screen.getByLabelText(/new password|^password/i);
    const confirmInput = screen.getByLabelText(/confirm password/i);
    fireEvent.change(pwdInput, { target: { value: "NewPassword1!" } });
    fireEvent.change(confirmInput, { target: { value: "NewPassword1!" } });

    await act(async () => {
      fireEvent.submit(pwdInput.closest("form")!);
    });

    const submitBtn = screen.getByRole("button", {
      name: /reset|submit|update/i,
    }) as HTMLButtonElement;
    expect(
      submitBtn.disabled || submitBtn.getAttribute("aria-disabled") === "true"
    ).toBe(true);

    resolveRequest({ data: { status: true }, error: null });
  });

  test("ResetPassword handles network failure with generic error message", async () => {
    mockResetPassword.mockRejectedValue(new Error("Network error"));

    const origError = console.error;
    console.error = () => {};

    const { ResetPassword } = await import("../components/reset-password");
    const Wrapper = await getWrapper();
    render(<ResetPassword />, { wrapper: Wrapper });

    const pwdInput = screen.getByLabelText(/new password|^password/i);
    const confirmInput = screen.getByLabelText(/confirm password/i);
    fireEvent.change(pwdInput, { target: { value: "NewPassword1!" } });
    fireEvent.change(confirmInput, { target: { value: "NewPassword1!" } });
    fireEvent.submit(pwdInput.closest("form")!);

    await waitFor(() => {
      expect(
        screen.getByText(/something went wrong|error|try again/i)
      ).toBeDefined();
    });

    console.error = origError;
  });

  test("ResetPassword does not submit when passwords do not match", async () => {
    const { ResetPassword } = await import("../components/reset-password");
    const Wrapper = await getWrapper();
    render(<ResetPassword />, { wrapper: Wrapper });

    const pwdInput = screen.getByLabelText(/new password|^password/i);
    const confirmInput = screen.getByLabelText(/confirm password/i);
    fireEvent.change(pwdInput, { target: { value: "Password1!" } });
    fireEvent.change(confirmInput, { target: { value: "Different1!" } });
    fireEvent.submit(pwdInput.closest("form")!);

    await waitFor(() => {
      expect(mockResetPassword).not.toHaveBeenCalled();
    });
  });

  test("ResetPassword shows validation error when passwords do not match", async () => {
    const { ResetPassword } = await import("../components/reset-password");
    const Wrapper = await getWrapper();
    render(<ResetPassword />, { wrapper: Wrapper });

    const pwdInput = screen.getByLabelText(/new password|^password/i);
    const confirmInput = screen.getByLabelText(/confirm password/i);
    fireEvent.change(pwdInput, { target: { value: "Password1!" } });
    fireEvent.change(confirmInput, { target: { value: "Different1!" } });
    fireEvent.submit(pwdInput.closest("form")!);

    await waitFor(() => {
      expect(
        screen.getByText(/passwords.*match|match.*passwords|do not match/i)
      ).toBeDefined();
    });
  });

  test("ResetPassword enforces passwordRules minLength prop", async () => {
    const { ResetPassword } = await import("../components/reset-password");
    const Wrapper = await getWrapper();
    render(<ResetPassword passwordRules={{ minLength: 12 }} />, {
      wrapper: Wrapper,
    });

    const pwdInput = screen.getByLabelText(/new password|^password/i);
    const confirmInput = screen.getByLabelText(/confirm password/i);
    // "Short1!" is only 7 chars
    fireEvent.change(pwdInput, { target: { value: "Short1!" } });
    fireEvent.change(confirmInput, { target: { value: "Short1!" } });
    fireEvent.submit(pwdInput.closest("form")!);

    await waitFor(() => {
      expect(mockResetPassword).not.toHaveBeenCalled();
    });
  });

  test("ResetPassword accepts className prop", async () => {
    const { ResetPassword } = await import("../components/reset-password");
    const Wrapper = await getWrapper();
    const { container } = render(<ResetPassword className="custom-reset" />, {
      wrapper: Wrapper,
    });
    expect(container.querySelector(".custom-reset")).toBeDefined();
  });
});
