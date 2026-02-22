"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useAuthContext } from "./auth-provider";
import { forgotPasswordSchema, type ForgotPasswordFormValues } from "../lib/schemas";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

export type ForgotPasswordProps = {
  className?: string;
  classNames?: {
    card?: string;
    title?: string;
    form?: string;
    input?: string;
    button?: string;
  };
};

export function ForgotPassword({ className, classNames }: ForgotPasswordProps) {
  const { client } = useAuthContext();
  const [submitted, setSubmitted] = React.useState(false);
  const [networkError, setNetworkError] = React.useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ForgotPasswordFormValues>({
    resolver: zodResolver(forgotPasswordSchema),
  });

  const onSubmit = async (values: ForgotPasswordFormValues) => {
    setNetworkError(null);
    try {
      await (client as Record<string, Function>).forgetPassword({ email: values.email, redirectTo: "/reset-password" });
      // Always show success to prevent email enumeration
      setSubmitted(true);
    } catch {
      setNetworkError("Something went wrong. Please try again.");
    }
  };

  if (submitted) {
    return (
      <div className={cn("w-full max-w-md", className, classNames?.card)}>
        <p>
          If an account exists with that email, we&apos;ve sent a password reset link.
        </p>
        <a href="/sign-in">Back to sign in</a>
      </div>
    );
  }

  return (
    <div className={cn("w-full max-w-md", className, classNames?.card)}>
      <h1 className={classNames?.title}>Reset your password</h1>

      {networkError && (
        <p role="alert" className="text-destructive text-sm">
          {networkError}
        </p>
      )}

      <form
        onSubmit={handleSubmit(onSubmit)}
        className={classNames?.form}
        noValidate
      >
        <div className="space-y-2">
          <Label htmlFor="forgot-email">Email</Label>
          <Input
            id="forgot-email"
            type="email"
            autoComplete="email"
            aria-invalid={!!errors.email}
            className={classNames?.input}
            {...register("email")}
          />
          {errors.email && (
            <p role="alert" className="text-destructive text-sm">
              {errors.email.message}
            </p>
          )}
        </div>

        <Button
          type="submit"
          disabled={isSubmitting}
          aria-disabled={isSubmitting}
          className={cn("w-full", classNames?.button)}
        >
          {isSubmitting ? "Sending…" : "Send reset link"}
        </Button>
      </form>

      <a href="/sign-in">Back to sign in</a>
    </div>
  );
}
ForgotPassword.displayName = "ForgotPassword";
