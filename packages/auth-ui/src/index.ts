// @context-kit/auth-ui main entry point

// Form components
export { SignIn } from "./components/sign-in";
export { SignUp } from "./components/sign-up";
export { ForgotPassword } from "./components/forgot-password";
export { ResetPassword } from "./components/reset-password";
export { UserProfile } from "./components/user-profile";
export { ChangePassword } from "./components/change-password";
export { SessionManagement } from "./components/session-management";

// Utility components
export { UserButton } from "./components/user-button";
export { AuthGuard } from "./components/auth-guard";
export { SocialButton } from "./components/social-button";

// Router
export { AuthRouter } from "./components/auth-router";

// Page components
export { SignInPage } from "./components/pages/sign-in-page";
export { SignUpPage } from "./components/pages/sign-up-page";
export { ForgotPasswordPage } from "./components/pages/forgot-password-page";
export { ResetPasswordPage } from "./components/pages/reset-password-page";
export { UserProfilePage } from "./components/pages/user-profile-page";
export { ChangePasswordPage } from "./components/pages/change-password-page";
export { SessionManagementPage } from "./components/pages/session-management-page";

// Types
export type { AuthUIContextValue, AuthClient, SessionData } from "./types";
