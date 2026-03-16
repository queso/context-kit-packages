"use client";

import React from "react";
import { reportError } from "./reporter.js";
import type { ErrorPayload, ErrorTrackerConfig } from "./types.js";

type FallbackProp = React.ReactNode | ((error: Error) => React.ReactNode);

interface ErrorBoundaryProps {
  config?: ErrorTrackerConfig;
  fallback?: FallbackProp;
  children?: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    try {
      const config = this.props.config;
      if (!config) return;
      const payload: ErrorPayload = {
        message: error.message,
        stack: error.stack,
        componentStack: info.componentStack ?? undefined,
        url: typeof window !== "undefined" ? window.location.href : "",
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
        environment: config.environment,
      };
      reportError(config, payload);
    } catch {
      // Never let reporter errors propagate
    }
  }

  render(): React.ReactNode {
    const { error } = this.state;
    if (error !== null) {
      const { fallback } = this.props;
      if (typeof fallback === "function") {
        return (fallback as (error: Error) => React.ReactNode)(error);
      }
      return (
        fallback ?? React.createElement("div", null, "Something went wrong.")
      );
    }
    return this.props.children ?? null;
  }
}
