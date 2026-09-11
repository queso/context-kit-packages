import { patchConsoleError } from "./console-patch.js";
import { ErrorBoundary } from "./error-boundary.js";
import { initErrorTracker } from "./init.js";
import type { ErrorTrackerConfig } from "./types.js";

export interface CreateErrorTrackerOptions {
  endpoint?: string;
  token?: string;
  secretHeaderName?: string;
  environment?: string;
  patchConsoleError?: boolean;
}

export function createErrorTracker(options: CreateErrorTrackerOptions = {}) {
  const config: ErrorTrackerConfig = {
    endpoint: options.endpoint ?? "/api/errors",
    token: options.token,
    secretHeaderName: options.secretHeaderName ?? "x-error-tracker-token",
    environment: options.environment ?? process.env.NODE_ENV ?? "development",
    patchConsoleError: options.patchConsoleError ?? false,
  };

  // Pre-bind config into the ErrorBoundary via defaultProps so consumers
  // can use <ErrorBoundary> without passing config explicitly.
  // biome-ignore lint/suspicious/noExplicitAny: dynamic class creation
  const ConfiguredErrorBoundary: any = class extends ErrorBoundary {
    static displayName = "ErrorBoundary";
    static defaultProps = { config };
  };

  function init(): () => void {
    // Warn in production without token
    const env = config.environment ?? process.env.NODE_ENV;
    if (env === "production" && !config.token) {
      console.warn(
        "[error-tracker] Warning: no token configured. The token is a shared credential visible in the client bundle; it damps unsolicited reports but is not a secret. Set `token` here and `secretHeaderToken` on the server so unauthenticated requests are rejected."
      );
    }

    const cleanupInit = initErrorTracker(config);
    let cleanupPatch: (() => void) | undefined;

    if (options.patchConsoleError) {
      cleanupPatch = patchConsoleError(config);
    }

    return () => {
      cleanupInit();
      if (cleanupPatch) {
        cleanupPatch();
      }
    };
  }

  return {
    init,
    ErrorBoundary: ConfiguredErrorBoundary,
  };
}
