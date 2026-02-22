"use client";

import type * as React from "react";
import {
  ChangePasswordPage,
  type ChangePasswordPageProps,
} from "./pages/change-password-page";
import {
  ForgotPasswordPage,
  type ForgotPasswordPageProps,
} from "./pages/forgot-password-page";
import {
  ResetPasswordPage,
  type ResetPasswordPageProps,
} from "./pages/reset-password-page";
import {
  SessionManagementPage,
  type SessionManagementPageProps,
} from "./pages/session-management-page";
import { SignInPage, type SignInPageProps } from "./pages/sign-in-page";
import { SignUpPage, type SignUpPageProps } from "./pages/sign-up-page";
import {
  UserProfilePage,
  type UserProfilePageProps,
} from "./pages/user-profile-page";

/**
 * Identifies which page component to render.
 * Used as values in the pathMap prop to map custom URL paths to components.
 */
type ComponentKey =
  | "signIn"
  | "signUp"
  | "forgotPassword"
  | "resetPassword"
  | "userProfile"
  | "changePassword"
  | "sessionManagement";

/** Maps a URL path (with leading slash) to a component key. */
type PathMap = Record<string, ComponentKey>;

export type AuthRouterProps = {
  params: { authPath: string[] };
  pathMap?: PathMap;
  className?: string;
  signInProps?: Omit<SignInPageProps, "className">;
  signUpProps?: Omit<SignUpPageProps, "className">;
  forgotPasswordProps?: Omit<ForgotPasswordPageProps, "className">;
  resetPasswordProps?: Omit<ResetPasswordPageProps, "className">;
  userProfileProps?: Omit<UserProfilePageProps, "className">;
  changePasswordProps?: Omit<ChangePasswordPageProps, "className">;
  sessionManagementProps?: Omit<SessionManagementPageProps, "className">;
};

const DEFAULT_PATH_MAP: PathMap = {
  "/sign-in": "signIn",
  "/sign-up": "signUp",
  "/forgot-password": "forgotPassword",
  "/reset-password": "resetPassword",
  "/profile": "userProfile",
  "/profile/password": "changePassword",
  "/profile/sessions": "sessionManagement",
};

function NotFoundPage() {
  return (
    <div>
      <h1>Page not found</h1>
      <a href="/sign-in">Go to sign in</a>
    </div>
  );
}

export function AuthRouter({
  params,
  pathMap,
  className,
  signInProps,
  signUpProps,
  forgotPasswordProps,
  resetPasswordProps,
  userProfileProps,
  changePasswordProps,
  sessionManagementProps,
}: AuthRouterProps) {
  const mergedPathMap: PathMap = { ...DEFAULT_PATH_MAP, ...pathMap };
  const pathSegment =
    params.authPath.length > 0 ? "/" + params.authPath.join("/") : "";
  const componentKey = mergedPathMap[pathSegment];

  const page = renderPage(componentKey, {
    signInProps,
    signUpProps,
    forgotPasswordProps,
    resetPasswordProps,
    userProfileProps,
    changePasswordProps,
    sessionManagementProps,
  });

  return <div className={className}>{page}</div>;
}
AuthRouter.displayName = "AuthRouter";

function renderPage(
  componentKey: ComponentKey | undefined,
  props: {
    signInProps?: Omit<SignInPageProps, "className">;
    signUpProps?: Omit<SignUpPageProps, "className">;
    forgotPasswordProps?: Omit<ForgotPasswordPageProps, "className">;
    resetPasswordProps?: Omit<ResetPasswordPageProps, "className">;
    userProfileProps?: Omit<UserProfilePageProps, "className">;
    changePasswordProps?: Omit<ChangePasswordPageProps, "className">;
    sessionManagementProps?: Omit<SessionManagementPageProps, "className">;
  }
): React.ReactElement {
  switch (componentKey) {
    case "signIn":
      return <SignInPage {...props.signInProps} />;
    case "signUp":
      return <SignUpPage {...props.signUpProps} />;
    case "forgotPassword":
      return <ForgotPasswordPage {...props.forgotPasswordProps} />;
    case "resetPassword":
      return <ResetPasswordPage {...props.resetPasswordProps} />;
    case "userProfile":
      return <UserProfilePage {...props.userProfileProps} />;
    case "changePassword":
      return <ChangePasswordPage {...props.changePasswordProps} />;
    case "sessionManagement":
      return <SessionManagementPage {...props.sessionManagementProps} />;
    default:
      return <NotFoundPage />;
  }
}
