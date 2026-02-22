# PRD-0004: @context-kit/billing-ui — Phase 2: Pricing & Checkout UI

**Author:** Josh
**Date:** 2026-02-22
**Status:** Draft
**Package:** `@context-kit/billing-ui`
**Depends on:** PRD-0003 (`@context-kit/billing`)

## Problem Statement

With the billing engine in place (Phase 1), developers still need to build the pricing page and checkout flow from scratch. Every SaaS pricing page has the same patterns — plan comparison cards, monthly/yearly toggle, feature lists, a CTA that launches checkout — yet every team rebuilds them. The checkout integration (Stripe embedded checkout) also requires boilerplate: creating the session server-side, mounting the embedded form, handling success/cancel redirects. This repetitive UI work delays time-to-launch.

## Business Context

The pricing page is the most revenue-critical page in any SaaS app. A polished, conversion-optimized pricing page out of the box makes context-kit projects look professional from day one and reduces time-to-first-revenue. Pairing it with a seamless embedded checkout (no redirect to Stripe) keeps users in the app flow and reduces cart abandonment.

## Goals & Success Metrics

| Goal | Metric | Target |
|------|--------|--------|
| Fast pricing page | Time from install to working pricing page | <10 minutes |
| Conversion-friendly checkout | Uses Stripe embedded checkout with SCA/3DS | Zero payment friction |
| Customizable | Consumers can theme, reorder plans, add feature lists | Without forking |

## User Stories

- **As a** context-kit developer, **I want** a drop-in `<PricingTable>` component **so that** I can show my plans with a monthly/yearly toggle without building it myself.
- **As a** context-kit developer, **I want** the pricing table to read plan data from my billing config **so that** plans stay in sync between backend and UI.
- **As a** context-kit developer, **I want** an embedded Stripe checkout component **so that** users can pay without leaving my app.
- **As a** context-kit developer, **I want** to customize the look of the pricing page (colors, layout, feature descriptions) **so that** it matches my app's branding.
- **As a** context-kit developer, **I want** the pricing page to highlight the user's current plan **so that** logged-in users know where they stand.
- **As a** context-kit developer, **I want** checkout success/cancel handling built in **so that** I don't have to wire up redirect logic manually.

## Scope

### In Scope

- `<BillingProvider>` context provider — wraps billing state (current plan, subscription status, available plans) for child components
- `<PricingTable>` — displays plan cards with: name, price, interval toggle (monthly/yearly), feature list, usage caps, seat limits, CTA button
- `<PricingCard>` — individual plan card, usable standalone or within `<PricingTable>`
- `<EmbeddedCheckout>` — wrapper around Stripe's `EmbeddedCheckoutProvider` that creates the session server-side and mounts the form
- `<CheckoutSuccess>` — success page component (confirms subscription, shows plan details)
- Interval toggle component (monthly/yearly with savings badge)
- "Current plan" badge for logged-in users
- Free tier card (no CTA or "Current Plan" badge when on free)
- Theming via CSS variables and className overrides (same pattern as `@context-kit/auth-ui`)
- Page-level components: `<PricingPage>`, `<CheckoutPage>`, `<CheckoutSuccessPage>` for drop-in route usage

### Out of Scope

- **Subscription management UI** (upgrade/downgrade/cancel, invoice history) — Phase 3
- **Custom payment forms with Stripe Elements** — embedded checkout only for v1
- **A/B testing or analytics** — consumers add their own
- **Localization / multi-currency display** — consumers handle with i18n; prices come from Stripe
- **Pages Router support** — App Router only

## Requirements

### Functional Requirements

1. `<BillingProvider>` shall accept the billing instance (from `createBilling`) and expose via context: available plans, current user plan, subscription status, and loading state.
2. `<BillingProvider>` shall work for both authenticated users (shows current plan) and unauthenticated visitors (shows plans without "current" highlighting).
3. `<PricingTable>` shall render all non-free plans as cards in a responsive grid (1 column mobile, 2-3 columns desktop).
4. `<PricingTable>` shall include an interval toggle (monthly/yearly) that updates displayed prices. If a plan has both `monthly` and `yearly` price IDs, both are shown; if only one, that interval is displayed.
5. The yearly option shall display a savings badge (e.g., "Save 20%") calculated from the monthly vs yearly prices.
6. Each `<PricingCard>` shall display: plan name, price with interval, feature list (passed as props), usage caps (from plan config), seat limit, and a CTA button.
7. The CTA button shall: for unauthenticated users, link to sign-in (configurable path); for authenticated users without a subscription, initiate checkout; for users on a different plan, label as "Upgrade"/"Downgrade" (determined by plan order).
8. `<PricingCard>` shall accept a `highlighted` prop to visually emphasize a recommended plan (border, badge, etc.).
9. For logged-in users, the card matching their current plan shall show a "Current Plan" badge and a disabled CTA.
10. `<EmbeddedCheckout>` shall accept `planId` and `interval`, call the server to create a checkout session, and render Stripe's embedded checkout form.
11. `<EmbeddedCheckout>` shall handle loading, error, and completion states with appropriate UI.
12. `<CheckoutSuccess>` shall display a confirmation message with the subscribed plan name and a CTA to continue to the app.
13. All components shall accept `className` props for styling overrides.
14. All components shall use CSS variables for theming (colors, border radius, spacing) consistent with `@context-kit/auth-ui`.

### Non-Functional Requirements

1. The package shall peer-depend on `@context-kit/billing`, `react`, `next`, and `@stripe/react-stripe-js`.
2. Components shall be Server Component compatible where possible; interactive components (toggle, checkout) shall be Client Components with `"use client"` directives.
3. The package shall ship ESM only with tree-shaking support.
4. Components shall be accessible: proper ARIA labels on the toggle, focus management on plan selection, screen-reader-friendly pricing display.

## Component API Sketches

```tsx
// Pricing page (drop-in route component)
<BillingProvider billing={billing} userId={user?.id}>
  <PricingTable
    features={{
      pro: ["10 projects", "API access", "Email support"],
      team: ["Unlimited projects", "API access", "Priority support", "SSO"],
    }}
    highlighted="pro"
  />
</BillingProvider>

// Checkout page
<EmbeddedCheckout
  planId="pro"
  interval="yearly"
  successUrl="/billing/success"
  cancelUrl="/pricing"
/>

// Success page
<CheckoutSuccess redirectUrl="/dashboard" />
```

## Edge Cases & Error States

- **Stripe.js fails to load:** `<EmbeddedCheckout>` shall show an error message with a retry button.
- **Session creation fails:** Display a user-friendly error (not the raw Stripe error) with a "try again" option.
- **User already subscribed:** CTA should not initiate a new checkout; should show "Current Plan" or route to plan change flow (Phase 3).
- **No plans configured:** `<PricingTable>` shall render an empty state with a message (dev-facing, not user-facing).
- **Free plan display:** If a free tier is configured, show it as the first card with a "Free" price and "Get Started" CTA (links to sign-up).

## Dependencies

- **@context-kit/billing** — peer dependency for plan data and checkout session creation
- **@stripe/react-stripe-js** + **@stripe/stripe-js** — for embedded checkout
- **react** (`>=18.0.0`) — peer dependency
- **next** (`>=14.0.0`) — peer dependency
- Same UI primitives stack as `@context-kit/auth-ui` (Radix, CVA, clsx, tailwind-merge, lucide-react)

## Risks & Open Questions

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Stripe embedded checkout limitations | Low | Can't customize payment form | Stripe's embedded checkout is feature-rich; fallback to hosted if needed |
| Pricing page design doesn't fit all apps | Medium | Consumers override heavily | Make every visual aspect overridable via className + CSS vars |

### Resolved Questions

- [x] **Plan data source:** Context + prop overrides. `<PricingTable>` reads plans from `<BillingProvider>` by default but accepts props to override/extend (feature lists, ordering, etc.).
- [x] **Feature lists:** UI-only props. Feature descriptions are presentation/marketing copy, passed to `<PricingTable>` or `<PricingCard>` as props. Keeps billing config focused on Stripe/caps.
- [x] **Page components:** Yes, like auth-ui. Include `<PricingPage>` and `<CheckoutPage>` page-level components for drop-in route usage. Consumers can use them as-is or build custom layouts with the primitives.
- [x] **Stripe provider:** `<BillingProvider>` handles it. Pass `stripePublishableKey` to `<BillingProvider>`, which internally wraps children in Stripe's Elements provider when needed. One provider to configure.
