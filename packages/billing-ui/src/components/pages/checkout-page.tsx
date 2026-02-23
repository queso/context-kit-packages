"use client";

import type { CheckoutPageProps } from "../../types.js";
import { EmbeddedCheckout } from "../embedded-checkout.js";
import { PageLayout } from "./page-layout.js";

export function CheckoutPage({
  fetchClientSecret,
  stripePublishableKey,
  returnUrl,
  className,
}: CheckoutPageProps) {
  return (
    <PageLayout className={className}>
      <EmbeddedCheckout
        fetchClientSecret={fetchClientSecret}
        stripePublishableKey={stripePublishableKey}
        returnUrl={returnUrl}
      />
    </PageLayout>
  );
}
CheckoutPage.displayName = "CheckoutPage";
