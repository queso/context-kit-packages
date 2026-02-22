"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import * as React from "react";
import { useForm } from "react-hook-form";
import {
  type PasswordRules,
  type SignUpFormValues,
  signUpSchema,
} from "../lib/schemas";
import { cn } from "../lib/utils";
import { useAuthContext } from "./auth-provider";
import { SocialButton } from "./social-button";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

export type SignUpProps = {
  className?: string;
  classNames?: {
    card?: string;
    form?: string;
    input?: string;
    submitButton?: string;
    socialButton?: string;
  };
  providers?: string[];
  callbackUrl?: string;
  passwordRules?: PasswordRules;
};

export function SignUp({
  className,
  classNames,
  providers,
  callbackUrl = "/",
  passwordRules,
}: SignUpProps) {
  const { client } = useAuthContext();
  const router = useRouter();

  const [serverError, setServerError] = React.useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignUpFormValues>({
    resolver: zodResolver(signUpSchema(passwordRules)),
  });

  const onSubmit = async (values: SignUpFormValues) => {
    setServerError(null);
    try {
      const signUp = (client as { signUp: { email: Function } }).signUp;
      const result = await signUp.email({
        name: values.name,
        email: values.email,
        password: values.password,
        callbackURL: callbackUrl,
      });

      if (result?.error) {
        setServerError(
          "An account with that email already exists or is in use."
        );
        return;
      }

      router.push(callbackUrl);
    } catch {
      setServerError("Something went wrong. Please try again.");
    }
  };

  const handleSocial = async (provider: string) => {
    try {
      const signIn = (client as { signIn: { social: Function } }).signIn;
      await signIn.social({ provider, callbackURL: callbackUrl });
    } catch {
      setServerError("Something went wrong. Please try again.");
    }
  };

  return (
    <div className={cn("w-full max-w-md", className, classNames?.card)}>
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
            <Label htmlFor="sign-up-name">Name</Label>
            <Input
              id="sign-up-name"
              type="text"
              autoComplete="name"
              aria-invalid={!!errors.name}
              className={classNames?.input}
              {...register("name")}
            />
            {errors.name && (
              <p role="alert" className="text-sm text-destructive">
                {errors.name.message}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="sign-up-email">Email</Label>
            <Input
              id="sign-up-email"
              type="email"
              autoComplete="email"
              aria-invalid={!!errors.email}
              className={classNames?.input}
              {...register("email")}
            />
            {errors.email && (
              <p role="alert" className="text-sm text-destructive">
                {errors.email.message}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="sign-up-password">Password</Label>
            <Input
              id="sign-up-password"
              type="password"
              autoComplete="new-password"
              aria-invalid={!!errors.password}
              className={classNames?.input}
              {...register("password")}
            />
            {errors.password && (
              <p role="alert" className="text-sm text-destructive">
                {errors.password.message}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="sign-up-confirm-password">Confirm Password</Label>
            <Input
              id="sign-up-confirm-password"
              type="password"
              autoComplete="new-password"
              aria-invalid={!!errors.confirmPassword}
              className={classNames?.input}
              {...register("confirmPassword")}
            />
            {errors.confirmPassword && (
              <p role="alert" className="text-sm text-destructive">
                {errors.confirmPassword.message}
              </p>
            )}
          </div>
        </div>

        <Button
          type="submit"
          disabled={isSubmitting}
          aria-disabled={isSubmitting}
          aria-label="Sign Up"
          className={cn("w-full mt-4", classNames?.submitButton)}
        >
          {isSubmitting ? "Creating account…" : "Sign Up"}
        </Button>
      </form>

      {providers && providers.length > 0 && (
        <div className="mt-4">
          <div className="flex items-center gap-2 my-4">
            <div className="flex-1 h-px bg-border" />
            <span className="text-sm text-muted-foreground">or</span>
            <div className="flex-1 h-px bg-border" />
          </div>
          <div className="space-y-2">
            {providers.map((provider) => (
              <SocialButton
                key={provider}
                provider={provider}
                className={classNames?.socialButton}
                onClick={() => handleSocial(provider)}
              />
            ))}
          </div>
        </div>
      )}

      <div className="mt-4 text-sm text-center">
        <p>
          Already have an account?{" "}
          <a href="/sign-in" className="underline">
            Log in
          </a>
        </p>
      </div>
    </div>
  );
}
SignUp.displayName = "SignUp";
