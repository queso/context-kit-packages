"use client";

import * as React from "react";
import { AuthGuard } from "../auth-guard";
import { ChangePassword, type ChangePasswordProps } from "../change-password";
import { PageLayout } from "./page-layout";

export type ChangePasswordPageProps = ChangePasswordProps & {
  className?: string;
};

export function ChangePasswordPage({
  className,
  ...props
}: ChangePasswordPageProps) {
  return (
    <PageLayout className={className}>
      <AuthGuard>
        <ChangePassword {...props} />
      </AuthGuard>
    </PageLayout>
  );
}
ChangePasswordPage.displayName = "ChangePasswordPage";
