"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import * as React from "react";
import { useForm } from "react-hook-form";
import { useSession } from "../hooks/use-session";
import {
  type ChangePasswordFormValues,
  changePasswordSchema,
  type PasswordRules,
} from "../lib/schemas";
import { cn } from "../lib/utils";
import { useAuthContext } from "./auth-provider";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

export type ChangePasswordProps = {
  className?: string;
  classNames?: {
    card?: string;
    form?: string;
    input?: string;
    submitButton?: string;
  };
  passwordRules?: PasswordRules;
};

export function ChangePassword({
  className,
  classNames,
  passwordRules,
}: ChangePasswordProps) {
  const { client } = useAuthContext();
  const { data, isPending } = useSession();
  const router = useRouter();

  const user = data?.user;

  const [successMessage, setSuccessMessage] = React.useState<string | null>(
    null
  );
  const [serverError, setServerError] = React.useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ChangePasswordFormValues>({
    resolver: zodResolver(changePasswordSchema(passwordRules)),
  });

  // Redirect to sign-in if no session (and not loading)
  const hasRedirected = React.useRef(false);
  React.useEffect(() => {
    if (!isPending && !user && !hasRedirected.current) {
      hasRedirected.current = true;
      router.push("/sign-in");
    }
  }, [isPending, user, router]);

  const onSubmit = async (values: ChangePasswordFormValues) => {
    setServerError(null);
    setSuccessMessage(null);
    try {
      const result = await (client as Record<string, Function>).changePassword({
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      });

      if (result?.error) {
        setServerError("Incorrect current password. Please try again.");
        return;
      }

      setSuccessMessage("Password changed successfully.");
      reset();
    } catch {
      setServerError("Something went wrong. Please try again.");
    }
  };

  if (!user && !isPending) {
    return null;
  }

  return (
    <div className={cn("w-full max-w-md", className, classNames?.card)}>
      {successMessage && (
        <p role="status" className="text-sm text-green-600 mb-2">
          {successMessage}
        </p>
      )}

      {serverError && (
        <p role="alert" className="text-sm text-destructive mb-2">
          {serverError}
        </p>
      )}

      <form
        onSubmit={handleSubmit(onSubmit)}
        className={classNames?.form}
        noValidate
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="current-password">Current Password</Label>
            <Input
              id="current-password"
              type="password"
              autoComplete="current-password"
              aria-invalid={!!errors.currentPassword}
              className={classNames?.input}
              {...register("currentPassword")}
            />
            {errors.currentPassword && (
              <p role="alert" className="text-sm text-destructive">
                {errors.currentPassword.message}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-password">New Password</Label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              aria-invalid={!!errors.newPassword}
              className={classNames?.input}
              {...register("newPassword")}
            />
            {errors.newPassword && (
              <p role="alert" className="text-sm text-destructive">
                {errors.newPassword.message}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirm-new-password">Confirm Password</Label>
            <Input
              id="confirm-new-password"
              type="password"
              autoComplete="new-password"
              aria-invalid={!!errors.confirmNewPassword}
              className={classNames?.input}
              {...register("confirmNewPassword")}
            />
            {errors.confirmNewPassword && (
              <p role="alert" className="text-sm text-destructive">
                {errors.confirmNewPassword.message}
              </p>
            )}
          </div>
        </div>

        <Button
          type="submit"
          disabled={isSubmitting}
          aria-disabled={isSubmitting}
          aria-label="Change Password"
          className={cn("w-full mt-4", classNames?.submitButton)}
        >
          {isSubmitting ? "Saving…" : "Change Password"}
        </Button>
      </form>
    </div>
  );
}
ChangePassword.displayName = "ChangePassword";
