import type { ErrorTrackerConfig } from "./types.js";
import { initErrorTracker } from "./init.js";
import { patchConsoleError } from "./console-patch.js";
import { ErrorBoundary } from "./error-boundary.js";

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
    secretHeaderName: options.secretHeaderName,
    environment: options.environment ?? process.env.NODE_ENV ?? "development",
    patchConsoleError: options.patchConsoleError ?? false,
  };

  // Create a pre-bound ErrorBoundary class for this tracker's config
  const BoundErrorBoundary = class extends ErrorBoundary {
    static displayName = "BoundErrorBoundary";
  };
  // Override default config by capturing it in props — actually just expose the
  // class with a known config. The config is passed as a prop, so we create a
  // wrapper component that pre-fills the config prop.
  // biome-ignore lint/suspicious/noExplicitAny: dynamic class creation
  const ConfiguredErrorBoundary: any = class extends ErrorBoundary {};
  ConfiguredErrorBoundary._trackerConfig = config;

  function init(): () => void {
    // Warn in production without token
    const env = config.environment ?? process.env.NODE_ENV;
    if (env === "production" && !config.token) {
      console.warn(
        "[error-tracker] Warning: no secret token configured. Set `token` to protect your ingestion endpoint in production."
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
