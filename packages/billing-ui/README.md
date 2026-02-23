# @context-kit/billing-ui

React UI components for SaaS pricing pages and Stripe embedded checkout, designed for Next.js App Router. Powered by `@context-kit/billing`.

## Installation

```bash
bun add @context-kit/billing-ui
# or
pnpm add @context-kit/billing-ui
# or
npm install @context-kit/billing-ui
```

### Peer Dependencies

- `react` >= 18
- `next` >= 14
- `@context-kit/billing` >= 0.1.0
- `@stripe/react-stripe-js` >= 3.0.0

## Quick Start

### 1. Set Up the Pricing Page

The fastest way to add a pricing page is with the `PricingPage` drop-in component:

```tsx
// app/pricing/page.tsx
"use client";

import { PricingPage } from "@context-kit/billing-ui/client";

const plans = [
  { id: "free", name: "Free", isFree: true },
  { id: "pro", name: "Pro" },
  { id: "enterprise", name: "Enterprise" },
];

const prices = {
  free: { monthly: 0 },
  pro: { monthly: 29, yearly: 290 },
  enterprise: { monthly: 99, yearly: 990 },
};

const features = {
  free: ["5 projects", "Basic support"],
  pro: ["Unlimited projects", "Priority support", "API access"],
  enterprise: ["Everything in Pro", "SSO", "Dedicated support"],
};

export default function Pricing() {
  return (
    <PricingPage
      plans={plans}
      prices={prices}
      features={features}
      highlighted="pro"
      onSelectPlan={(planId, interval) => {
        // Navigate to checkout or call your server action
        console.log(`Selected ${planId} (${interval})`);
      }}
    />
  );
}
```

### 2. Add Stripe Checkout

```tsx
// app/checkout/page.tsx
"use client";

import { CheckoutPage } from "@context-kit/billing-ui/client";

export default function Checkout() {
  return (
    <CheckoutPage
      stripePublishableKey={process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!}
      fetchClientSecret={async () => {
        const res = await fetch("/api/checkout", { method: "POST" });
        const { clientSecret } = await res.json();
        return clientSecret;
      }}
      returnUrl="/checkout/success"
    />
  );
}
```

### 3. Add Checkout Success

```tsx
// app/checkout/success/page.tsx
import { CheckoutSuccessPage } from "@context-kit/billing-ui";

export default function Success() {
  return <CheckoutSuccessPage redirectUrl="/dashboard" planName="Pro" />;
}
```

## Components

### Context & Hooks

| Export | Description |
|--------|-------------|
| `BillingProvider` | React context provider accepting `plans` and optional `currentSubscription` |
| `useBilling()` | Hook returning billing context: plans, current plan, subscription status, interval state |

```tsx
import { BillingProvider, useBilling } from "@context-kit/billing-ui/client";
```

### Pricing Components

| Component | Description |
|-----------|-------------|
| `PricingTable` | Responsive grid of `PricingCard` components with automatic interval toggle |
| `PricingCard` | Individual plan card with price, feature list, and smart CTA button |
| `IntervalToggle` | Monthly/Yearly toggle with optional savings percentage badge |

### Checkout Components

| Component | Description |
|-----------|-------------|
| `EmbeddedCheckout` | Stripe embedded checkout wrapper with loading, error, and retry states |
| `CheckoutSuccess` | Post-checkout confirmation with plan name and redirect link |

### Page Components

Pre-wrapped versions of the above in a centered layout. Useful as drop-in page components:

| Component | Description |
|-----------|-------------|
| `PricingPage` | Full pricing page with `BillingProvider` + `PricingTable` |
| `CheckoutPage` | Checkout page wrapping `EmbeddedCheckout` |
| `CheckoutSuccessPage` | Success page wrapping `CheckoutSuccess` |

## Component Props

### BillingProvider

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `plans` | `PlanDefinition[]` | Yes | Array of plan definitions |
| `currentSubscription` | `SubscriptionData \| null` | No | Current user subscription data |
| `children` | `ReactNode` | Yes | Child components |

### PricingTable

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `features` | `Record<string, string[]>` | Yes | Feature lists keyed by plan ID |
| `prices` | `PlanPricing` | Yes | Price data keyed by plan ID (`{ monthly?, yearly?, currency? }`) |
| `highlighted` | `string` | No | Plan ID to highlight as "Recommended" |
| `onSelectPlan` | `(planId, interval) => void` | Yes | Callback when a plan is selected |
| `signInPath` | `string` | No | Redirect path for unauthenticated users |
| `className` | `string` | No | Additional CSS classes |

### PricingCard

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `plan` | `PlanDefinition` | Yes | Plan definition object |
| `features` | `string[]` | No | Feature list for this plan |
| `price` | `number` | Yes | Monthly price |
| `yearlyPrice` | `number` | No | Yearly price (shown when interval is "yearly") |
| `currency` | `string` | No | Currency code (default: `"USD"`) |
| `highlighted` | `boolean` | No | Show "Recommended" badge |
| `isCurrent` | `boolean` | No | Disable CTA and show "Current Plan" |
| `interval` | `"monthly" \| "yearly"` | Yes | Current billing interval |
| `onSelectPlan` | `(planId, interval) => void` | No | Callback when plan is selected |
| `signInPath` | `string` | No | Redirect for unauthenticated users |
| `isAuthenticated` | `boolean` | No | Whether the user is signed in |
| `currentPlanOrder` | `number` | No | Index of the user's current plan (for Upgrade/Downgrade logic) |
| `planOrder` | `number` | No | Index of this plan (for Upgrade/Downgrade logic) |
| `className` | `string` | No | Additional CSS classes |

### IntervalToggle

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `interval` | `"monthly" \| "yearly"` | Yes | Current billing interval |
| `onIntervalChange` | `(interval) => void` | Yes | Callback when interval changes |
| `savingsPercentage` | `number` | No | Percentage to show in the savings badge |
| `className` | `string` | No | Additional CSS classes |

### EmbeddedCheckout

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `fetchClientSecret` | `() => Promise<string>` | Yes | Async function returning a Stripe client secret |
| `stripePublishableKey` | `string` | Yes | Stripe publishable key |
| `returnUrl` | `string` | No | URL to redirect to after checkout |
| `className` | `string` | No | Additional CSS classes |

### CheckoutSuccess

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `redirectUrl` | `string` | Yes | Where to send the user after confirmation |
| `planName` | `string` | No | Name of the plan to display in the message |
| `className` | `string` | No | Additional CSS classes |

## Theming

All components use CSS custom properties with `--billing-*` prefixes and sensible defaults. Override them in your global CSS to match your design system:

```css
:root {
  /* Card */
  --billing-card-bg: #ffffff;
  --billing-card-border: #e2e8f0;
  --billing-card-heading: #0f172a;
  --billing-card-price: #0f172a;
  --billing-card-price-suffix: #64748b;
  --billing-card-feature: #475569;
  --billing-card-highlighted-border: #6366f1;
  --billing-card-highlighted-ring: #6366f1;

  /* CTA buttons */
  --billing-cta-bg: #6366f1;
  --billing-cta-text: #ffffff;
  --billing-cta-hover-bg: #4f46e5;
  --billing-cta-disabled-bg: #f1f5f9;
  --billing-cta-disabled-text: #94a3b8;

  /* Interval toggle */
  --billing-toggle-bg: #f8fafc;
  --billing-toggle-border: #e2e8f0;
  --billing-toggle-text: #64748b;
  --billing-toggle-hover-text: #0f172a;
  --billing-toggle-active-bg: #ffffff;
  --billing-toggle-active-text: #0f172a;
  --billing-savings-bg: #dcfce7;
  --billing-savings-text: #166534;

  /* Recommended badge */
  --billing-recommended-bg: #6366f1;
  --billing-recommended-text: #ffffff;

  /* Checkout */
  --billing-checkout-bg: #ffffff;
  --billing-checkout-border: #e2e8f0;
  --billing-checkout-spinner-border: #e2e8f0;
  --billing-checkout-spinner-color: #6366f1;
  --billing-checkout-error-bg: #fff5f5;
  --billing-checkout-error-border: #fecaca;
  --billing-checkout-error-text: #dc2626;

  /* Success */
  --billing-success-bg: #f0fdf4;
  --billing-success-border: #bbf7d0;
  --billing-success-heading: #0f172a;
  --billing-success-text: #475569;
  --billing-success-icon-bg: #dcfce7;
  --billing-success-icon-color: #16a34a;
}
```

Every component also accepts a `className` prop for Tailwind CSS utility overrides.

## Entry Points

| Import Path | Contents |
|-------------|----------|
| `@context-kit/billing-ui` | Server-safe exports: page components, `CheckoutSuccess`, types |
| `@context-kit/billing-ui/client` | Client components: `BillingProvider`, `useBilling`, `PricingTable`, `PricingCard`, `IntervalToggle`, `EmbeddedCheckout` |

**Import guidance:**

- Use `@context-kit/billing-ui` in Server Components or when you only need types and page wrappers.
- Use `@context-kit/billing-ui/client` when you need interactive components or the billing context hook.

## License

MIT
