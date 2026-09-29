import type { QaErrorCode } from "../errors/codes.js";
import { QaError } from "../errors/qa-error.js";
import type {
  FailureCategory,
  RunResult,
  RunStatus,
  StepResult,
} from "./types.js";

/** Epoch milliseconds. Tests inject this so durations do not call `Date.now`. */
export type RunClock = () => number;

export type StartRunOptions = {
  runId: string;
  flowId: string;
  /** Sampled at run start, each step, and finish. Defaults to `Date.now`. */
  now?: RunClock;
};

export type RunBuilder = {
  stepPassed(stepId: string): void;
  stepFailed(stepId: string, error: QaError): void;
  finish(): RunResult;
};

type MappedFailure = {
  status: "failed" | "error";
  category: FailureCategory;
};

/**
 * Assertion and locator stay distinct. The remaining codes use the closest
 * category on the run-result contract. Any assertion failure classifies the
 * whole run as `failed`; otherwise the first recorded failure wins.
 */
const FAILURE_BY_CODE = {
  ASSERTION_FAILED: { status: "failed", category: "assertion" },
  LOCATOR_STALE: { status: "failed", category: "locator" },
  NAVIGATION_FAILED: { status: "error", category: "navigation" },
  NETWORK_FAILURE: { status: "error", category: "network" },
  TIMEOUT: { status: "error", category: "timeout" },
  BROWSER_CRASHED: { status: "error", category: "runtime" },
  PAGE_ERROR: { status: "error", category: "runtime" },
  POLICY_BLOCKED: { status: "error", category: "runtime" },
  RUN_CANCELLED: { status: "error", category: "runtime" },
  DISCOVERY_FAILED: { status: "error", category: "runtime" },
  FLOW_COMPILE_FAILED: { status: "error", category: "runtime" },
  FLOW_VALIDATION_FAILED: { status: "error", category: "runtime" },
  AUTH_EXPIRED: { status: "error", category: "runtime" },
  AUTH_MISSING: { status: "error", category: "runtime" },
  LLM_PROVIDER_UNAVAILABLE: { status: "error", category: "runtime" },
  LLM_RATE_LIMITED: { status: "error", category: "runtime" },
} as const satisfies Record<QaErrorCode, MappedFailure>;

type RecordedFailure = {
  stepId: string;
  status: "failed" | "error";
  category: FailureCategory;
  message: string;
};

const systemClock: RunClock = () => Date.now();

/**
 * Record step outcomes into one {@link RunResult}.
 * Failures are stored. They are not rethrown. `finish` still returns the
 * steps recorded before a cancellation.
 */
export function startRun(options: StartRunOptions): RunBuilder {
  const now = options.now ?? systemClock;
  const runStartedMs = now();
  let cursorMs = runStartedMs;
  let finished = false;
  const steps: StepResult[] = [];
  const failures: RecordedFailure[] = [];

  const ensureOpen = (): void => {
    if (finished) {
      throw new Error("Run is already finished");
    }
  };

  const pushStep = (stepId: string, status: RunStatus, error?: string): void => {
    const endedMs = now();
    const step: StepResult = {
      stepId,
      status,
      startedAt: toIso(cursorMs),
      durationMs: endedMs - cursorMs,
    };
    if (error !== undefined) {
      step.error = error;
    }
    steps.push(step);
    cursorMs = endedMs;
  };

  return {
    stepPassed(stepId: string): void {
      ensureOpen();
      pushStep(stepId, "passed");
    },

    stepFailed(stepId: string, error: QaError): void {
      ensureOpen();
      const mapped = FAILURE_BY_CODE[error.code];
      pushStep(stepId, mapped.status, error.message);
      failures.push({
        stepId,
        status: mapped.status,
        category: mapped.category,
        message: error.message,
      });
    },

    finish(): RunResult {
      ensureOpen();
      finished = true;
      const endedMs = now();
      const selected = selectRunFailure(failures);
      const result: RunResult = {
        runId: options.runId,
        flowId: options.flowId,
        status: selected?.status ?? "passed",
        startedAt: toIso(runStartedMs),
        durationMs: endedMs - runStartedMs,
        steps: steps.map((step) => ({ ...step })),
        network: { failedRequests: [], responses: [] },
        console: { errors: [], warnings: [] },
        pageErrors: [],
        artifacts: { screenshots: [] },
      };
      if (selected !== undefined) {
        result.failure = {
          stepId: selected.stepId,
          category: selected.category,
          message: selected.message,
        };
      }
      return result;
    },
  };
}

function selectRunFailure(
  recorded: readonly RecordedFailure[],
): RecordedFailure | undefined {
  const assertion = recorded.find((failure) => failure.category === "assertion");
  return assertion ?? recorded[0];
}

function toIso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}
