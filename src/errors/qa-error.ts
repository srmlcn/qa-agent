import type { QaErrorCode } from "./codes.js";

/**
 * Log and MCP shape of a {@link QaError}. `toJSON()` returns only these fields.
 */
export type QaErrorJson = {
  code: QaErrorCode;
  message: string;
  runId?: string;
  flowId?: string;
  stepId?: string;
  artifacts?: string[];
  recoveryAppropriate: boolean;
};

export type QaErrorOptions = {
  code: QaErrorCode;
  /**
   * Human-readable description safe for logs and MCP.
   * Do not include cookies, tokens, or other secrets.
   */
  message: string;
  runId?: string;
  flowId?: string;
  stepId?: string;
  /** Filesystem paths of artifacts associated with this failure. */
  artifacts?: readonly string[];
};

/** Stagehand repair is appropriate only for a stale locator in v0.1. */
const RECOVERY_APPROPRIATE_CODES: ReadonlySet<QaErrorCode> = new Set([
  "LOCATOR_STALE",
]);

function recoveryAppropriateFor(code: QaErrorCode): boolean {
  return RECOVERY_APPROPRIATE_CODES.has(code);
}

/**
 * Structured runtime failure. The JSON form is safe to log and never includes
 * a stack trace.
 */
export class QaError extends Error {
  readonly code: QaErrorCode;
  readonly runId?: string;
  readonly flowId?: string;
  readonly stepId?: string;
  readonly artifacts?: readonly string[];
  readonly recoveryAppropriate: boolean;

  constructor(options: QaErrorOptions) {
    super(options.message);
    this.name = "QaError";
    this.code = options.code;
    this.runId = options.runId;
    this.flowId = options.flowId;
    this.stepId = options.stepId;
    this.artifacts =
      options.artifacts === undefined ? undefined : [...options.artifacts];
    this.recoveryAppropriate = recoveryAppropriateFor(options.code);
  }

  toJSON(): QaErrorJson {
    const body: QaErrorJson = {
      code: this.code,
      message: this.message,
      recoveryAppropriate: this.recoveryAppropriate,
    };
    if (this.runId !== undefined) {
      body.runId = this.runId;
    }
    if (this.flowId !== undefined) {
      body.flowId = this.flowId;
    }
    if (this.stepId !== undefined) {
      body.stepId = this.stepId;
    }
    if (this.artifacts !== undefined) {
      body.artifacts = [...this.artifacts];
    }
    return body;
  }
}
