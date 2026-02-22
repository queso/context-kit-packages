"use client";

import { useAuthContext } from "../components/auth-provider";
import type { SessionData } from "../types";

export function useSession(): {
  data: { user?: SessionData["user"]; session?: SessionData["session"] } | null;
  isPending: boolean;
  error: unknown;
} {
  const { client } = useAuthContext();
  return client.useSession();
}
