"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useSearchParams } from "next/navigation";
import { useAuthContext } from "./auth-provider";
import { resetPasswordSchema, type PasswordRules, type ResetPasswordFormValues } from "../lib/schemas";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

export type ResetPasswordProps = {
  passwordRules?: PasswordRules;
  className?: string;
  classNames?: {
    card?: string;
    title?: string;
    form?: string;
    input?: string;
    button?: string;
  };
};

export function ResetPassword({ passwordRules, className, classNames }: ResetPasswordProps) {
  const { client } = useAuthContext();
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  const [succeeded, setSucceeded] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);

  const schema = React.useMemo(
    () => resetPasswordSchema(passwordRules ?? {}),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [passwordRules?.minLength, passwordRules?.maxLength]
  );

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ResetPasswordFormValues>({
    resolver: zodResolver(schema),
  });

  // Show an error immediately if the token is missing
  if (!token) {
    return (
      <div className={cn("w-full max-w-md", className, classNames?.card)}>
        <p role="alert">
          This link has expired or the token is missing. Request a new one.
        </p>
        <a href="/forgot-password">Request a new link</a>
      </div>
    );
  }

  const onSubmit = async (values: ResetPasswordFormValues) => {
    setServerError(null);
    try {
      const result = await (client as Record<string, Function>).resetPassword({
        token,
        newPassword: values.password,
      });

      if (result?.error) {
        setServerError("This link has expired. Request a new one.");
        return;
      }

      setSucceeded(true);
    } catch {
      setServerError("Something went wrong. Please try again.");
    }
  };

  if (succeeded) {
    return (
      <div className={cn("w-full max-w-md", className, classNames?.card)}>
        <p>Your password has been reset successfully.</p>
        <a href="/sign-in">Sign in with your new password</a>
      </div>
    );
  }

  return (
    <div className={cn("w-full max-w-md", className, classNames?.card)}>
      <h1 className={classNames?.title}>Set a new password</h1>

      {serverError && (
        <p role="alert" className="text-destructive text-sm">
          {serverError}
        </p>
      )}

      <form
        onSubmit={handleSubmit(onSubmit)}
        className={classNames?.form}
        noValidate
      >
        <div className="space-y-2">
          <Label htmlFor="reset-password">New password</Label>
          <Input
            id="reset-password"
            type="password"
            autoComplete="new-password"
            aria-invalid={!!errors.password}
            className={classNames?.input}
            {...register("password")}
          />
          {errors.password && (
            <p role="alert" className="text-destructive text-sm">
              {errors.password.message}
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="reset-confirm-password">Confirm password</Label>
          <Input
            id="reset-confirm-password"
            type="password"
            autoComplete="new-password"
            aria-invalid={!!errors.confirmPassword}
            className={classNames?.input}
            {...register("confirmPassword")}
          />
          {errors.confirmPassword && (
            <p role="alert" className="text-destructive text-sm">
              {errors.confirmPassword.message}
            </p>
          )}
        </div>

        <Button
          type="submit"
          disabled={isSubmitting}
          aria-disabled={isSubmitting}
          className={cn("w-full", classNames?.button)}
        >
          {isSubmitting ? "Resetting…" : "Reset password"}
        </Button>
      </form>
    </div>
  );
}
ResetPassword.displayName = "ResetPassword";
