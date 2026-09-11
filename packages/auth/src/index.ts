export { createAuth } from "./create-auth";
export { toNextJsHandler } from "./handler";
export { getSession, getUser } from "./session";

export type {
  AuthConfig,
  AuthDialect,
  AuthInstance,
  SessionData,
  PasswordRules,
  // Better Auth re-exports
  BetterAuthPlugin,
  SocialProviders,
  User,
  Session,
} from "./types";
