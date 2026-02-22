"use client";

import * as React from "react";
import { SignUp, type SignUpProps } from "../sign-up";
import { PageLayout } from "./page-layout";

export type SignUpPageProps = SignUpProps & {
  className?: string;
};

export function SignUpPage({ className, ...props }: SignUpPageProps) {
  return (
    <PageLayout className={className}>
      <SignUp {...props} />
    </PageLayout>
  );
}
SignUpPage.displayName = "SignUpPage";
