"use client";

import type * as React from "react";
import { cn } from "../../lib/utils.js";

export type PageLayoutProps = {
  children: React.ReactNode;
  className?: string;
};

export function PageLayout({ children, className }: PageLayoutProps) {
  return (
    <div
      className={cn(
        "min-h-screen flex items-center justify-center p-4",
        className
      )}
    >
      {children}
    </div>
  );
}
PageLayout.displayName = "PageLayout";
