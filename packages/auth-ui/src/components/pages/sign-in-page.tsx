"use client";

import * as React from "react";
import { SignIn, type SignInProps } from "../sign-in";
import { PageLayout } from "./page-layout";

export type SignInPageProps = SignInProps & {
  className?: string;
};

export function SignInPage({ className, ...props }: SignInPageProps) {
  return (
    <PageLayout className={className}>
      <SignIn {...props} />
    </PageLayout>
  );
}
SignInPage.displayName = "SignInPage";
