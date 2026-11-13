import Stripe from "stripe";
import { createStripeClient } from "../../stripe-client";
import customerFixture from "../fixtures/stripe/customer.json";
import subscriptionFixture from "../fixtures/stripe/subscription.json";
import priceFixture from "../fixtures/stripe/price.json";
import productFixture from "../fixtures/stripe/product.json";
import invoiceFixture from "../fixtures/stripe/invoice.json";
import checkoutSessionFixture from "../fixtures/stripe/checkout.session.json";
import portalSessionFixture from "../fixtures/stripe/billing_portal.session.json";
import meterFixture from "../fixtures/stripe/billing.meter.json";
import meterEventFixture from "../fixtures/stripe/billing.meter_event.json";

/**
 * An in-memory stand-in for the Stripe API, reached through stripe-node's own
 * fetch HTTP client so the real SDK builds every request. Objects start from
 * Stripe's published fixtures (see fixtures/stripe/SOURCE.md) with only the
 * fields a test needs overridden.
 *
 * It keeps state, unlike stripe-mock, so a test can create a customer, put a
 * subscription on it and read it back. Request shapes are checked against
 * Stripe's OpenAPI spec separately, in stripe-mock.test.ts.
 */

type Json = Record<string, unknown>;

export interface RecordedRequest {
  method: string;
  path: string;
  params: Json;
  idempotencyKey: string | null;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Parses Stripe's `a[b][0][c]=x` form encoding into nested objects and arrays. */
export function parseStripeForm(body: string): Json {
  const out: Json = {};
  for (const [rawKey, value] of new URLSearchParams(body)) {
    const parts = rawKey.split(/\[|\]\[|\]/).filter((p) => p !== "");
    let node: Record<string, unknown> | unknown[] = out;
    parts.forEach((part, i) => {
      const last = i === parts.length - 1;
      const nextIsIndex = !last && /^\d+$/.test(parts[i + 1]!);
      const key: string | number = Array.isArray(node) ? Number(part) : part;
      const container = node as Record<string | number, unknown>;
      if (last) {
        container[key] = value;
      } else {
        if (container[key] === undefined) container[key] = nextIsIndex ? [] : {};
        node = container[key] as Record<string, unknown> | unknown[];
      }
    });
  }
  return out;
}

export interface SubscriptionSpec {
  id: string;
  customer: string;
  status: Stripe.Subscription.Status;
  priceIds: string[];
  periodStart?: number;
  periodEnd?: number;
  metadata?: Record<string, string>;
  cancelAt?: number | null;
  trialEnd?: number | null;
  /** Finalization time of the latest invoice, for past_due subscriptions. Also stored as an open invoice. */
  latestInvoiceFinalizedAt?: number | null;
  /** Finalization times of every open (unpaid) invoice of the subscription, oldest first or not. */
  openInvoicesFinalizedAt?: number[];
  /** paid_at of invoices the subscription has paid. */
  paidInvoicesPaidAt?: number[];
  /** Status of the latest invoice. Default "open". */
  latestInvoiceStatus?: "draft" | "open" | "paid";
  livemode?: boolean;
}

let counter = 0;
const nextId = (prefix: string) => `${prefix}_fake${(++counter).toString().padStart(6, "0")}`;

export class FakeStripe {
  readonly requests: RecordedRequest[] = [];
  readonly customers = new Map<string, Json>();
  readonly subscriptions = new Map<string, Json>();
  readonly prices = new Map<string, Json>();
  readonly products = new Map<string, Json>();
  readonly meters = new Map<string, Json>();
  readonly meterEvents: Json[] = [];
  readonly checkoutSessions = new Map<string, Json>();
  readonly invoices = new Map<string, Json>();
  private readonly idempotent = new Map<string, { status: number; body: Json }>();
  private readonly failures: {
    match: (r: RecordedRequest) => boolean;
    status: number;
    body: Json;
    times: number;
    afterHandling: boolean;
    /** Save the failure as the idempotency key's response, as Stripe does for 500s. */
    cache: boolean;
    /** The client sees a dropped connection (no HTTP status) instead of a response. */
    network?: boolean;
  }[] = [];

  /**
   * How a repeated meter event identifier is refused.
   * - "v1-message": what Stripe test mode was observed to return on v1, an
   *   invalid_request_error with no code and the message "An event already
   *   exists with identifier <id>." (reported in dlopez2392/bis-platform#146).
   * - "v2-code": the documented v2 error, code duplicate_meter_event.
   */
  duplicateStyle: "v1-message" | "v2-code" = "v1-message";

  private duplicateMeterEventError(identifier: string): Json {
    return this.duplicateStyle === "v2-code"
      ? { error: { type: "invalid_request_error", code: "duplicate_meter_event", message: "A meter event with a duplicate identifier has already been submitted." } }
      : { error: { type: "invalid_request_error", message: `An event already exists with identifier ${identifier}.` } };
  }

  /** The stripe-node client wired to this fake. */
  client(): Stripe {
    return createStripeClient("sk_test_fake", {
      httpClient: Stripe.createFetchHttpClient(this.fetch as typeof fetch),
      maxNetworkRetries: 0,
    });
  }

  /** Make the next `times` requests matching `match` fail with `status`. */
  failNext(
    match: (r: RecordedRequest) => boolean,
    status = 500,
    times = 1,
    body: Json = { error: { type: "api_error", message: "fake failure" } }
  ): void {
    this.failures.push({ match, status, body, times, afterHandling: false, cache: false });
  }

  /**
   * Like failNext for one request, but the failure is saved as the response for
   * the request's idempotency key, so a later POST with the same key replays it.
   * Stripe does this for every first result, 500 errors included.
   */
  failAndCache(
    match: (r: RecordedRequest) => boolean,
    status = 500,
    body: Json = { error: { type: "api_error", message: "fake failure" } }
  ): void {
    this.failures.push({ match, status, body, times: 1, afterHandling: false, cache: true });
  }

  /**
   * The next matching request ends in a dropped connection: stripe-node raises a
   * connection error with no statusCode. With `afterHandling`, Stripe processed
   * the request first (a timeout after the work was done).
   */
  failNetwork(match: (r: RecordedRequest) => boolean, afterHandling = false): void {
    this.failures.push({ match, status: 0, body: {}, times: 1, afterHandling, cache: false, network: true });
  }

  /**
   * Stripe handles the next matching request, then the response is lost (the
   * client sees `status`). Models a crash or timeout after Stripe accepted it.
   */
  loseNextResponse(match: (r: RecordedRequest) => boolean, status = 500): void {
    this.failures.push({
      match,
      status,
      body: { error: { type: "api_error", message: "response lost" } },
      times: 1,
      afterHandling: true,
      cache: false,
    });
  }

  addPrice(spec: {
    id?: string;
    lookupKey: string | null;
    usageType?: "licensed" | "metered";
    unitAmount?: number;
    metadata?: Record<string, string>;
    product?: string;
  }): Json {
    const id = spec.id ?? nextId("price");
    const price = clone(priceFixture) as Json;
    Object.assign(price, {
      id,
      lookup_key: spec.lookupKey,
      metadata: spec.metadata ?? {},
      product: spec.product ?? "prod_fake",
      unit_amount: spec.unitAmount ?? 2900,
      unit_amount_decimal: String(spec.unitAmount ?? 2900),
      recurring: {
        interval: "month",
        interval_count: 1,
        meter: spec.usageType === "metered" ? "mtr_fake" : null,
        usage_type: spec.usageType ?? "licensed",
        trial_period_days: null,
      },
    });
    this.prices.set(id, price);
    return price;
  }

  putSubscription(spec: SubscriptionSpec): Json {
    const sub = clone(subscriptionFixture) as Json;
    const periodStart = spec.periodStart ?? 1_767_225_600; // 2026-01-01T00:00:00Z
    const periodEnd = spec.periodEnd ?? 1_769_904_000; // 2026-02-01T00:00:00Z
    const items = spec.priceIds.map((priceId, i) => {
      const price = this.prices.get(priceId);
      if (!price) throw new Error(`fake stripe: unknown price ${priceId}`);
      const base = clone((subscriptionFixture as Json & { items: { data: Json[] } }).items.data[0]!);
      return {
        ...base,
        id: `si_${spec.id}_${i}`,
        subscription: spec.id,
        price: clone(price),
        quantity: (price.recurring as Json).usage_type === "metered" ? undefined : 1,
        current_period_start: periodStart,
        current_period_end: periodEnd,
      };
    });
    const invoice = (id: string, status: string, finalizedAt: number | null): Json => {
      const inv = clone(invoiceFixture) as Json;
      Object.assign(inv, {
        id,
        customer: spec.customer,
        status,
        status_transitions: { finalized_at: finalizedAt, marked_uncollectible_at: null, paid_at: null, voided_at: null },
        parent: {
          type: "subscription_details",
          quote_details: null,
          subscription_details: { metadata: null, subscription: spec.id },
        },
      });
      return inv;
    };
    for (const [id, inv] of this.invoices) {
      if (((inv.parent as Json)?.subscription_details as Json)?.subscription === spec.id) this.invoices.delete(id);
    }
    (spec.paidInvoicesPaidAt ?? []).forEach((t, i) => {
      const inv = invoice(`in_${spec.id}_paid${i}`, "paid", t - 3600);
      Object.assign(inv, { created: t - 3600 });
      (inv.status_transitions as Json).paid_at = t;
      this.invoices.set(String(inv.id), inv);
    });
    (spec.openInvoicesFinalizedAt ?? []).forEach((t, i) => {
      const inv = invoice(`in_${spec.id}_open${i}`, "open", t);
      Object.assign(inv, { created: t });
      this.invoices.set(String(inv.id), inv);
    });
    let latestInvoice: Json | null = null;
    if (spec.latestInvoiceFinalizedAt !== undefined && spec.latestInvoiceFinalizedAt !== null) {
      const status = spec.latestInvoiceStatus ?? "open";
      latestInvoice = invoice(`in_${spec.id}`, status, status === "draft" ? null : spec.latestInvoiceFinalizedAt);
      if (status === "open") this.invoices.set(String(latestInvoice.id), latestInvoice);
    }
    Object.assign(sub, {
      id: spec.id,
      customer: spec.customer,
      status: spec.status,
      metadata: spec.metadata ?? {},
      cancel_at: spec.cancelAt ?? null,
      trial_end: spec.trialEnd ?? null,
      livemode: spec.livemode ?? false,
      billing_mode: { type: "flexible", flexible: { proration_discounts: "included" } },
      items: { object: "list", data: items, has_more: false, url: `/v1/subscription_items?subscription=${spec.id}` },
      latest_invoice: latestInvoice,
    });
    this.subscriptions.set(spec.id, sub);
    return sub;
  }

  /** Simulate the customer finishing Checkout: the session completes with a subscription. */
  completeCheckoutSession(sessionId: string, subscriptionId: string): void {
    const cs = this.checkoutSessions.get(sessionId);
    if (!cs) throw new Error(`fake stripe: unknown checkout session ${sessionId}`);
    Object.assign(cs, { status: "complete", payment_status: "paid", subscription: subscriptionId });
  }

  putCustomer(id: string, metadata: Record<string, string> = {}): Json {
    const customer = clone(customerFixture) as Json;
    Object.assign(customer, { id, metadata, livemode: false });
    this.customers.set(id, customer);
    return customer;
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const bodyText = typeof init?.body === "string" ? init.body : "";
    const params = method === "GET" || method === "DELETE" ? parseStripeForm(url.search.slice(1)) : parseStripeForm(bodyText);
    const req: RecordedRequest = {
      method,
      path: url.pathname,
      params,
      idempotencyKey: headers.get("idempotency-key"),
    };
    this.requests.push(req);

    // Stripe replays the saved response for a repeated idempotency key. This
    // comes first: an injected failure never overrides a replay, and is left
    // armed for the next request that actually reaches handling.
    const idemKey = req.idempotencyKey ? `${method} ${url.pathname} ${req.idempotencyKey}` : null;
    if (idemKey && method === "POST") {
      const saved = this.idempotent.get(idemKey);
      if (saved) return json(saved.status, saved.body);
    }

    const failure = this.failures.find((f) => f.times > 0 && f.match(req));
    if (failure) failure.times--;
    if (failure?.network && !failure.afterHandling) throw new TypeError("fake network error");
    if (failure && !failure.afterHandling) {
      if (failure.cache && idemKey && method === "POST") {
        this.idempotent.set(idemKey, { status: failure.status, body: failure.body });
      }
      return json(failure.status, failure.body);
    }
    const [status, body] = this.route(req);
    if (idemKey && method === "POST") this.idempotent.set(idemKey, { status, body });
    if (failure?.afterHandling) {
      if (failure.network) throw new TypeError("fake network error");
      return json(failure.status, failure.body);
    }
    return json(status, body);
  };

  private route(req: RecordedRequest): [number, Json] {
    const { method, path, params } = req;
    let m: RegExpMatchArray | null;

    if (method === "POST" && path === "/v1/customers") {
      const id = nextId("cus");
      return [200, this.putCustomer(id, (params.metadata as Record<string, string>) ?? {})];
    }
    if (method === "GET" && path !== "/v1/customers/search" && (m = path.match(/^\/v1\/customers\/([^/]+)$/))) {
      const c = this.customers.get(m[1]!);
      return c ? [200, c] : notFound("customer", m[1]!);
    }
    if (method === "POST" && (m = path.match(/^\/v1\/customers\/([^/]+)$/))) {
      const c = this.customers.get(m[1]!);
      if (!c) return notFound("customer", m[1]!);
      if (params.metadata) c.metadata = { ...(c.metadata as Json), ...(params.metadata as Json) };
      for (const k of ["name", "email"]) if (params[k] !== undefined) c[k] = params[k];
      return [200, c];
    }
    if (method === "GET" && path === "/v1/checkout/sessions") {
      const data = [...this.checkoutSessions.values()].filter(
        (cs) => (!params.customer || cs.customer === params.customer) && (!params.status || cs.status === params.status)
      );
      return [200, { object: "list", data, has_more: false, url: path }];
    }
    if (method === "POST" && (m = path.match(/^\/v1\/checkout\/sessions\/([^/]+)\/expire$/))) {
      const cs = this.checkoutSessions.get(m[1]!);
      if (!cs) return notFound("checkout.session", m[1]!);
      if (cs.status !== "open") {
        return [400, { error: { type: "invalid_request_error", message: `Only Checkout Sessions with a status of open can be expired.` } }];
      }
      cs.status = "expired";
      return [200, cs];
    }
    if (method === "GET" && path === "/v1/customers") {
      return [200, { object: "list", data: [...this.customers.values()], has_more: false, url: path }];
    }
    if (method === "GET" && (m = path.match(/^\/v1\/checkout\/sessions\/([^/]+)$/))) {
      const cs = this.checkoutSessions.get(m[1]!);
      return cs ? [200, cs] : notFound("checkout.session", m[1]!);
    }
    if (method === "GET" && path === "/v1/customers/search") {
      const match = String(params.query ?? "").match(/metadata\['([^']+)'\]:'([^']*)'/);
      const data = match
        ? [...this.customers.values()].filter((c) => (c.metadata as Json)[match[1]!] === match[2])
        : [];
      return [200, { object: "search_result", data, has_more: false, next_page: null, url: path }];
    }
    if (method === "GET" && (m = path.match(/^\/v1\/subscriptions\/([^/]+)$/))) {
      const s = this.subscriptions.get(m[1]!);
      if (!s) return notFound("subscription", m[1]!);
      const out = clone(s);
      const expand = (params.expand as string[] | undefined) ?? [];
      if (!expand.includes("latest_invoice") && out.latest_invoice) {
        out.latest_invoice = (out.latest_invoice as Json).id;
      }
      const customer = this.customers.get(String(out.customer));
      if (expand.includes("customer") && customer) out.customer = clone(customer);
      return [200, out];
    }
    if (method === "GET" && path === "/v1/subscriptions") {
      const data = [...this.subscriptions.values()]
        .filter((s) => !params.customer || s.customer === params.customer)
        .filter((s) =>
          params.status === "all"
            ? true
            : params.status
              ? s.status === params.status
              : !["canceled", "incomplete_expired"].includes(String(s.status))
        )
        .map((s) => {
          const out = clone(s);
          const expand = (params.expand as string[] | undefined) ?? [];
          if (!expand.includes("data.latest_invoice") && out.latest_invoice) {
            out.latest_invoice = (out.latest_invoice as Json).id;
          }
          return out;
        });
      // Honors limit and starting_after only when a limit is sent, so callers
      // that omit it still get everything.
      let page = data;
      let hasMore = false;
      if (params.limit) {
        const start = params.starting_after ? data.findIndex((s) => s.id === params.starting_after) + 1 : 0;
        page = data.slice(start, start + Number(params.limit));
        hasMore = start + page.length < data.length;
      }
      return [200, { object: "list", data: page, has_more: hasMore, url: path }];
    }
    if (method === "GET" && path === "/v1/invoices") {
      // Stripe lists newest first.
      const data = [...this.invoices.values()]
        .filter(
          (inv) =>
            (!params.subscription || ((inv.parent as Json)?.subscription_details as Json)?.subscription === params.subscription) &&
            (!params.status || inv.status === params.status)
        )
        .sort((a, b) => Number(b.created) - Number(a.created))
        .slice(0, params.limit ? Number(params.limit) : undefined);
      return [200, { object: "list", data, has_more: false, url: path }];
    }
    if (method === "GET" && path === "/v1/prices") {
      const keys = (params.lookup_keys as string[] | undefined) ?? [];
      const data = [...this.prices.values()].filter(
        (p) => keys.length === 0 || keys.includes(String(p.lookup_key))
      );
      return [200, { object: "list", data: data.filter((p) => p.active !== false), has_more: false, url: path }];
    }
    if (method === "POST" && path === "/v1/products") {
      const product = clone(productFixture) as Json;
      Object.assign(product, { id: nextId("prod"), name: params.name, metadata: params.metadata ?? {} });
      this.products.set(String(product.id), product);
      return [200, product];
    }
    if (method === "POST" && path === "/v1/prices") {
      const recurring = (params.recurring as Json | undefined) ?? {};
      if (params.transfer_lookup_key === "true") {
        for (const p of this.prices.values()) if (p.lookup_key === params.lookup_key) p.lookup_key = null;
      }
      const price = this.addPrice({
        lookupKey: (params.lookup_key as string) ?? null,
        usageType: recurring.usage_type === "metered" ? "metered" : "licensed",
        unitAmount: Number(params.unit_amount ?? 0),
        metadata: (params.metadata as Record<string, string>) ?? {},
        product: params.product as string,
      });
      if (recurring.meter) (price.recurring as Json).meter = recurring.meter;
      return [200, price];
    }
    if (method === "GET" && path === "/v1/billing/meters") {
      return [200, { object: "list", data: [...this.meters.values()], has_more: false, url: path }];
    }
    if (method === "POST" && path === "/v1/billing/meters") {
      const meter = clone(meterFixture) as Json;
      Object.assign(meter, {
        id: nextId("mtr"),
        event_name: params.event_name,
        display_name: params.display_name,
        status: "active",
        default_aggregation: params.default_aggregation ?? { formula: "sum" },
        customer_mapping: params.customer_mapping ?? { type: "by_id", event_payload_key: "stripe_customer_id" },
        value_settings: params.value_settings ?? { event_payload_key: "value" },
        event_time_window: params.event_time_window ?? null,
      });
      this.meters.set(String(meter.id), meter);
      return [200, meter];
    }
    if (method === "POST" && path === "/v1/billing/meter_events") {
      const event = clone(meterEventFixture) as Json;
      Object.assign(event, {
        event_name: params.event_name,
        identifier: params.identifier,
        payload: params.payload,
        timestamp: Number(params.timestamp),
      });
      // A repeated identifier under the same idempotency key never gets here: the
      // saved response is replayed above. Under a new key, Stripe refuses it.
      if (this.meterEvents.some((e) => e.identifier === params.identifier)) {
        return [400, this.duplicateMeterEventError(String(params.identifier))];
      }
      this.meterEvents.push(event);
      return [200, event];
    }
    if (method === "POST" && path === "/v1/checkout/sessions") {
      const session = clone(checkoutSessionFixture) as Json;
      const id = nextId("cs_test");
      Object.assign(session, {
        id,
        url: `https://checkout.stripe.com/c/pay/${id}`,
        mode: params.mode,
        customer: params.customer,
        client_reference_id: params.client_reference_id,
        metadata: params.metadata ?? {},
        subscription: null,
        status: "open",
        created: Math.floor(Date.now() / 1000) + this.checkoutSessions.size,
      });
      this.checkoutSessions.set(id, session);
      return [200, session];
    }
    if (method === "POST" && path === "/v1/billing_portal/sessions") {
      const session = clone(portalSessionFixture) as Json;
      Object.assign(session, {
        id: nextId("bps"),
        customer: params.customer,
        return_url: params.return_url,
        url: `https://billing.stripe.com/p/session/${nextId("test")}`,
      });
      return [200, session];
    }
    return [404, { error: { type: "invalid_request_error", message: `fake stripe: no route for ${method} ${path}` } }];
  }
}

function json(status: number, body: Json): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "request-id": "req_fake" },
  });
}

function notFound(kind: string, id: string): [number, Json] {
  return [
    404,
    {
      error: {
        type: "invalid_request_error",
        code: "resource_missing",
        message: `No such ${kind}: '${id}'`,
      },
    },
  ];
}
