"use client";

export type AuthClient = {
  useSession: () => {
    data: SessionData | null;
    isPending: boolean;
    error: unknown;
  };
  signIn: unknown;
  signOut: unknown;
  signUp: unknown;
  [key: string]: unknown;
};

export type SessionData = {
  user?: {
    id?: string;
    email?: string;
    name?: string;
    [key: string]: unknown;
  } | null;
  session?: {
    id?: string;
    userId?: string;
    [key: string]: unknown;
  } | null;
};

export type AuthUIContextValue = {
  client: AuthClient;
};
