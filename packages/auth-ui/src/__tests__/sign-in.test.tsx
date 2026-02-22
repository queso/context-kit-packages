import { beforeEach, describe, expect, mock, test } from "bun:test";
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
// signIn and signUp are namespaced objects in Better Auth:
//   authClient.signIn.email({ email, password, callbackURL })
//   authClient.signIn.social({ provider, callbackURL })
//   authClient.signUp.email({ name, email, password, callbackURL })
// ---------------------------------------------------------------------------

const mockSignInEmail = mock(() =>
  Promise.resolve({ data: { user: { id: "u1" } }, error: null })
);
const mockSignInSocial = mock(() =>
  Promise.resolve({ data: { url: "https://accounts.google.com" }, error: null })
);
const mockSignUpEmail = mock(() =>
  Promise.resolve({ data: { user: { id: "u1" } }, error: null })
);
const mockUseSession = mock(() => ({
  data: null,
  isPending: false,
  error: null,
}));
const mockSignOut = mock(() => Promise.resolve({ data: null, error: null }));

const mockAuthClient = {
  signIn: {
    email: mockSignInEmail,
    social: mockSignInSocial,
  },
  signUp: {
    email: mockSignUpEmail,
  },
  signOut: mockSignOut,
  useSession: mockUseSession,
  forgetPassword: mock(() =>
    Promise.resolve({ data: { status: true }, error: null })
  ),
  resetPassword: mock(() =>
    Promise.resolve({ data: { status: true }, error: null })
  ),
};

const mockCreateAuthClient = mock(() => mockAuthClient);

mock.module("@context-kit/auth/client", () => ({
  createAuthClient: mockCreateAuthClient,
}));

// ---------------------------------------------------------------------------
// Mock next/navigation
// ---------------------------------------------------------------------------

const mockPush = mock((_url: string) => {});
const mockReplace = mock((_url: string) => {});
const mockUseRouter = mock(() => ({
  push: mockPush,
  replace: mockReplace,
  back: mock(() => {}),
}));
const mockUseSearchParams = mock(() => ({ get: mock(() => null) }));

mock.module("next/navigation", () => ({
  useRouter: mockUseRouter,
  useSearchParams: mockUseSearchParams,
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
// Helpers
// ---------------------------------------------------------------------------

function fillSignIn(email: string, password: string) {
  const emailInput = screen.getByLabelText(/email/i);
  const passwordInput = screen.getByLabelText(/password/i);
  fireEvent.change(emailInput, { target: { value: email } });
  fireEvent.change(passwordInput, { target: { value: password } });
  return { emailInput, passwordInput };
}

function fillSignUp(
  name: string,
  email: string,
  password: string,
  confirm: string
) {
  const nameInput = screen.getByLabelText(/name/i);
  const emailInput = screen.getByLabelText(/email/i);
  const passwordInput = screen.getByLabelText(/^password/i);
  const confirmInput = screen.getByLabelText(/confirm password/i);
  fireEvent.change(nameInput, { target: { value: name } });
  fireEvent.change(emailInput, { target: { value: email } });
  fireEvent.change(passwordInput, { target: { value: password } });
  fireEvent.change(confirmInput, { target: { value: confirm } });
  return { nameInput, emailInput, passwordInput, confirmInput };
}

// ---------------------------------------------------------------------------
// File existence
// ---------------------------------------------------------------------------

describe("file structure", () => {
  test("src/components/sign-in.tsx exists", () => {
    expect(fileExists("src/components/sign-in.tsx")).toBe(true);
  });

  test("src/components/sign-up.tsx exists", () => {
    expect(fileExists("src/components/sign-up.tsx")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// signInSchema
// ---------------------------------------------------------------------------

describe("signInSchema", () => {
  test("signInSchema is exported from src/lib/schemas", async () => {
    const mod = await import("../lib/schemas");
    expect(mod.signInSchema).toBeDefined();
  });

  test("signInSchema accepts a valid email and non-empty password", async () => {
    const { signInSchema } = await import("../lib/schemas");
    const result = signInSchema.safeParse({
      email: "user@example.com",
      password: "secret123",
    });
    expect(result.success).toBe(true);
  });

  test("signInSchema rejects an invalid email", async () => {
    const { signInSchema } = await import("../lib/schemas");
    const result = signInSchema.safeParse({
      email: "not-an-email",
      password: "secret123",
    });
    expect(result.success).toBe(false);
  });

  test("signInSchema rejects an empty password", async () => {
    const { signInSchema } = await import("../lib/schemas");
    const result = signInSchema.safeParse({
      email: "user@example.com",
      password: "",
    });
    expect(result.success).toBe(false);
  });

  test("signInSchema rejects missing fields", async () => {
    const { signInSchema } = await import("../lib/schemas");
    expect(signInSchema.safeParse({}).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// signUpSchema
// ---------------------------------------------------------------------------

describe("signUpSchema", () => {
  test("signUpSchema is exported from src/lib/schemas", async () => {
    const mod = await import("../lib/schemas");
    expect(mod.signUpSchema).toBeDefined();
  });

  function getSchema(rules: Record<string, unknown> = {}) {
    // Handles both factory and plain object patterns
    return import("../lib/schemas").then(({ signUpSchema }) =>
      typeof signUpSchema === "function" ? signUpSchema(rules) : signUpSchema
    );
  }

  test("signUpSchema accepts valid data with matching passwords", async () => {
    const schema = await getSchema();
    const result = schema.safeParse({
      name: "Alice",
      email: "alice@example.com",
      password: "Password1!",
      confirmPassword: "Password1!",
    });
    expect(result.success).toBe(true);
  });

  test("signUpSchema rejects mismatched passwords", async () => {
    const schema = await getSchema();
    const result = schema.safeParse({
      name: "Alice",
      email: "alice@example.com",
      password: "Password1!",
      confirmPassword: "Different1!",
    });
    expect(result.success).toBe(false);
  });

  test("signUpSchema rejects password shorter than default minLength (8)", async () => {
    const schema = await getSchema();
    const result = schema.safeParse({
      name: "Alice",
      email: "alice@example.com",
      password: "Pass1!",
      confirmPassword: "Pass1!",
    });
    expect(result.success).toBe(false);
  });

  test("signUpSchema accepts custom minLength via factory", async () => {
    const schema = await getSchema({ minLength: 12 });
    const long = "LongPassword1!";
    const result = schema.safeParse({
      name: "Alice",
      email: "alice@example.com",
      password: long,
      confirmPassword: long,
    });
    expect(result.success).toBe(true);
  });

  test("signUpSchema rejects password below custom minLength", async () => {
    const schema = await getSchema({ minLength: 12 });
    const result = schema.safeParse({
      name: "Alice",
      email: "alice@example.com",
      password: "Short1!",
      confirmPassword: "Short1!",
    });
    expect(result.success).toBe(false);
  });

  test("signUpSchema rejects empty name", async () => {
    const schema = await getSchema();
    const result = schema.safeParse({
      name: "",
      email: "alice@example.com",
      password: "Password1!",
      confirmPassword: "Password1!",
    });
    expect(result.success).toBe(false);
  });

  test("signUpSchema rejects invalid email", async () => {
    const schema = await getSchema();
    const result = schema.safeParse({
      name: "Alice",
      email: "not-an-email",
      password: "Password1!",
      confirmPassword: "Password1!",
    });
    expect(result.success).toBe(false);
  });

  test("signUpSchema rejects password above default maxLength (128)", async () => {
    const schema = await getSchema();
    const tooLong = "A".repeat(129) + "1!";
    const result = schema.safeParse({
      name: "Alice",
      email: "alice@example.com",
      password: tooLong,
      confirmPassword: tooLong,
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SignIn component
// ---------------------------------------------------------------------------

describe("SignIn export", () => {
  test("SignIn is exported from src/components/sign-in", async () => {
    const mod = await import("../components/sign-in");
    expect(typeof mod.SignIn).toBe("function");
  });
});

describe("SignIn rendering", () => {
  test("renders email input", async () => {
    const { SignIn } = await import("../components/sign-in");
    const Wrapper = await getWrapper();
    render(<SignIn />, { wrapper: Wrapper });
    expect(screen.getByLabelText(/email/i)).toBeDefined();
  });

  test("renders password input", async () => {
    const { SignIn } = await import("../components/sign-in");
    const Wrapper = await getWrapper();
    render(<SignIn />, { wrapper: Wrapper });
    expect(screen.getByLabelText(/password/i)).toBeDefined();
  });

  test("renders a submit button", async () => {
    const { SignIn } = await import("../components/sign-in");
    const Wrapper = await getWrapper();
    render(<SignIn />, { wrapper: Wrapper });
    expect(
      screen.getByRole("button", { name: /sign.?in|log.?in|submit/i })
    ).toBeDefined();
  });

  test("password input type is password (not visible text)", async () => {
    const { SignIn } = await import("../components/sign-in");
    const Wrapper = await getWrapper();
    render(<SignIn />, { wrapper: Wrapper });
    const pwdInput = screen.getByLabelText(/password/i) as HTMLInputElement;
    expect(pwdInput.type).toBe("password");
  });

  test("renders 'Don't have an account? Sign up' link", async () => {
    const { SignIn } = await import("../components/sign-in");
    const Wrapper = await getWrapper();
    render(<SignIn />, { wrapper: Wrapper });
    expect(screen.getByText(/don.?t have an account|sign.?up/i)).toBeDefined();
  });

  test("renders 'Forgot your password?' link", async () => {
    const { SignIn } = await import("../components/sign-in");
    const Wrapper = await getWrapper();
    render(<SignIn />, { wrapper: Wrapper });
    expect(screen.getByText(/forgot.*password/i)).toBeDefined();
  });

  test("does not render social section when providers not passed", async () => {
    const { SignIn } = await import("../components/sign-in");
    const Wrapper = await getWrapper();
    const { container } = render(<SignIn />, { wrapper: Wrapper });
    // No "or" divider and no social button elements
    expect(screen.queryByText(/^or$/i)).toBeNull();
  });

  test("renders SocialButton for each provider when providers prop is given", async () => {
    const { SignIn } = await import("../components/sign-in");
    const Wrapper = await getWrapper();
    render(<SignIn providers={["google", "github"]} />, { wrapper: Wrapper });
    expect(screen.getByText(/continue with google/i)).toBeDefined();
    expect(screen.getByText(/continue with github/i)).toBeDefined();
  });

  test("renders 'or' divider between form and social buttons", async () => {
    const { SignIn } = await import("../components/sign-in");
    const Wrapper = await getWrapper();
    render(<SignIn providers={["google"]} />, { wrapper: Wrapper });
    expect(screen.getByText(/^or$/i)).toBeDefined();
  });
});

describe("SignIn form submission", () => {
  beforeEach(() => {
    mockSignInEmail.mockClear();
    mockSignInSocial.mockClear();
    mockPush.mockClear();
    mockSignInEmail.mockResolvedValue({
      data: { user: { id: "u1" } },
      error: null,
    });
  });

  test("calls authClient.signIn.email() with email and password on submit", async () => {
    const { SignIn } = await import("../components/sign-in");
    const Wrapper = await getWrapper();
    render(<SignIn />, { wrapper: Wrapper });

    fillSignIn("user@example.com", "Password1!");
    fireEvent.submit(screen.getByLabelText(/email/i).closest("form")!);

    await waitFor(() => {
      expect(mockSignInEmail).toHaveBeenCalledTimes(1);
    });
    const arg = mockSignInEmail.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(arg?.email).toBe("user@example.com");
    expect(arg?.password).toBe("Password1!");
  });

  test("redirects to '/' by default on successful sign-in", async () => {
    const { SignIn } = await import("../components/sign-in");
    const Wrapper = await getWrapper();
    render(<SignIn />, { wrapper: Wrapper });

    fillSignIn("user@example.com", "Password1!");
    fireEvent.submit(screen.getByLabelText(/email/i).closest("form")!);

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledTimes(1);
    });
    const dest = mockPush.mock.calls[0]?.[0] as string | undefined;
    expect(dest).toBe("/");
  });

  test("redirects to custom callbackUrl on success", async () => {
    const { SignIn } = await import("../components/sign-in");
    const Wrapper = await getWrapper();
    render(<SignIn callbackUrl="/dashboard" />, { wrapper: Wrapper });

    fillSignIn("user@example.com", "Password1!");
    fireEvent.submit(screen.getByLabelText(/email/i).closest("form")!);

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledTimes(1);
    });
    const dest = mockPush.mock.calls[0]?.[0] as string | undefined;
    expect(dest).toBe("/dashboard");
  });

  test("callbackUrl is passed to signIn.email()", async () => {
    const { SignIn } = await import("../components/sign-in");
    const Wrapper = await getWrapper();
    render(<SignIn callbackUrl="/home" />, { wrapper: Wrapper });

    fillSignIn("user@example.com", "Password1!");
    fireEvent.submit(screen.getByLabelText(/email/i).closest("form")!);

    await waitFor(() => {
      expect(mockSignInEmail).toHaveBeenCalledTimes(1);
    });
    const arg = mockSignInEmail.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(arg?.callbackURL ?? arg?.callbackUrl).toBe("/home");
  });

  test("shows inline error on invalid credentials (API returns error)", async () => {
    mockSignInEmail.mockResolvedValue({
      data: null,
      error: { message: "Invalid email or password" },
    });
    const { SignIn } = await import("../components/sign-in");
    const Wrapper = await getWrapper();
    render(<SignIn />, { wrapper: Wrapper });

    fillSignIn("user@example.com", "WrongPassword!");
    fireEvent.submit(screen.getByLabelText(/email/i).closest("form")!);

    await waitFor(() => {
      expect(
        screen.getByText(
          /invalid.*credentials|invalid.*email.*password|incorrect/i
        )
      ).toBeDefined();
    });
  });

  test("shows inline error on network failure (rejected promise)", async () => {
    mockSignInEmail.mockRejectedValue(new Error("Network error"));
    const origError = console.error;
    console.error = () => {};

    const { SignIn } = await import("../components/sign-in");
    const Wrapper = await getWrapper();
    render(<SignIn />, { wrapper: Wrapper });

    fillSignIn("user@example.com", "Password1!");
    fireEvent.submit(screen.getByLabelText(/email/i).closest("form")!);

    await waitFor(() => {
      expect(
        screen.getByText(/something went wrong|error|try again/i)
      ).toBeDefined();
    });
    console.error = origError;
    mockSignInEmail.mockResolvedValue({
      data: { user: { id: "u1" } },
      error: null,
    });
  });

  test("does not call signIn.email() when email is invalid", async () => {
    const { SignIn } = await import("../components/sign-in");
    const Wrapper = await getWrapper();
    render(<SignIn />, { wrapper: Wrapper });

    fillSignIn("not-an-email", "Password1!");
    fireEvent.submit(screen.getByLabelText(/email/i).closest("form")!);

    await waitFor(() => {
      expect(mockSignInEmail).not.toHaveBeenCalled();
    });
  });

  test("does not call signIn.email() when password is empty", async () => {
    const { SignIn } = await import("../components/sign-in");
    const Wrapper = await getWrapper();
    render(<SignIn />, { wrapper: Wrapper });

    fillSignIn("user@example.com", "");
    fireEvent.submit(screen.getByLabelText(/email/i).closest("form")!);

    await waitFor(() => {
      expect(mockSignInEmail).not.toHaveBeenCalled();
    });
  });

  test("disables submit button during loading", async () => {
    let resolve!: (v: unknown) => void;
    mockSignInEmail.mockReturnValue(
      new Promise((res) => {
        resolve = res;
      })
    );

    const { SignIn } = await import("../components/sign-in");
    const Wrapper = await getWrapper();
    render(<SignIn />, { wrapper: Wrapper });

    fillSignIn("user@example.com", "Password1!");
    await act(async () => {
      fireEvent.submit(screen.getByLabelText(/email/i).closest("form")!);
    });

    const btn = screen.getByRole("button", {
      name: /sign.?in|log.?in|submit/i,
    }) as HTMLButtonElement;
    expect(btn.disabled || btn.getAttribute("aria-disabled") === "true").toBe(
      true
    );

    resolve({ data: { user: { id: "u1" } }, error: null });
    mockSignInEmail.mockResolvedValue({
      data: { user: { id: "u1" } },
      error: null,
    });
  });
});

describe("SignIn social providers", () => {
  beforeEach(() => {
    mockSignInSocial.mockClear();
    mockSignInSocial.mockResolvedValue({
      data: { url: "https://accounts.google.com" },
      error: null,
    });
  });

  test("clicking a social button calls authClient.signIn.social() with provider", async () => {
    const { SignIn } = await import("../components/sign-in");
    const Wrapper = await getWrapper();
    render(<SignIn providers={["google"]} />, { wrapper: Wrapper });

    fireEvent.click(
      screen.getByText(/continue with google/i).closest("button")!
    );

    await waitFor(() => {
      expect(mockSignInSocial).toHaveBeenCalledTimes(1);
    });
    const arg = mockSignInSocial.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(arg?.provider).toBe("google");
  });

  test("social button passes callbackUrl to signIn.social()", async () => {
    const { SignIn } = await import("../components/sign-in");
    const Wrapper = await getWrapper();
    render(<SignIn providers={["github"]} callbackUrl="/dashboard" />, {
      wrapper: Wrapper,
    });

    fireEvent.click(
      screen.getByText(/continue with github/i).closest("button")!
    );

    await waitFor(() => {
      expect(mockSignInSocial).toHaveBeenCalledTimes(1);
    });
    const arg = mockSignInSocial.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(arg?.callbackURL ?? arg?.callbackUrl).toBe("/dashboard");
  });

  test("multiple providers each render a SocialButton", async () => {
    const { SignIn } = await import("../components/sign-in");
    const Wrapper = await getWrapper();
    render(<SignIn providers={["google", "github", "discord"]} />, {
      wrapper: Wrapper,
    });
    expect(screen.getByText(/continue with google/i)).toBeDefined();
    expect(screen.getByText(/continue with github/i)).toBeDefined();
    expect(screen.getByText(/continue with discord/i)).toBeDefined();
  });

  test("clicking each social button calls signIn.social() with correct provider", async () => {
    const { SignIn } = await import("../components/sign-in");
    const Wrapper = await getWrapper();
    render(<SignIn providers={["google", "github"]} />, { wrapper: Wrapper });

    fireEvent.click(
      screen.getByText(/continue with github/i).closest("button")!
    );

    await waitFor(() => {
      expect(mockSignInSocial).toHaveBeenCalledTimes(1);
    });
    const arg = mockSignInSocial.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(arg?.provider).toBe("github");
  });
});

describe("SignIn className and classNames props", () => {
  test("accepts className prop", async () => {
    const { SignIn } = await import("../components/sign-in");
    const Wrapper = await getWrapper();
    const { container } = render(<SignIn className="custom-sign-in" />, {
      wrapper: Wrapper,
    });
    expect(container.querySelector(".custom-sign-in")).toBeDefined();
  });

  test("accepts classNames.submitButton override", async () => {
    const { SignIn } = await import("../components/sign-in");
    const Wrapper = await getWrapper();
    render(<SignIn classNames={{ submitButton: "custom-submit" }} />, {
      wrapper: Wrapper,
    });
    const btn = screen.getByRole("button", {
      name: /sign.?in|log.?in|submit/i,
    });
    expect(btn.className).toContain("custom-submit");
  });
});

// ---------------------------------------------------------------------------
// SignUp component
// ---------------------------------------------------------------------------

describe("SignUp export", () => {
  test("SignUp is exported from src/components/sign-up", async () => {
    const mod = await import("../components/sign-up");
    expect(typeof mod.SignUp).toBe("function");
  });
});

describe("SignUp rendering", () => {
  test("renders name input", async () => {
    const { SignUp } = await import("../components/sign-up");
    const Wrapper = await getWrapper();
    render(<SignUp />, { wrapper: Wrapper });
    expect(screen.getByLabelText(/name/i)).toBeDefined();
  });

  test("renders email input", async () => {
    const { SignUp } = await import("../components/sign-up");
    const Wrapper = await getWrapper();
    render(<SignUp />, { wrapper: Wrapper });
    expect(screen.getByLabelText(/email/i)).toBeDefined();
  });

  test("renders password input", async () => {
    const { SignUp } = await import("../components/sign-up");
    const Wrapper = await getWrapper();
    render(<SignUp />, { wrapper: Wrapper });
    expect(screen.getByLabelText(/^password/i)).toBeDefined();
  });

  test("renders confirm password input", async () => {
    const { SignUp } = await import("../components/sign-up");
    const Wrapper = await getWrapper();
    render(<SignUp />, { wrapper: Wrapper });
    expect(screen.getByLabelText(/confirm password/i)).toBeDefined();
  });

  test("password and confirm inputs have type='password'", async () => {
    const { SignUp } = await import("../components/sign-up");
    const Wrapper = await getWrapper();
    render(<SignUp />, { wrapper: Wrapper });
    const pwdInput = screen.getByLabelText(/^password/i) as HTMLInputElement;
    const confirmInput = screen.getByLabelText(
      /confirm password/i
    ) as HTMLInputElement;
    expect(pwdInput.type).toBe("password");
    expect(confirmInput.type).toBe("password");
  });

  test("renders a submit button", async () => {
    const { SignUp } = await import("../components/sign-up");
    const Wrapper = await getWrapper();
    render(<SignUp />, { wrapper: Wrapper });
    expect(
      screen.getByRole("button", { name: /sign.?up|create.*account|register/i })
    ).toBeDefined();
  });

  test("renders 'Already have an account? Sign in' link", async () => {
    const { SignUp } = await import("../components/sign-up");
    const Wrapper = await getWrapper();
    render(<SignUp />, { wrapper: Wrapper });
    expect(screen.getByText(/already have an account|sign.?in/i)).toBeDefined();
  });

  test("does not render social section when providers not passed", async () => {
    const { SignUp } = await import("../components/sign-up");
    const Wrapper = await getWrapper();
    render(<SignUp />, { wrapper: Wrapper });
    expect(screen.queryByText(/^or$/i)).toBeNull();
  });

  test("renders SocialButton for each provider when providers prop is given", async () => {
    const { SignUp } = await import("../components/sign-up");
    const Wrapper = await getWrapper();
    render(<SignUp providers={["google", "github"]} />, { wrapper: Wrapper });
    expect(screen.getByText(/continue with google/i)).toBeDefined();
    expect(screen.getByText(/continue with github/i)).toBeDefined();
  });

  test("renders 'or' divider between form and social buttons", async () => {
    const { SignUp } = await import("../components/sign-up");
    const Wrapper = await getWrapper();
    render(<SignUp providers={["google"]} />, { wrapper: Wrapper });
    expect(screen.getByText(/^or$/i)).toBeDefined();
  });
});

describe("SignUp form submission", () => {
  beforeEach(() => {
    mockSignUpEmail.mockClear();
    mockPush.mockClear();
    mockSignUpEmail.mockResolvedValue({
      data: { user: { id: "u1" } },
      error: null,
    });
  });

  test("calls authClient.signUp.email() with name, email, and password on submit", async () => {
    const { SignUp } = await import("../components/sign-up");
    const Wrapper = await getWrapper();
    render(<SignUp />, { wrapper: Wrapper });

    fillSignUp("Alice Smith", "alice@example.com", "Password1!", "Password1!");
    fireEvent.submit(screen.getByLabelText(/email/i).closest("form")!);

    await waitFor(() => {
      expect(mockSignUpEmail).toHaveBeenCalledTimes(1);
    });
    const arg = mockSignUpEmail.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(arg?.name).toBe("Alice Smith");
    expect(arg?.email).toBe("alice@example.com");
    expect(arg?.password).toBe("Password1!");
  });

  test("redirects to '/' by default on successful sign-up", async () => {
    const { SignUp } = await import("../components/sign-up");
    const Wrapper = await getWrapper();
    render(<SignUp />, { wrapper: Wrapper });

    fillSignUp("Alice", "alice@example.com", "Password1!", "Password1!");
    fireEvent.submit(screen.getByLabelText(/email/i).closest("form")!);

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledTimes(1);
    });
    const dest = mockPush.mock.calls[0]?.[0] as string | undefined;
    expect(dest).toBe("/");
  });

  test("redirects to custom callbackUrl on success", async () => {
    const { SignUp } = await import("../components/sign-up");
    const Wrapper = await getWrapper();
    render(<SignUp callbackUrl="/welcome" />, { wrapper: Wrapper });

    fillSignUp("Alice", "alice@example.com", "Password1!", "Password1!");
    fireEvent.submit(screen.getByLabelText(/email/i).closest("form")!);

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledTimes(1);
    });
    const dest = mockPush.mock.calls[0]?.[0] as string | undefined;
    expect(dest).toBe("/welcome");
  });

  test("shows inline error when email is already taken", async () => {
    mockSignUpEmail.mockResolvedValue({
      data: null,
      error: { message: "User already exists" },
    });
    const { SignUp } = await import("../components/sign-up");
    const Wrapper = await getWrapper();
    render(<SignUp />, { wrapper: Wrapper });

    fillSignUp("Alice", "taken@example.com", "Password1!", "Password1!");
    fireEvent.submit(screen.getByLabelText(/email/i).closest("form")!);

    await waitFor(() => {
      expect(
        screen.getByText(/already.*exists|already.*taken|email.*use|in use/i)
      ).toBeDefined();
    });
  });

  test("shows inline error on network failure", async () => {
    mockSignUpEmail.mockRejectedValue(new Error("Network error"));
    const origError = console.error;
    console.error = () => {};

    const { SignUp } = await import("../components/sign-up");
    const Wrapper = await getWrapper();
    render(<SignUp />, { wrapper: Wrapper });

    fillSignUp("Alice", "alice@example.com", "Password1!", "Password1!");
    fireEvent.submit(screen.getByLabelText(/email/i).closest("form")!);

    await waitFor(() => {
      expect(
        screen.getByText(/something went wrong|error|try again/i)
      ).toBeDefined();
    });
    console.error = origError;
    mockSignUpEmail.mockResolvedValue({
      data: { user: { id: "u1" } },
      error: null,
    });
  });

  test("does not call signUp.email() when passwords do not match", async () => {
    const { SignUp } = await import("../components/sign-up");
    const Wrapper = await getWrapper();
    render(<SignUp />, { wrapper: Wrapper });

    fillSignUp("Alice", "alice@example.com", "Password1!", "Different1!");
    fireEvent.submit(screen.getByLabelText(/email/i).closest("form")!);

    await waitFor(() => {
      expect(mockSignUpEmail).not.toHaveBeenCalled();
    });
  });

  test("shows validation error when passwords do not match", async () => {
    const { SignUp } = await import("../components/sign-up");
    const Wrapper = await getWrapper();
    render(<SignUp />, { wrapper: Wrapper });

    fillSignUp("Alice", "alice@example.com", "Password1!", "Different1!");
    fireEvent.submit(screen.getByLabelText(/email/i).closest("form")!);

    await waitFor(() => {
      expect(
        screen.getByText(/passwords.*match|do not match|match/i)
      ).toBeDefined();
    });
  });

  test("does not call signUp.email() when password is shorter than default minLength (8)", async () => {
    const { SignUp } = await import("../components/sign-up");
    const Wrapper = await getWrapper();
    render(<SignUp />, { wrapper: Wrapper });

    fillSignUp("Alice", "alice@example.com", "Pw1!", "Pw1!");
    fireEvent.submit(screen.getByLabelText(/email/i).closest("form")!);

    await waitFor(() => {
      expect(mockSignUpEmail).not.toHaveBeenCalled();
    });
  });

  test("passwordRules prop customizes minimum password length", async () => {
    const { SignUp } = await import("../components/sign-up");
    const Wrapper = await getWrapper();
    render(<SignUp passwordRules={{ minLength: 12 }} />, { wrapper: Wrapper });

    // "Password1!" is 10 chars — below new minLength of 12
    fillSignUp("Alice", "alice@example.com", "Password1!", "Password1!");
    fireEvent.submit(screen.getByLabelText(/email/i).closest("form")!);

    await waitFor(() => {
      expect(mockSignUpEmail).not.toHaveBeenCalled();
    });
  });

  test("passwordRules.minLength=12 accepts a long-enough password", async () => {
    const { SignUp } = await import("../components/sign-up");
    const Wrapper = await getWrapper();
    render(<SignUp passwordRules={{ minLength: 12 }} />, { wrapper: Wrapper });

    const longPwd = "LongPassword1!";
    fillSignUp("Alice", "alice@example.com", longPwd, longPwd);
    fireEvent.submit(screen.getByLabelText(/email/i).closest("form")!);

    await waitFor(() => {
      expect(mockSignUpEmail).toHaveBeenCalledTimes(1);
    });
  });

  test("does not call signUp.email() when name is empty", async () => {
    const { SignUp } = await import("../components/sign-up");
    const Wrapper = await getWrapper();
    render(<SignUp />, { wrapper: Wrapper });

    fillSignUp("", "alice@example.com", "Password1!", "Password1!");
    fireEvent.submit(screen.getByLabelText(/email/i).closest("form")!);

    await waitFor(() => {
      expect(mockSignUpEmail).not.toHaveBeenCalled();
    });
  });

  test("disables submit button during loading", async () => {
    let resolve!: (v: unknown) => void;
    mockSignUpEmail.mockReturnValue(
      new Promise((res) => {
        resolve = res;
      })
    );

    const { SignUp } = await import("../components/sign-up");
    const Wrapper = await getWrapper();
    render(<SignUp />, { wrapper: Wrapper });

    fillSignUp("Alice", "alice@example.com", "Password1!", "Password1!");
    await act(async () => {
      fireEvent.submit(screen.getByLabelText(/email/i).closest("form")!);
    });

    const btn = screen.getByRole("button", {
      name: /sign.?up|create.*account|register/i,
    }) as HTMLButtonElement;
    expect(btn.disabled || btn.getAttribute("aria-disabled") === "true").toBe(
      true
    );

    resolve({ data: { user: { id: "u1" } }, error: null });
    mockSignUpEmail.mockResolvedValue({
      data: { user: { id: "u1" } },
      error: null,
    });
  });
});

describe("SignUp social providers", () => {
  beforeEach(() => {
    mockSignInSocial.mockClear();
    mockSignInSocial.mockResolvedValue({
      data: { url: "https://accounts.google.com" },
      error: null,
    });
  });

  test("clicking a social button calls authClient.signIn.social() with provider", async () => {
    const { SignUp } = await import("../components/sign-up");
    const Wrapper = await getWrapper();
    render(<SignUp providers={["google"]} />, { wrapper: Wrapper });

    fireEvent.click(
      screen.getByText(/continue with google/i).closest("button")!
    );

    await waitFor(() => {
      expect(mockSignInSocial).toHaveBeenCalledTimes(1);
    });
    const arg = mockSignInSocial.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(arg?.provider).toBe("google");
  });
});

describe("SignUp className and classNames props", () => {
  test("accepts className prop", async () => {
    const { SignUp } = await import("../components/sign-up");
    const Wrapper = await getWrapper();
    const { container } = render(<SignUp className="custom-sign-up" />, {
      wrapper: Wrapper,
    });
    expect(container.querySelector(".custom-sign-up")).toBeDefined();
  });

  test("accepts classNames.submitButton override", async () => {
    const { SignUp } = await import("../components/sign-up");
    const Wrapper = await getWrapper();
    render(<SignUp classNames={{ submitButton: "custom-submit" }} />, {
      wrapper: Wrapper,
    });
    const btn = screen.getByRole("button", {
      name: /sign.?up|create.*account|register/i,
    });
    expect(btn.className).toContain("custom-submit");
  });
});
