import { describe, test, expect, mock, beforeEach } from "bun:test";
import { render, screen, renderHook, act } from "@testing-library/react";
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

const mockSignIn = mock(() => Promise.resolve({ data: null, error: null }));
const mockSignOut = mock(() => Promise.resolve({ data: null, error: null }));
const mockSignUp = mock(() => Promise.resolve({ data: null, error: null }));

const mockAuthClient = {
  useSession: mockUseSession,
  signIn: mockSignIn,
  signOut: mockSignOut,
  signUp: mockSignUp,
};

const mockCreateAuthClient = mock((_opts: { baseURL: string }) => mockAuthClient);

mock.module("@context-kit/auth/client", () => ({
  createAuthClient: mockCreateAuthClient,
}));

// ---------------------------------------------------------------------------
// File existence
// ---------------------------------------------------------------------------

describe("file structure", () => {
  test("src/components/auth-provider.tsx exists", () => {
    expect(fileExists("src/components/auth-provider.tsx")).toBe(true);
  });

  test("src/hooks/use-auth.ts exists", () => {
    expect(fileExists("src/hooks/use-auth.ts")).toBe(true);
  });

  test("src/hooks/use-session.ts exists", () => {
    expect(fileExists("src/hooks/use-session.ts")).toBe(true);
  });

  test("src/types.ts exists", () => {
    expect(fileExists("src/types.ts")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AuthProvider
// ---------------------------------------------------------------------------

describe("AuthProvider", () => {
  test("AuthProvider is exported from src/components/auth-provider", async () => {
    const mod = await import("../components/auth-provider");
    expect(typeof mod.AuthProvider).toBe("function");
  });

  test("AuthProvider renders children without errors", async () => {
    const { AuthProvider } = await import("../components/auth-provider");
    render(
      <AuthProvider baseURL="http://localhost:3000">
        <div>child content</div>
      </AuthProvider>
    );
    expect(screen.getByText("child content")).toBeDefined();
  });

  test("AuthProvider calls createAuthClient with the provided baseURL", async () => {
    mockCreateAuthClient.mockClear();
    const { AuthProvider } = await import("../components/auth-provider");
    render(
      <AuthProvider baseURL="http://localhost:3000">
        <span>app</span>
      </AuthProvider>
    );
    expect(mockCreateAuthClient).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: "http://localhost:3000" })
    );
  });

  test("AuthProvider accepts and passes baseURL prop correctly", async () => {
    mockCreateAuthClient.mockClear();
    const { AuthProvider } = await import("../components/auth-provider");
    render(
      <AuthProvider baseURL="https://example.com/api/auth">
        <span>ok</span>
      </AuthProvider>
    );
    const call = mockCreateAuthClient.mock.calls[0]?.[0] as { baseURL: string } | undefined;
    expect(call?.baseURL).toBe("https://example.com/api/auth");
  });
});

// ---------------------------------------------------------------------------
// useAuth hook
// ---------------------------------------------------------------------------

describe("useAuth hook", () => {
  test("useAuth is exported from src/hooks/use-auth", async () => {
    const mod = await import("../hooks/use-auth");
    expect(typeof mod.useAuth).toBe("function");
  });

  test("useAuth returns the auth client when inside AuthProvider", async () => {
    const { AuthProvider } = await import("../components/auth-provider");
    const { useAuth } = await import("../hooks/use-auth");

    const { result } = renderHook(() => useAuth(), {
      wrapper: ({ children }) => (
        <AuthProvider baseURL="http://localhost:3000">{children}</AuthProvider>
      ),
    });

    expect(result.current).toBeDefined();
    expect(typeof result.current.signIn).toBe("function");
    expect(typeof result.current.signOut).toBe("function");
    expect(typeof result.current.signUp).toBe("function");
  });

  test("useAuth throws a helpful error when used outside AuthProvider", async () => {
    const { useAuth } = await import("../hooks/use-auth");

    // Suppress the expected React error boundary console.error noise
    const originalError = console.error;
    console.error = () => {};

    expect(() => {
      renderHook(() => useAuth());
    }).toThrow(/AuthProvider/i);

    console.error = originalError;
  });

  test("useAuth exposes signIn method from auth client", async () => {
    const { AuthProvider } = await import("../components/auth-provider");
    const { useAuth } = await import("../hooks/use-auth");

    const { result } = renderHook(() => useAuth(), {
      wrapper: ({ children }) => (
        <AuthProvider baseURL="http://localhost:3000">{children}</AuthProvider>
      ),
    });

    expect(typeof result.current.signIn).toBe("function");
  });

  test("useAuth exposes signOut method from auth client", async () => {
    const { AuthProvider } = await import("../components/auth-provider");
    const { useAuth } = await import("../hooks/use-auth");

    const { result } = renderHook(() => useAuth(), {
      wrapper: ({ children }) => (
        <AuthProvider baseURL="http://localhost:3000">{children}</AuthProvider>
      ),
    });

    expect(typeof result.current.signOut).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// useSession hook
// ---------------------------------------------------------------------------

describe("useSession hook", () => {
  test("useSession is exported from src/hooks/use-session", async () => {
    const mod = await import("../hooks/use-session");
    expect(typeof mod.useSession).toBe("function");
  });

  test("useSession returns session shape with data, isPending inside AuthProvider", async () => {
    const { AuthProvider } = await import("../components/auth-provider");
    const { useSession } = await import("../hooks/use-session");

    const { result } = renderHook(() => useSession(), {
      wrapper: ({ children }) => (
        <AuthProvider baseURL="http://localhost:3000">{children}</AuthProvider>
      ),
    });

    // Should return an object (not throw); shape comes from auth client's useSession
    expect(result.current).toBeDefined();
    expect("isPending" in result.current).toBe(true);
  });

  test("useSession isPending is false when mock returns false", async () => {
    mockUseSession.mockReturnValue({ data: null, isPending: false, error: null });

    const { AuthProvider } = await import("../components/auth-provider");
    const { useSession } = await import("../hooks/use-session");

    const { result } = renderHook(() => useSession(), {
      wrapper: ({ children }) => (
        <AuthProvider baseURL="http://localhost:3000">{children}</AuthProvider>
      ),
    });

    expect(result.current.isPending).toBe(false);
  });

  test("useSession isPending is true when mock returns pending state", async () => {
    mockUseSession.mockReturnValue({ data: null, isPending: true, error: null });

    const { AuthProvider } = await import("../components/auth-provider");
    const { useSession } = await import("../hooks/use-session");

    const { result } = renderHook(() => useSession(), {
      wrapper: ({ children }) => (
        <AuthProvider baseURL="http://localhost:3000">{children}</AuthProvider>
      ),
    });

    expect(result.current.isPending).toBe(true);

    // Reset for subsequent tests
    mockUseSession.mockReturnValue({ data: null, isPending: false, error: null });
  });

  test("useSession surfaces user data when session is active", async () => {
    const fakeUser = { id: "user-1", email: "test@example.com", name: "Test User" };
    const fakeSession = { id: "session-1", userId: "user-1" };
    mockUseSession.mockReturnValue({
      data: { user: fakeUser, session: fakeSession },
      isPending: false,
      error: null,
    });

    const { AuthProvider } = await import("../components/auth-provider");
    const { useSession } = await import("../hooks/use-session");

    const { result } = renderHook(() => useSession(), {
      wrapper: ({ children }) => (
        <AuthProvider baseURL="http://localhost:3000">{children}</AuthProvider>
      ),
    });

    expect(result.current.data?.user?.email).toBe("test@example.com");

    // Reset
    mockUseSession.mockReturnValue({ data: null, isPending: false, error: null });
  });

  test("useSession throws helpful error when used outside AuthProvider", async () => {
    const { useSession } = await import("../hooks/use-session");

    const originalError = console.error;
    console.error = () => {};

    expect(() => {
      renderHook(() => useSession());
    }).toThrow(/AuthProvider/i);

    console.error = originalError;
  });
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

describe("types", () => {
  test("src/types.ts exports AuthUIContextValue type", async () => {
    // Types are erased at runtime; we verify the module at least imports cleanly
    // and that any runtime-accessible values are present
    const mod = await import("../types");
    // Module must load without error — type-level correctness verified by typecheck
    expect(mod).toBeDefined();
  });

  test("src/types.ts can be imported without throwing", async () => {
    expect(async () => {
      await import("../types");
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// client.ts entry point exports
// ---------------------------------------------------------------------------

describe("src/client.ts entry point", () => {
  test("AuthProvider is exported from src/client", async () => {
    const mod = await import("../client");
    expect(typeof mod.AuthProvider).toBe("function");
  });

  test("useAuth is exported from src/client", async () => {
    const mod = await import("../client");
    expect(typeof mod.useAuth).toBe("function");
  });

  test("useSession is exported from src/client", async () => {
    const mod = await import("../client");
    expect(typeof mod.useSession).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// src/index.ts entry point exports
// ---------------------------------------------------------------------------

describe("src/index.ts entry point", () => {
  test("types are re-exported from src/index without error", async () => {
    // The index barrel should export types; module load must not throw
    const mod = await import("../index");
    expect(mod).toBeDefined();
  });
});
