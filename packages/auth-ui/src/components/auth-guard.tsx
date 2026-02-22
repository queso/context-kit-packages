"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useSession } from "../hooks/use-session";
import { cn } from "../lib/utils";

export type AuthGuardProps = {
  children: React.ReactNode;
  signInPath?: string;
  loadingComponent?: React.ReactNode;
  className?: string;
};

export function AuthGuard({
  children,
  signInPath = "/sign-in",
  loadingComponent,
  className,
}: AuthGuardProps) {
  const { data, isPending } = useSession();
  const router = useRouter();

  const hasRedirected = React.useRef(false);

  React.useEffect(() => {
    if (!isPending && !data && !hasRedirected.current) {
      hasRedirected.current = true;
      router.push(signInPath);
    }
  }, [isPending, data, router, signInPath]);

  if (isPending) {
    if (loadingComponent) {
      return <>{loadingComponent}</>;
    }
    return (
      <div className={cn("flex items-center justify-center", className)} role="status" aria-busy="true">
        <div className="animate-spin h-6 w-6 rounded-full border-2 border-current border-t-transparent" />
      </div>
    );
  }

  if (!data) {
    return null;
  }

  return <div className={className}>{children}</div>;
}
AuthGuard.displayName = "AuthGuard";
