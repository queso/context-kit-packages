"use client";

import * as React from "react";
import { UserProfile, type UserProfileProps } from "../user-profile";
import { AuthGuard } from "../auth-guard";
import { PageLayout } from "./page-layout";

export type UserProfilePageProps = UserProfileProps & {
  className?: string;
};

export function UserProfilePage({ className, ...props }: UserProfilePageProps) {
  return (
    <PageLayout className={className}>
      <AuthGuard>
        <div>
          <h2>Profile</h2>
          <UserProfile {...props} />
        </div>
      </AuthGuard>
    </PageLayout>
  );
}
UserProfilePage.displayName = "UserProfilePage";
