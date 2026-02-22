"use client";

import * as React from "react";
import { AuthGuard } from "../auth-guard";
import {
  SessionManagement,
  type SessionManagementProps,
} from "../session-management";
import { PageLayout } from "./page-layout";

export type SessionManagementPageProps = SessionManagementProps & {
  className?: string;
};

export function SessionManagementPage({
  className,
  ...props
}: SessionManagementPageProps) {
  return (
    <PageLayout className={className}>
      <AuthGuard>
        <SessionManagement {...props} />
      </AuthGuard>
    </PageLayout>
  );
}
SessionManagementPage.displayName = "SessionManagementPage";
