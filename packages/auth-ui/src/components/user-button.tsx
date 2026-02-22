"use client";

import Link from "next/link";
import * as React from "react";
import { useSession } from "../hooks/use-session";
import { cn } from "../lib/utils";
import { useAuthContext } from "./auth-provider";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";

export type UserButtonProps = {
  onSignOut?: () => void;
  profileUrl?: string;
  className?: string;
  classNames?: {
    avatar?: string;
    dropdown?: string;
    menuItem?: string;
  };
};

export function UserButton({
  onSignOut,
  profileUrl = "/profile",
  className,
  classNames,
}: UserButtonProps) {
  const { client } = useAuthContext();
  const { data } = useSession();
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);

  const user = data?.user;

  // Close dropdown when clicking outside
  React.useEffect(() => {
    if (!open) return;
    const handleOutsideClick = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [open]);

  if (!user) {
    return null;
  }

  const initials = user.name ? user.name.charAt(0).toUpperCase() : "?";

  const handleSignOut = async () => {
    setOpen(false);
    await (client as Record<string, Function>).signOut();
    onSignOut?.();
  };

  return (
    <div ref={containerRef} className={cn("relative inline-block", className)}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Avatar className={classNames?.avatar}>
          {user.image ? (
            <AvatarImage
              src={user.image as string}
              alt={user.name ?? "User avatar"}
            />
          ) : null}
          <AvatarFallback>{initials}</AvatarFallback>
        </Avatar>
      </button>
      {open && (
        <div
          role="menu"
          className={cn(
            "absolute right-0 mt-1 min-w-[8rem] rounded-md border bg-popover p-1 shadow-md z-50",
            classNames?.dropdown
          )}
        >
          {/* User info label */}
          <div className="px-2 py-1.5 text-sm font-semibold">
            <div>{user.name}</div>
            <div className="text-xs font-normal text-muted-foreground">
              {user.email}
            </div>
          </div>
          <div className="-mx-1 my-1 h-px bg-muted" role="separator" />
          {/* Profile link */}
          <Link
            href={profileUrl}
            role="menuitem"
            className={cn(
              "relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground",
              classNames?.menuItem
            )}
            onClick={() => setOpen(false)}
          >
            Profile
          </Link>
          <div className="-mx-1 my-1 h-px bg-muted" role="separator" />
          {/* Sign out button */}
          <button
            type="button"
            role="menuitem"
            className={cn(
              "relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground",
              classNames?.menuItem
            )}
            onClick={handleSignOut}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
UserButton.displayName = "UserButton";
