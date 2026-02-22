"use client";

import { useAuthContext } from "../components/auth-provider";
import type { AuthClient } from "../types";

export function useAuth(): AuthClient {
  const { client } = useAuthContext();
  return client;
}
