"use client";

import * as React from "react";
import { ForgotPassword, type ForgotPasswordProps } from "../forgot-password";
import { PageLayout } from "./page-layout";

export type ForgotPasswordPageProps = ForgotPasswordProps & {
  className?: string;
};

export function ForgotPasswordPage({
  className,
  ...props
}: ForgotPasswordPageProps) {
  return (
    <PageLayout className={className}>
      <ForgotPassword {...props} />
    </PageLayout>
  );
}
ForgotPasswordPage.displayName = "ForgotPasswordPage";
