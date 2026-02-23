# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [0.1.0] - 2026-02-23

### Added

- `BillingProvider` context provider accepting serialized plan/subscription data
- `useBilling` hook to access billing context (plans, current subscription, interval state)
- `IntervalToggle` component for monthly/yearly billing interval with savings badge
- `PricingCard` component displaying plan name, price, feature list, and smart CTA logic (Get Started, Upgrade, Downgrade, Current Plan)
- `PricingTable` responsive grid of `PricingCard` components with automatic interval toggle
- `EmbeddedCheckout` Stripe embedded checkout wrapper with loading/error states and retry
- `CheckoutSuccess` post-checkout confirmation with plan name and redirect
- `PricingPage`, `CheckoutPage`, `CheckoutSuccessPage` drop-in page-level wrappers
- Dual entry points: `@context-kit/billing-ui` (server-safe types and page components) and `@context-kit/billing-ui/client` (interactive client components)
- CSS variable theming with `--billing-*` custom properties and sensible defaults
- `className` prop on every component for Tailwind CSS overrides
- ESM-only build via tsup with source maps and declaration files
- 69 tests across 10 test files covering all components, hooks, types, and exports
