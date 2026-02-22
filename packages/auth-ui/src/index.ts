// @context-kit/auth-ui main entry point

export { AuthGuard } from "./components/auth-guard";
// Router
export { AuthRouter } from "./components/auth-router";
export { ChangePassword } from "./components/change-password";
export { ForgotPassword } from "./components/forgot-password";
export { ChangePasswordPage } from "./components/pages/change-password-page";
export { ForgotPasswordPage } from "./components/pages/forgot-password-page";
export { ResetPasswordPage } from "./components/pages/reset-password-page";
export { SessionManagementPage } from "./components/pages/session-management-page";
// Page components
export { SignInPage } from "./components/pages/sign-in-page";
export { SignUpPage } from "./components/pages/sign-up-page";
export { UserProfilePage } from "./components/pages/user-profile-page";
export { ResetPassword } from "./components/reset-password";
export { SessionManagement } from "./components/session-management";
// Form components
export { SignIn } from "./components/sign-in";
export { SignUp } from "./components/sign-up";
export { SocialButton } from "./components/social-button";
// Utility components
export { UserButton } from "./components/user-button";
export { UserProfile } from "./components/user-profile";

// Types
export type { AuthClient, AuthUIContextValue, SessionData } from "./types";
