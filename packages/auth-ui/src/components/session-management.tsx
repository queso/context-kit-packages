"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { useSession } from "../hooks/use-session";
import { cn } from "../lib/utils";
import { useAuthContext } from "./auth-provider";
import { Button } from "./ui/button";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SessionData = {
  id: string;
  token?: string;
  userAgent?: string;
  ipAddress?: string;
  createdAt?: string;
  updatedAt?: string;
  current?: boolean;
};

export type SessionManagementProps = {
  className?: string;
  classNames?: {
    card?: string;
    sessionItem?: string;
    revokeButton?: string;
    currentBadge?: string;
  };
};

// ---------------------------------------------------------------------------
// User-agent parser — extracts a human-readable label
// ---------------------------------------------------------------------------

function parseUserAgent(ua?: string): string {
  if (!ua) return "Unknown device";

  const lower = ua.toLowerCase();

  // OS / device
  let os = "";
  if (lower.includes("iphone") || lower.includes("ipad")) {
    os = "iPhone";
  } else if (lower.includes("android")) {
    os = "Android";
  } else if (lower.includes("macintosh") || lower.includes("mac os")) {
    os = "Mac";
  } else if (lower.includes("windows")) {
    os = "Windows";
  } else if (lower.includes("linux")) {
    os = "Linux";
  }

  // Browser
  let browser = "";
  if (lower.includes("firefox")) {
    browser = "Firefox";
  } else if (lower.includes("edg/") || lower.includes("edge/")) {
    browser = "Edge";
  } else if (lower.includes("chrome") && !lower.includes("chromium")) {
    browser = "Chrome";
  } else if (lower.includes("safari") && !lower.includes("chrome")) {
    browser = "Safari";
  }

  if (browser && os) return `${browser} on ${os}`;
  if (browser) return browser;
  if (os) return os;
  return "Unknown device";
}

// ---------------------------------------------------------------------------
// Timestamp formatter
// ---------------------------------------------------------------------------

function formatTimestamp(iso?: string): string {
  if (!iso) return "";
  try {
    const date = new Date(iso);
    const now = Date.now();
    const diffMs = now - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 30) return `${diffDays} days ago`;

    // Show full date with month name and year (includes "Jan", "2024", etc.)
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// ConfirmDialog — custom inline dialog (avoids Radix Portal/presence issues)
// ---------------------------------------------------------------------------

type ConfirmDialogProps = {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

function ConfirmDialog({ open, onConfirm, onCancel }: ConfirmDialogProps) {
  // Handle Escape key
  React.useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      aria-describedby="confirm-dialog-desc"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    >
      <div className="bg-background border rounded-lg p-6 max-w-sm w-full shadow-lg space-y-4">
        <h2 id="confirm-dialog-title" className="text-lg font-semibold">
          Revoke current session?
        </h2>
        <p id="confirm-dialog-desc" className="text-sm text-muted-foreground">
          This will sign you out. Are you sure you want to continue?
        </p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" onClick={onConfirm}>
            Sign Out
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SessionManagement component
// ---------------------------------------------------------------------------

export function SessionManagement({
  className,
  classNames,
}: SessionManagementProps) {
  const { client } = useAuthContext();
  const { data: sessionData, isPending } = useSession();
  const router = useRouter();

  const user = sessionData?.user;
  const currentSessionId = sessionData?.session?.id;

  const [sessions, setSessions] = React.useState<SessionData[] | null>(null);
  const [loadingState, setLoadingState] = React.useState<
    "idle" | "loading" | "error"
  >("loading");
  const [revokingId, setRevokingId] = React.useState<string | null>(null);
  const [confirmDialogOpen, setConfirmDialogOpen] = React.useState(false);

  // Redirect to sign-in if no session
  const hasRedirected = React.useRef(false);
  React.useEffect(() => {
    if (!isPending && !user && !hasRedirected.current) {
      hasRedirected.current = true;
      router.push("/sign-in");
    }
  }, [isPending, user, router]);

  // Fetch sessions on mount
  React.useEffect(() => {
    if (!user) return;

    const listSessions = (client as Record<string, Function>).listSessions;
    if (typeof listSessions !== "function") {
      setLoadingState("error");
      return;
    }

    setLoadingState("loading");
    listSessions()
      .then((result: { data: SessionData[] | null; error: unknown }) => {
        if (result?.error || !result?.data) {
          setLoadingState("error");
        } else {
          // Sort: current session first
          const sorted = [...result.data].sort((a, b) => {
            const aCurrent = a.current || a.id === currentSessionId;
            const bCurrent = b.current || b.id === currentSessionId;
            if (aCurrent && !bCurrent) return -1;
            if (!aCurrent && bCurrent) return 1;
            return 0;
          });
          setSessions(sorted);
          setLoadingState("idle");
        }
      })
      .catch(() => {
        setLoadingState("error");
      });
  }, [user, client, currentSessionId]);

  const handleRevokeNonCurrent = async (session: SessionData) => {
    setRevokingId(session.id);
    try {
      await (client as Record<string, Function>).revokeSession({
        token: session.token ?? session.id,
      });
      setSessions((prev) => prev?.filter((s) => s.id !== session.id) ?? null);
    } catch {
      // silently ignore
    } finally {
      setRevokingId(null);
    }
  };

  const handleRevokeCurrent = () => {
    setConfirmDialogOpen(true);
  };

  const handleConfirmRevokeCurrent = async () => {
    const currentSession = sessions?.find(
      (s) => s.current || s.id === currentSessionId
    );
    if (!currentSession) return;
    try {
      await (client as Record<string, Function>).revokeSession({
        token: currentSession.token ?? currentSession.id,
      });
    } catch {
      // ignore
    }
    setConfirmDialogOpen(false);
    router.push("/sign-in");
  };

  const handleCancelRevokeCurrent = React.useCallback(() => {
    setConfirmDialogOpen(false);
  }, []);

  if (!user && !isPending) return null;

  // Loading state
  if (loadingState === "loading") {
    return (
      <div
        className={cn("w-full max-w-2xl", className, classNames?.card)}
        aria-busy="true"
        data-loading="true"
      >
        <p className="text-sm text-muted-foreground">Loading sessions…</p>
      </div>
    );
  }

  // Error state
  if (loadingState === "error") {
    return (
      <div className={cn("w-full max-w-2xl", className, classNames?.card)}>
        <p role="alert" className="text-sm text-destructive">
          Could not load sessions. Something went wrong.
        </p>
      </div>
    );
  }

  // Determine empty states
  const currentSession = sessions?.find(
    (s) => s.current || s.id === currentSessionId
  );
  // "only current" = only one session and it's current, OR no sessions at all
  const otherSessions =
    sessions?.filter((s) => !s.current && s.id !== currentSessionId) ?? [];
  const isEmpty = sessions !== null && sessions.length === 0;
  const hasOnlyCurrent =
    sessions !== null &&
    !isEmpty &&
    sessions.length >= 1 &&
    otherSessions.length === 0;

  return (
    <div className={cn("w-full max-w-2xl", className, classNames?.card)}>
      {/* Session list — aria-hidden when dialog is open so background buttons are excluded from queries */}
      <div aria-hidden={confirmDialogOpen ? "true" : undefined}>
        {sessions && sessions.length > 0 && (
          <ul className="space-y-3">
            {sessions.map((session) => {
              const isCurrent =
                session.current || session.id === currentSessionId;
              const isRevoking = revokingId === session.id;
              const deviceLabel = parseUserAgent(session.userAgent);
              const timestamp = formatTimestamp(
                session.updatedAt ?? session.createdAt
              );

              return (
                <li
                  key={session.id}
                  className={cn(
                    "flex items-start justify-between rounded-md border p-3 gap-3",
                    classNames?.sessionItem
                  )}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium">{deviceLabel}</span>
                      {isCurrent && (
                        <span
                          className={cn(
                            "text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium",
                            classNames?.currentBadge
                          )}
                        >
                          Current session
                        </span>
                      )}
                    </div>
                    {session.ipAddress && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {session.ipAddress}
                      </p>
                    )}
                    {timestamp && (
                      <p className="text-xs text-muted-foreground">
                        {timestamp}
                      </p>
                    )}
                  </div>

                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={isRevoking}
                    aria-disabled={isRevoking}
                    data-loading={isRevoking ? "true" : undefined}
                    aria-label="Revoke"
                    className={classNames?.revokeButton}
                    onClick={() =>
                      isCurrent
                        ? handleRevokeCurrent()
                        : handleRevokeNonCurrent(session)
                    }
                  >
                    {isRevoking ? "Revoking…" : "Revoke"}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}

        {hasOnlyCurrent && (
          <p className="text-sm text-muted-foreground mt-4">
            No other active sessions.
          </p>
        )}

        {isEmpty && (
          <p className="text-sm text-muted-foreground mt-4">
            No active sessions found.
          </p>
        )}
      </div>

      <ConfirmDialog
        open={confirmDialogOpen}
        onConfirm={handleConfirmRevokeCurrent}
        onCancel={handleCancelRevokeCurrent}
      />
    </div>
  );
}
SessionManagement.displayName = "SessionManagement";
