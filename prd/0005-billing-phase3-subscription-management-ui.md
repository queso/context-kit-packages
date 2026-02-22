# PRD-0005: @context-kit/billing-ui — Phase 3: Subscription Management UI

**Author:** Josh
**Date:** 2026-02-22
**Status:** Draft
**Package:** `@context-kit/billing-ui`
**Depends on:** PRD-0003 (`@context-kit/billing`), PRD-0004 (`@context-kit/billing-ui` Phase 2)

## Problem Statement

After a user subscribes (Phase 2), they need a place to manage their subscription: see what plan they're on, understand their usage against caps, upgrade or downgrade, cancel, and review past invoices. Every SaaS app builds this "account billing" page, and it's always the same set of components wired to the same Stripe data. Without this, developers either skip subscription management entirely (forcing users to email support for plan changes) or spend days building it.

## Business Context

Self-serve subscription management directly reduces churn and support burden. Users who can easily upgrade generate more revenue; users who can see their usage are less surprised by limits; users who can cancel without emailing support have a better experience (and are more likely to come back). This is the final piece that makes context-kit billing production-ready.

## Goals & Success Metrics

| Goal | Metric | Target |
|------|--------|--------|
| Self-serve plan changes | % of plan changes via UI vs support | >95% |
| Transparent usage | Users can see usage vs caps for all features | Real-time accuracy |
| Complete billing portal | All billing actions available without leaving the app | Zero Stripe portal redirects needed |

## User Stories

- **As a** SaaS user, **I want** to see my current plan and subscription status **so that** I know what I'm paying for.
- **As a** SaaS user, **I want** to see my usage against plan limits **so that** I know when I'm approaching caps.
- **As a** SaaS user, **I want** to upgrade my plan **so that** I can access more features or higher limits.
- **As a** SaaS user, **I want** to downgrade my plan **so that** I can reduce my costs.
- **As a** SaaS user, **I want** to cancel my subscription **so that** I stop being charged.
- **As a** SaaS user, **I want** to reactivate a canceled subscription before the period ends **so that** I don't lose access.
- **As a** SaaS user, **I want** to see my past invoices and charges **so that** I can track my spending or submit expense reports.
- **As a** context-kit developer, **I want** all of these as drop-in components **so that** I don't build them from scratch.

## Scope

### In Scope

- `<SubscriptionStatus>` — shows current plan, status (active, trialing, past_due, canceling), next billing date, amount
- `<UsageDashboard>` — displays usage vs caps for each feature as progress bars, with warning state when approaching limit
- `<PlanChanger>` — upgrade/downgrade flow: shows available plans, proration preview (what they'll pay/be credited), confirm button
- `<CancelSubscription>` — cancel flow with confirmation dialog, shows what they'll lose, cancel-at-period-end by default with immediate cancel option
- `<ReactivateSubscription>` — reactivate button for subscriptions set to cancel at period end
- `<InvoiceHistory>` — table of past invoices fetched from Stripe: date, amount, status, PDF download link
- `<BillingPage>` — page-level component that composes all of the above into a complete billing settings page
- Proration preview: before confirming a plan change, show the user what they'll be charged or credited

### Out of Scope

- **Payment method management** (update card, add backup) — consumers use Stripe's customer portal link or a future phase
- **Seat management UI** (add/remove team members) — planned for a future org/team phase
- **Dunning/failed payment recovery UI** — consumers configure Stripe's built-in dunning emails; a "payment failed" banner is in scope but recovery flow is not
- **Refund processing** — admin-only, not self-serve
- **Pages Router support** — App Router only

## Requirements

### Functional Requirements

1. `<SubscriptionStatus>` shall display: plan name, monthly/yearly indicator, price, status badge (active/trialing/past_due/canceling), next billing date, and "cancel at period end" notice if applicable.
2. `<SubscriptionStatus>` shall show a "payment failed" warning banner when status is `past_due`, with a link to update payment method (Stripe customer portal URL).
3. `<UsageDashboard>` shall render a card per feature with usage caps, showing: feature name, progress bar (used/limit), numerical count, and a warning color when usage exceeds 80% of the limit.
4. `<UsageDashboard>` shall handle features with no cap (unlimited) by showing usage count without a progress bar.
5. `<UsageDashboard>` shall show the current billing period dates.
6. `<PlanChanger>` shall display available plans (excluding the current plan) with pricing and a "Switch to [Plan]" button.
7. Before confirming a plan change, `<PlanChanger>` shall fetch and display a proration preview: the amount to be charged or credited, and the effective date.
8. `<PlanChanger>` shall label plan changes as "Upgrade" or "Downgrade" based on plan ordering (configurable).
9. After a successful plan change, `<PlanChanger>` shall show a success message and update the displayed subscription status.
10. `<CancelSubscription>` shall show a confirmation dialog explaining: when access ends (period end date), what features they'll lose, and a final confirm button.
11. `<CancelSubscription>` shall default to cancel-at-period-end. An "immediate cancellation" option shall be available but clearly marked as losing remaining access.
12. After cancellation, `<SubscriptionStatus>` shall show "Cancels on [date]" with a reactivate option.
13. `<ReactivateSubscription>` shall undo a pending cancellation with a single click and confirmation.
14. `<InvoiceHistory>` shall display a paginated table with columns: date, description, amount, status (paid/open/void), and a PDF download link.
15. `<InvoiceHistory>` shall fetch invoices from Stripe via the billing backend (not client-side Stripe calls).
16. `<BillingPage>` shall compose all components into a single page layout with sections: Subscription Status, Usage, Plan Management, Invoice History.
17. All components shall accept `className` props and use CSS variables for theming, consistent with Phase 2 and `@context-kit/auth-ui`.

### Non-Functional Requirements

1. Plan change and cancellation operations shall include loading states and disable buttons during API calls to prevent double-submission.
2. All destructive actions (cancel, immediate cancel, downgrade) shall require explicit confirmation.
3. Invoice data shall be fetched on-demand (not preloaded) to avoid slow page loads.
4. Components shall be accessible: confirmation dialogs shall trap focus, status badges shall have aria-labels, progress bars shall use `role="progressbar"` with aria attributes.

## Component API Sketches

```tsx
// Full billing page (drop-in route component)
<BillingProvider billing={billing} userId={user.id}>
  <BillingPage />
</BillingProvider>

// Or compose individual sections
<BillingProvider billing={billing} userId={user.id}>
  <SubscriptionStatus />
  <UsageDashboard />
  <PlanChanger
    planOrder={["free", "pro", "team"]}
    features={{
      pro: ["10 projects", "API access", "Email support"],
      team: ["Unlimited projects", "Priority support", "SSO"],
    }}
  />
  <InvoiceHistory pageSize={10} />
  <CancelSubscription />
</BillingProvider>
```

## Edge Cases & Error States

- **No subscription (free tier):** `<SubscriptionStatus>` shows "Free Plan" with an upgrade CTA. `<CancelSubscription>` is hidden. `<InvoiceHistory>` shows empty state.
- **Subscription past_due:** `<PlanChanger>` is disabled with a message to resolve payment first. `<CancelSubscription>` remains available.
- **Plan change fails (Stripe error):** Show error message in the dialog, keep it open for retry.
- **Invoice PDF not available:** Show "Pending" instead of download link for recent invoices.
- **Usage data stale:** `<UsageDashboard>` shall show the last-fetched timestamp and a refresh button.
- **Proration preview fails:** Show a warning that the preview couldn't be loaded but allow the user to proceed (with a "price may vary" notice).
- **Downgrade would exceed new plan's caps:** Show a warning listing which features would be over-limit on the new plan.

## Dependencies

- **@context-kit/billing** — peer dependency for subscription management APIs
- **@context-kit/billing-ui** (Phase 2 components) — reuses `<BillingProvider>`, `<PricingCard>`, theming system
- **react** (`>=18.0.0`) — peer dependency
- **next** (`>=14.0.0`) — peer dependency
- Same UI primitives as Phase 2 (Radix, CVA, clsx, tailwind-merge, lucide-react)

## Risks & Open Questions

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Proration preview complexity | Medium | Confusing numbers for users | Show clear "you'll pay X today" / "you'll be credited X" language |
| Invoice pagination performance | Low | Slow for heavy Stripe usage | Paginate, lazy-load, cache on the backend |
| Plan change race conditions | Low | Stale UI after plan change | Optimistic update + webhook-driven reconciliation |

### Resolved Questions

- [x] **Payment method management:** Stripe portal link. Show a "Manage payment method" link that opens Stripe's hosted customer portal. Zero PCI scope, always up to date, minimal code.
- [x] **Downgrade cap enforcement:** Warn but allow. Show a warning listing which features are over-limit on the new plan, but let the user proceed — they'll need to reduce usage before the next period.
- [x] **Invoice display:** Stripe-hosted links. Show a summary table (date, amount, status) with links to Stripe's hosted invoice page for details/PDF. Simple and always accurate.
- [x] **Retention offer:** Yes, suggest downgrade. Before confirming cancellation, show "Would you rather switch to [lower plan]?" with pricing. Simple retention that catches impulse cancellations.
- [x] **Usage data refresh:** Page load + manual refresh. Show a last-fetched timestamp and a refresh button. No polling — keeps it simple and avoids unnecessary API calls.
