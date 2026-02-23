"use client";

import type { CheckoutSuccessPageProps } from "../../types.js";
import { CheckoutSuccess } from "../checkout-success.js";
import { PageLayout } from "./page-layout.js";

export function CheckoutSuccessPage({
  redirectUrl,
  planName,
  className,
}: CheckoutSuccessPageProps) {
  return (
    <PageLayout className={className}>
      <CheckoutSuccess redirectUrl={redirectUrl} planName={planName} />
    </PageLayout>
  );
}
CheckoutSuccessPage.displayName = "CheckoutSuccessPage";
