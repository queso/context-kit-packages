export interface ErrorTrackerConfig {
  endpoint: string;
  token?: string;
  secretHeaderName?: string;
  environment: string;
  patchConsoleError?: boolean;
}

export interface ErrorPayload {
  message: string;
  stack?: string;
  componentStack?: string;
  url: string;
  userAgent: string;
  environment: string;
}

export interface StackFrame {
  file: string;
  line: number;
  column: number;
  functionName?: string;
}
