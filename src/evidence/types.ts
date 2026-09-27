const RUN_STATUSES = ["passed", "failed", "error"] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export type FailureCategory =
  | "assertion"
  | "locator"
  | "navigation"
  | "network"
  | "timeout"
  | "runtime";

export interface StepResult {
  stepId: string;
  status: RunStatus;
  startedAt: string;
  durationMs: number;
  error?: string;
}

export interface NetworkFailure {
  method: string;
  url: string;
  status: number;
  timing: number;
  /** Already truncated to the configured size limit. */
  body?: string;
  /**
   * Header values must already be redacted before insertion.
   */
  headers: Record<string, string>;
  /** True when a response body was not stored. */
  bodyOmitted?: boolean;
}

export interface NetworkRecord {
  method: string;
  url: string;
  status: number;
  timing: number;
  /** Already truncated to the configured size limit. */
  body?: string;
  /**
   * Header values must already be redacted before insertion.
   */
  headers: Record<string, string>;
  /** True when a response body was not stored. */
  bodyOmitted?: boolean;
}

export interface ConsoleRecord {
  level: "warning" | "error";
  text: string;
  url?: string;
}

export interface PageErrorRecord {
  message: string;
  url?: string;
}

export interface RunResult {
  runId: string;
  flowId: string;
  status: RunStatus;
  startedAt: string;
  durationMs: number;
  steps: StepResult[];
  network: {
    failedRequests: NetworkFailure[];
    responses: NetworkRecord[];
  };
  console: {
    errors: ConsoleRecord[];
    warnings: ConsoleRecord[];
  };
  pageErrors: PageErrorRecord[];
  artifacts: {
    screenshots: string[];
    trace?: string;
  };
  failure?: {
    stepId?: string;
    category: FailureCategory;
    message: string;
  };
}

export function isRunStatus(status: unknown): status is RunStatus {
  return RUN_STATUSES.some((candidate) => candidate === status);
}
