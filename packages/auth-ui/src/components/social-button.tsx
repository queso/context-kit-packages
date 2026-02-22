"use client";

import type * as React from "react";
import { cn } from "../lib/utils";
import { providerIcons } from "./icons/index";
import { Button } from "./ui/button";

export type SocialButtonProps = {
  provider: string;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  className?: string;
  disabled?: boolean;
  loading?: boolean;
  renderIcon?: () => React.ReactNode;
};

export function SocialButton({
  provider,
  onClick,
  className,
  disabled = false,
  loading = false,
  renderIcon,
}: SocialButtonProps) {
  const providerLabel = provider.charAt(0).toUpperCase() + provider.slice(1);

  const IconComponent = providerIcons[provider.toLowerCase()];

  const icon = renderIcon ? (
    renderIcon()
  ) : IconComponent ? (
    <IconComponent aria-hidden="true" />
  ) : null;

  return (
    <Button
      variant="outline"
      className={cn("w-full gap-2", className)}
      onClick={onClick}
      disabled={disabled || loading}
      aria-busy={loading ? "true" : undefined}
      data-loading={loading ? "true" : undefined}
    >
      {icon}
      <span>Continue with {providerLabel}</span>
    </Button>
  );
}
SocialButton.displayName = "SocialButton";
