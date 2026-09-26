import { QaError } from "../errors/qa-error.js";
import type { QaErrorCode } from "../errors/codes.js";
import { redactBody } from "../security/redaction.js";

const MAX_MESSAGE_CHARS = 500;

export type PlaywrightErrorContext = {
  runId?: string;
  flowId?: string;
  stepId?: string;
  /** Runtime abort signal. An aborted signal maps the failure to RUN_CANCELLED. */
  signal?: AbortSignal;
};

type FailureSignals = {
  name: string;
  message: string;
  aborted: boolean;
};

type FailureRule = {
  code: QaErrorCode;
  when: (signals: FailureSignals) => boolean;
};

/**
 * First match wins. Cancel comes before crash and timeout so an aborted run
 * stays RUN_CANCELLED. Locator failures come before timeouts because
 * Playwright reports a missing locator as a timeout while waiting for it.
 */
const FAILURE_RULES: readonly FailureRule[] = [
  {
    code: "RUN_CANCELLED",
    when: ({ name, message, aborted }) =>
      aborted ||
      name === "AbortError" ||
      matches(message, [/the operation was aborted/i, /this operation was aborted/i]),
  },
  {
    code: "BROWSER_CRASHED",
    when: ({ name, message }) =>
      name === "TargetClosedError" ||
      matches(message, [
        /target page, context or browser has been closed/i,
        /\btarget closed\b/i,
        /browser has been closed/i,
        /\bbrowser closed\b/i,
        /browser disconnected/i,
        /has disconnected/i,
        /\bcrashed\b/i,
        /connection closed/i,
      ]),
  },
  {
    code: "LOCATOR_STALE",
    when: ({ message }) =>
      matches(message, [
        /strict mode violation/i,
        /not attached to the dom/i,
        /detached from the dom/i,
        /element\(s\) not found/i,
        /waiting for locator\b/i,
        /waiting for getBy[A-Z]/,
        /waiting for frameLocator\b/,
        /resolved to 0 elements/i,
      ]),
  },
  {
    code: "TIMEOUT",
    when: ({ name, message }) =>
      name === "TimeoutError" ||
      matches(message, [/timeout \d+ms exceeded/i, /\btimed out\b/i]),
  },
  {
    code: "NAVIGATION_FAILED",
    when: ({ message }) =>
      matches(message, [
        /net::ERR_/,
        /NS_ERROR_/,
        /\bnavigation\b/i,
        /cannot navigate/i,
        /download is starting/i,
      ]),
  },
];

export function classifyPlaywrightError(
  error: unknown,
  context: PlaywrightErrorContext = {},
): QaError {
  const signals = readSignals(error, context);
  return new QaError({
    code: classifyCode(signals),
    message: boundMessage(signals.message),
    runId: context.runId,
    flowId: context.flowId,
    stepId: context.stepId,
  });
}

function classifyCode(signals: FailureSignals): QaErrorCode {
  for (const rule of FAILURE_RULES) {
    if (rule.when(signals)) {
      return rule.code;
    }
  }
  return "PAGE_ERROR";
}

function readSignals(
  error: unknown,
  context: PlaywrightErrorContext,
): FailureSignals {
  return {
    name: readName(error),
    message: readMessage(error),
    aborted: context.signal?.aborted === true,
  };
}

function readName(error: unknown): string {
  if (error instanceof Error) {
    return error.name;
  }
  if (isRecord(error) && typeof error.name === "string") {
    return error.name;
  }
  return "";
}

function readMessage(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }
  return "Unknown Playwright failure";
}

function boundMessage(message: string): string {
  const redacted = redactBody(message, Number.POSITIVE_INFINITY);
  if (redacted.length <= MAX_MESSAGE_CHARS) {
    return redacted;
  }
  return redacted.slice(0, MAX_MESSAGE_CHARS);
}

function matches(message: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(message));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
