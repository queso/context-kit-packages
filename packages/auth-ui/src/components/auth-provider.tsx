"use client";

import * as React from "react";
import { createAuthClient } from "@context-kit/auth/client";
import type { AuthUIContextValue } from "../types";

const AuthUIContext = React.createContext<AuthUIContextValue | null>(null);

export type AuthProviderProps = {
  baseURL: string;
  children: React.ReactNode;
};

export function AuthProvider({ baseURL, children }: AuthProviderProps) {
  const client = React.useMemo(
    () => createAuthClient({ baseURL }),
    [baseURL]
  );

  return (
    <AuthUIContext.Provider value={{ client }}>
      {children}
    </AuthUIContext.Provider>
  );
}
AuthProvider.displayName = "AuthProvider";

export function useAuthContext(): AuthUIContextValue {
  const ctx = React.useContext(AuthUIContext);
  if (!ctx) {
    throw new Error(
      "useAuthContext must be used within an <AuthProvider>. " +
        "Wrap your app with <AuthProvider baseURL={...}>."
    );
  }
  return ctx;
}
