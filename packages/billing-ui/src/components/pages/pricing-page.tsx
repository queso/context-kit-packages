"use client";

import type { PricingPageProps } from "../../types.js";
import { BillingProvider } from "../billing-provider.js";
import { PricingTable } from "../pricing-table.js";
import { PageLayout } from "./page-layout.js";

export function PricingPage({
  plans,
  currentSubscription,
  isAuthenticated,
  features,
  prices,
  onSelectPlan,
  highlighted,
  signInPath,
  className,
}: PricingPageProps) {
  return (
    <PageLayout className={className}>
      <BillingProvider
        plans={plans}
        currentSubscription={currentSubscription}
        isAuthenticated={isAuthenticated ?? currentSubscription != null}
      >
        <PricingTable
          features={features}
          prices={prices}
          onSelectPlan={onSelectPlan}
          highlighted={highlighted}
          signInPath={signInPath}
        />
      </BillingProvider>
    </PageLayout>
  );
}
PricingPage.displayName = "PricingPage";
