"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useAuthContext } from "./auth-provider";
import { signInSchema, type SignInFormValues } from "../lib/schemas";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { SocialButton } from "./social-button";

export type SignInProps = {
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
};

export function SignIn({
  className,
  classNames,
  providers,
  callbackUrl = "/",
}: SignInProps) {
  const { client } = useAuthContext();
  const router = useRouter();

  const [serverError, setServerError] = React.useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignInFormValues>({
    resolver: zodResolver(signInSchema),
  });

  const onSubmit = async (values: SignInFormValues) => {
    setServerError(null);
    try {
      const signIn = (client as { signIn: { email: Function } }).signIn;
      const result = await signIn.email({
        email: values.email,
        password: values.password,
        callbackURL: callbackUrl,
      });

      if (result?.error) {
        setServerError("Invalid email or password. Please try again.");
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
            <Label htmlFor="sign-in-email">Email</Label>
            <Input
              id="sign-in-email"
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
            <Label htmlFor="sign-in-password">Password</Label>
            <Input
              id="sign-in-password"
              type="password"
              autoComplete="current-password"
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
        </div>

        <Button
          type="submit"
          disabled={isSubmitting}
          aria-disabled={isSubmitting}
          aria-label="Sign In"
          className={cn("w-full mt-4", classNames?.submitButton)}
        >
          {isSubmitting ? "Signing in…" : "Sign In"}
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

      <div className="mt-4 text-sm text-center space-y-1">
        <p>
          <a href="/forgot-password" className="underline">
            Forgot your password?
          </a>
        </p>
        <p>
          Don&apos;t have an account?{" "}
          <a href="/sign-up" className="underline">
            Create one
          </a>
        </p>
      </div>
    </div>
  );
}
SignIn.displayName = "SignIn";
