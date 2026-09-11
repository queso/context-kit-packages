export interface ErrorTrackerConfig {
  endpoint: string;
  token?: string;
  secretHeaderName?: string;
  environment: string;
  patchConsoleError?: boolean;
}

export interface ErrorPayload {
  message: string;
  stack?: string;
  componentStack?: string;
  url: string;
  userAgent: string;
  environment: string;
}

export interface StackFrame {
  file: string;
  line: number;
  column: number;
  functionName?: string;
}

/**
 * The database dialect the `client_error` table lives in. Pass `getDialect()`
 * from `@/db` so it cannot drift from the app's Drizzle instance.
 */
export type ErrorTrackerDialect = "sqlite" | "postgres";

/**
 * How the server half reaches the database. Every server-side factory
 * (`createErrorHandlers`, `createIngestionHandler`, `createQueryHandler`) and
 * the CLI functions take these two fields.
 */
export interface DatabaseConfig {
  /**
   * The app's Drizzle instance (`import { db } from "@/db"`). Drizzle instances
   * are generic over the consumer's schema, so this is typed as `object` and
   * narrowed by `dialect` inside the package.
   */
  db: object;
  /** `getDialect()` from `@/db`. */
  dialect: ErrorTrackerDialect;
}
