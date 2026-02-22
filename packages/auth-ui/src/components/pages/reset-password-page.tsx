"use client";

import * as React from "react";
import { ResetPassword, type ResetPasswordProps } from "../reset-password";
import { PageLayout } from "./page-layout";

export type ResetPasswordPageProps = ResetPasswordProps & {
  className?: string;
};

export function ResetPasswordPage({ className, ...props }: ResetPasswordPageProps) {
  return (
    <PageLayout className={className}>
      <ResetPassword {...props} />
    </PageLayout>
  );
}
ResetPasswordPage.displayName = "ResetPasswordPage";
