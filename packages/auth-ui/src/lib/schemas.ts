import { z } from "zod";

// ---------------------------------------------------------------------------
// ForgotPassword schema
// ---------------------------------------------------------------------------

export const forgotPasswordSchema = z.object({
  email: z.string().min(1, "Email is required").email("Please enter a valid email address"),
});

export type ForgotPasswordFormValues = z.infer<typeof forgotPasswordSchema>;

// ---------------------------------------------------------------------------
// ResetPassword schema (factory accepting password rules)
// ---------------------------------------------------------------------------

export type PasswordRules = {
  minLength?: number;
  maxLength?: number;
};

export function resetPasswordSchema({ minLength = 8, maxLength = 128 }: PasswordRules = {}) {
  return z
    .object({
      password: z
        .string()
        .min(1, "Password is required")
        .min(minLength, `Password must be at least ${minLength} characters`)
        .max(maxLength, `Password must be at most ${maxLength} characters`),
      confirmPassword: z.string().min(1, "Please confirm your password"),
    })
    .refine((data) => data.password === data.confirmPassword, {
      message: "Passwords do not match",
      path: ["confirmPassword"],
    });
}

export type ResetPasswordFormValues = {
  password: string;
  confirmPassword: string;
};

// ---------------------------------------------------------------------------
// ChangePassword schema (factory accepting password rules)
// ---------------------------------------------------------------------------

export function changePasswordSchema({ minLength = 8, maxLength = 128 }: PasswordRules = {}) {
  return z
    .object({
      currentPassword: z.string().min(1, "Current password is required"),
      newPassword: z
        .string()
        .min(1, "New password is required")
        .min(minLength, `Password must be at least ${minLength} characters`)
        .max(maxLength, `Password must be at most ${maxLength} characters`),
      confirmNewPassword: z.string().min(1, "Please confirm your new password"),
    })
    .refine((data) => data.newPassword === data.confirmNewPassword, {
      message: "Passwords do not match",
      path: ["confirmNewPassword"],
    })
    .refine((data) => data.newPassword !== data.currentPassword, {
      message: "New password must be different from current password",
      path: ["newPassword"],
    });
}

export type ChangePasswordFormValues = {
  currentPassword: string;
  newPassword: string;
  confirmNewPassword: string;
};

// ---------------------------------------------------------------------------
// SignIn schema
// ---------------------------------------------------------------------------

export const signInSchema = z.object({
  email: z.string().min(1, "Email is required").email("Please enter a valid email address"),
  password: z.string().min(1, "Password is required"),
});

export type SignInFormValues = z.infer<typeof signInSchema>;

// ---------------------------------------------------------------------------
// SignUp schema (factory accepting password rules)
// ---------------------------------------------------------------------------

export function signUpSchema({ minLength = 8, maxLength = 128 }: PasswordRules = {}) {
  return z
    .object({
      name: z.string().min(1, "Name is required"),
      email: z.string().min(1, "Email is required").email("Please enter a valid email address"),
      password: z
        .string()
        .min(1, "Password is required")
        .min(minLength, `Password must be at least ${minLength} characters`)
        .max(maxLength, `Password must be at most ${maxLength} characters`),
      confirmPassword: z.string().min(1, "Please confirm your password"),
    })
    .refine((data) => data.password === data.confirmPassword, {
      message: "Passwords do not match",
      path: ["confirmPassword"],
    });
}

export type SignUpFormValues = {
  name: string;
  email: string;
  password: string;
  confirmPassword: string;
};
