export { createAuth } from "./create-auth";
export { toNextJsHandler } from "./handler";
export { getSession, getUser } from "./session";

export type {
  AuthConfig,
  AuthInstance,
  // Better Auth re-exports
  BetterAuthPlugin,
  PasswordRules,
  Session,
  SessionData,
  SocialProviders,
  User,
} from "./types";
