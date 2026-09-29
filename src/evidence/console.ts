import { redactBody } from "../security/redaction.js";
import type {
  ConsoleRecord,
  NetworkFailure,
  NetworkRecord,
  PageErrorRecord,
  RunResult,
} from "./types.js";

/** Facts collected from one page and merged onto a {@link RunResult}. */
export type EvidenceCapture = {
  network: {
    failedRequests: NetworkFailure[];
    responses: NetworkRecord[];
  };
  console: {
    errors: ConsoleRecord[];
    warnings: ConsoleRecord[];
  };
  pageErrors: PageErrorRecord[];
};

export function createCapture(): EvidenceCapture {
  return {
    network: { failedRequests: [], responses: [] },
    console: { errors: [], warnings: [] },
    pageErrors: [],
  };
}

/**
 * Appends captured facts onto `result`. Existing steps, artifacts, and
 * earlier network or console entries stay in place.
 */
export function applyCapture(
  result: RunResult,
  capture: EvidenceCapture,
): RunResult {
  result.network.failedRequests.push(
    ...capture.network.failedRequests.map(cloneNetwork),
  );
  result.network.responses.push(...capture.network.responses.map(cloneNetwork));
  result.console.errors.push(...capture.console.errors.map(cloneConsole));
  result.console.warnings.push(...capture.console.warnings.map(cloneConsole));
  result.pageErrors.push(...capture.pageErrors.map(clonePageError));
  return result;
}

/**
 * Stores a console warning or error. Logs and debug are ignored.
 * Nothing is stored when console capture is disabled.
 */
export function recordConsoleMessage(
  capture: EvidenceCapture,
  message: { type?: string; text?: string; url?: string },
  options: { enabled: boolean; maxBytes: number },
): void {
  if (!options.enabled) {
    return;
  }
  const level = consoleLevel(message.type);
  if (level === undefined) {
    return;
  }
  const record: ConsoleRecord = {
    level,
    text: redactBody(message.text ?? "", options.maxBytes),
  };
  if (message.url !== undefined && message.url.length > 0) {
    record.url = message.url;
  }
  if (level === "error") {
    capture.console.errors.push(record);
    return;
  }
  capture.console.warnings.push(record);
}

/** Stores an uncaught page error. The message is redacted before insertion. */
export function recordPageError(
  capture: EvidenceCapture,
  error: { message?: string; url?: string },
  maxBytes: number,
): void {
  const record: PageErrorRecord = {
    message: redactBody(error.message ?? "", maxBytes),
  };
  if (error.url !== undefined && error.url.length > 0) {
    record.url = error.url;
  }
  capture.pageErrors.push(record);
}

function consoleLevel(type: string | undefined): "warning" | "error" | undefined {
  if (type === "warning" || type === "error") {
    return type;
  }
  return undefined;
}

function cloneNetwork<T extends NetworkRecord | NetworkFailure>(record: T): T {
  return { ...record, headers: { ...record.headers } };
}

function cloneConsole(record: ConsoleRecord): ConsoleRecord {
  return record.url === undefined
    ? { level: record.level, text: record.text }
    : { level: record.level, text: record.text, url: record.url };
}

function clonePageError(record: PageErrorRecord): PageErrorRecord {
  return record.url === undefined
    ? { message: record.message }
    : { message: record.message, url: record.url };
}
