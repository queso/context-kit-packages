import Stripe from "stripe";

/**
 * The Stripe API version every request uses. It matches the version pinned by
 * the stripe-node release in package.json, so the TypeScript types describe the
 * responses exactly. Create webhook endpoints with this same version, or their
 * payloads follow the account default instead (see the README).
 */
export const STRIPE_API_VERSION = "2026-10-28.endive" as const;

export interface StripeClientOptions {
  /** Custom HTTP client, for tests: `Stripe.createFetchHttpClient(fakeFetch)`. */
  httpClient?: Stripe.StripeConfig["httpClient"];
  /** Retries on network errors and 409/429/5xx. stripe-node adds idempotency keys to retries. Default 2. */
  maxNetworkRetries?: number;
  /** Request timeout in milliseconds. Default 30 seconds. */
  timeout?: number;
  /** Point at stripe-mock in tests. Never set these in production. */
  host?: string;
  port?: number;
  protocol?: "http" | "https";
}

const SECRET_KEY_PATTERN = /^(sk|rk)_(test|live)_/;

/**
 * Creates the Stripe client the package uses. Accepts a secret key or, as
 * Stripe recommends, a restricted key (`rk_...`).
 */
export function createStripeClient(secretKey: string, options: StripeClientOptions = {}): Stripe {
  if (!SECRET_KEY_PATTERN.test(secretKey)) {
    // The key itself is never echoed: it may be a live credential pasted by mistake.
    throw new Error(
      "createStripeClient needs a secret or restricted key (sk_test_, sk_live_, rk_test_ or rk_live_)"
    );
  }
  return new Stripe(secretKey, {
    apiVersion: STRIPE_API_VERSION,
    maxNetworkRetries: options.maxNetworkRetries ?? 2,
    timeout: options.timeout ?? 30_000,
    appInfo: { name: "@context-kit/billing", url: "https://github.com/queso/context-kit-packages" },
    ...(options.httpClient ? { httpClient: options.httpClient } : {}),
    ...(options.host ? { host: options.host } : {}),
    ...(options.port ? { port: options.port } : {}),
    ...(options.protocol ? { protocol: options.protocol } : {}),
  });
}
