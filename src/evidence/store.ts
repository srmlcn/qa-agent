import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { homeDir } from "../runtime/paths.js";
import { redactBody, redactHeaders } from "../security/redaction.js";
import {
  isRunStatus,
  type ConsoleRecord,
  type FailureCategory,
  type NetworkRecord,
  type PageErrorRecord,
  type RunResult,
  type StepResult,
} from "./types.js";

/** Spec section 7 `evidence.maxResponseBodyBytes`. */
const MAX_RESPONSE_BODY_BYTES = 262144;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const RESULT_FILE = "result.json";
const RUN_ID_PATTERN = /^[a-zA-Z0-9-]{8,80}$/;

export type ArtifactPaths = {
  screenshots: readonly string[];
  trace?: string;
};

/** Absolute paths for in-process readers. Do not serialize this object. */
export type AbsoluteArtifactPaths = {
  screenshots: string[];
  trace?: string;
};

type LocatedArtifact = {
  relativePath: string;
  absolutePath: string;
};

/**
 * Creates `<projectRoot>/.autonomous-qa/artifacts/<runId>/` with mode `0700`.
 * The directory matches the root gitignore rule `.autonomous-qa/artifacts/`.
 */
export function createRunDir(projectRoot: string, runId: string): string {
  const runDir = resolveRunDir(projectRoot, runId);
  mkdirSync(runDir, { recursive: true, mode: PRIVATE_DIR_MODE });
  chmodSync(runDir, PRIVATE_DIR_MODE);
  return runDir;
}

/**
 * Sets `result.artifacts` to paths relative to the run directory.
 * Returns absolute paths for in-process use only. The mutated result is the
 * object safe to store for MCP.
 */
export function attach(
  result: RunResult,
  paths: ArtifactPaths,
): AbsoluteArtifactPaths {
  const located = locateAll(result.runId, paths);
  const trace = located.trace;
  result.artifacts = {
    screenshots: located.screenshots.map((item) => item.relativePath),
    ...(trace === undefined ? {} : { trace: trace.relativePath }),
  };
  return {
    screenshots: located.screenshots.map((item) => item.absolutePath),
    ...(trace === undefined ? {} : { trace: trace.absolutePath }),
  };
}

/** Reads `result.json` saved beside the run's artifact files. */
export function readRun(projectRoot: string, runId: string): RunResult {
  const runDir = resolveRunDir(projectRoot, runId);
  const filePath = join(runDir, RESULT_FILE);
  assertContained(runDir, filePath);
  if (!existsSync(filePath)) {
    throw new Error(`Run not found: ${runId}`);
  }
  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  const result = parseRunResult(parsed);
  if (result.runId !== runId) {
    throw new Error("Invalid run result field: runId");
  }
  return result;
}

/**
 * Writes `result.json` after header redaction and `redactBody` on every
 * string field. Artifact paths are stored relative to the run directory.
 * Does not write auth files.
 */
export function writeRun(projectRoot: string, result: RunResult): void {
  const runDir = createRunDir(projectRoot, result.runId);
  const stored = redactRunResult(relativizeArtifacts(runDir, result));
  const filePath = join(runDir, RESULT_FILE);
  assertContained(runDir, filePath);
  writeFileSync(filePath, `${JSON.stringify(stored, null, 2)}\n`, {
    encoding: "utf8",
    mode: PRIVATE_FILE_MODE,
  });
  chmodSync(filePath, PRIVATE_FILE_MODE);
}

function resolveRunDir(projectRoot: string, runId: string): string {
  assertSafeRunId(runId);
  const root = resolve(projectRoot);
  const runDir = join(root, ".autonomous-qa", "artifacts", runId);
  if (!isLexicalInside(root, runDir)) {
    throw new Error(`Invalid run id: ${runId}`);
  }
  assertNotUnderAuth(runDir);
  return runDir;
}

function assertSafeRunId(runId: string): void {
  if (
    runId.includes("/") ||
    runId.includes("\\") ||
    runId.includes("..") ||
    !RUN_ID_PATTERN.test(runId)
  ) {
    throw new Error(`Invalid run id: ${runId}`);
  }
}

function assertNotUnderAuth(runDir: string): void {
  const candidates = [resolve(runDir), canonicalPath(runDir)];
  for (const candidate of candidates) {
    for (const authRoot of authRoots()) {
      const root = canonicalPath(authRoot);
      if (isLexicalInside(root, candidate)) {
        throw new Error("Refusing to write auth files");
      }
    }
  }
}

function authRoots(): string[] {
  return [join(homedir(), ".autonomous-qa", "auth"), join(homeDir(), "auth")];
}

function locateAll(
  runId: string,
  paths: ArtifactPaths,
): { screenshots: LocatedArtifact[]; trace?: LocatedArtifact } {
  assertSafeRunId(runId);
  const inputs = [
    ...paths.screenshots,
    ...(paths.trace === undefined ? [] : [paths.trace]),
  ];
  if (inputs.length === 0) {
    return { screenshots: [] };
  }

  const runDir = findRunDir(runId, inputs[0] ?? "");
  assertNotUnderAuth(runDir);
  for (const artifactPath of inputs) {
    if (findRunDir(runId, artifactPath) !== runDir) {
      throw new Error("Invalid artifact path");
    }
  }

  const trace =
    paths.trace === undefined
      ? undefined
      : locateArtifact(runDir, paths.trace);
  return {
    screenshots: paths.screenshots.map((artifactPath) =>
      locateArtifact(runDir, artifactPath),
    ),
    ...(trace === undefined ? {} : { trace }),
  };
}

function findRunDir(runId: string, artifactPath: string): string {
  assertSafeRunId(runId);
  if (!isAbsolute(artifactPath) || artifactPath.includes("\0")) {
    throw new Error("Invalid artifact path");
  }
  const resolved = resolve(artifactPath);
  const marker = `${sep}.autonomous-qa${sep}artifacts${sep}${runId}`;
  const index = resolved.lastIndexOf(marker);
  if (index < 0) {
    throw new Error("Invalid artifact path");
  }
  const end = index + marker.length;
  if (resolved[end] !== sep) {
    throw new Error("Invalid artifact path");
  }
  return resolved.slice(0, end);
}

function locateArtifact(runDir: string, artifactPath: string): LocatedArtifact {
  const relativePath = toStoredArtifactPath(runDir, artifactPath);
  return {
    relativePath,
    absolutePath: resolve(runDir, relativePath),
  };
}

function relativizeArtifacts(runDir: string, result: RunResult): RunResult {
  const trace =
    result.artifacts.trace === undefined
      ? undefined
      : toStoredArtifactPath(runDir, result.artifacts.trace);
  return {
    runId: result.runId,
    flowId: result.flowId,
    status: result.status,
    startedAt: result.startedAt,
    durationMs: result.durationMs,
    steps: result.steps,
    network: result.network,
    console: result.console,
    pageErrors: result.pageErrors,
    artifacts: {
      screenshots: result.artifacts.screenshots.map((artifactPath) =>
        toStoredArtifactPath(runDir, artifactPath),
      ),
      ...(trace === undefined ? {} : { trace }),
    },
    ...(result.failure === undefined ? {} : { failure: result.failure }),
  };
}

function toStoredArtifactPath(runDir: string, artifactPath: string): string {
  if (artifactPath.includes("\0") || artifactPath.includes("\\")) {
    throw new Error("Invalid artifact path");
  }

  const resolved = isAbsolute(artifactPath)
    ? resolve(artifactPath)
    : resolve(runDir, artifactPath);
  assertContained(runDir, resolved);
  if (!isAbsolute(artifactPath)) {
    assertRelativeSafe(artifactPath.split(sep).join("/"));
  }
  assertRealContained(runDir, resolved);

  const stored = relative(resolve(runDir), resolved).split(sep).join("/");
  assertRelativeSafe(stored);
  return stored;
}

function assertRelativeSafe(relativePath: string): void {
  if (
    relativePath.length === 0 ||
    isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    relativePath.includes("\0")
  ) {
    throw new Error("Invalid artifact path");
  }
  const segments = relativePath.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new Error("Invalid artifact path");
  }
}

function assertContained(parent: string, child: string): void {
  if (!isLexicalInside(parent, child)) {
    throw new Error("Invalid artifact path");
  }
  assertRealContained(parent, child);
}

function assertRealContained(parent: string, child: string): void {
  if (!isLexicalInside(canonicalPath(parent), canonicalPath(child))) {
    throw new Error("Invalid artifact path");
  }
}

function canonicalPath(path: string): string {
  try {
    return canonicalize(resolve(path), new Set<string>());
  } catch (error) {
    if (isInvalidArtifact(error)) {
      throw error;
    }
    throw new Error("Invalid artifact path");
  }
}

function canonicalize(absolute: string, seen: Set<string>): string {
  if (seen.has(absolute)) {
    throw new Error("Invalid artifact path");
  }
  seen.add(absolute);

  if (!entryExists(absolute)) {
    const parent = dirname(absolute);
    if (parent === absolute) {
      return absolute;
    }
    return join(canonicalize(parent, seen), basename(absolute));
  }

  if (lstatSync(absolute).isSymbolicLink()) {
    try {
      return realpathSync(absolute);
    } catch (error) {
      if (!isEnoent(error)) {
        throw new Error("Invalid artifact path");
      }
      const link = readlinkSync(absolute);
      return canonicalize(resolve(dirname(absolute), link), seen);
    }
  }

  return realpathSync(absolute);
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isEnoent(error)) {
      return false;
    }
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function isInvalidArtifact(error: unknown): boolean {
  return error instanceof Error && error.message === "Invalid artifact path";
}

function isLexicalInside(parent: string, child: string): boolean {
  const root = resolve(parent);
  const target = resolve(child);
  return target === root || target.startsWith(`${root}${sep}`);
}

function redactText(value: string): string {
  return redactBody(value, MAX_RESPONSE_BODY_BYTES);
}

function redactRunResult(result: RunResult): RunResult {
  const failure = result.failure;
  return {
    runId: redactText(result.runId),
    flowId: redactText(result.flowId),
    status: redactStatus(result.status),
    startedAt: redactText(result.startedAt),
    durationMs: result.durationMs,
    steps: result.steps.map(redactStep),
    network: {
      failedRequests: result.network.failedRequests.map(redactNetwork),
      responses: result.network.responses.map(redactNetwork),
    },
    console: {
      errors: result.console.errors.map(redactConsole),
      warnings: result.console.warnings.map(redactConsole),
    },
    pageErrors: result.pageErrors.map(redactPageError),
    artifacts: redactArtifacts(result.artifacts),
    ...(failure === undefined ? {} : { failure: redactFailure(failure) }),
  };
}

function redactStatus(status: RunResult["status"]): RunResult["status"] {
  const redacted = redactText(status);
  if (!isRunStatus(redacted)) {
    throw new Error("Invalid run status");
  }
  return redacted;
}

function redactStep(step: StepResult): StepResult {
  const redacted: StepResult = {
    stepId: redactText(step.stepId),
    status: redactStatus(step.status),
    startedAt: redactText(step.startedAt),
    durationMs: step.durationMs,
  };
  if (step.error !== undefined) {
    redacted.error = redactText(step.error);
  }
  return redacted;
}

function redactNetwork(record: NetworkRecord): NetworkRecord {
  const redacted: NetworkRecord = {
    method: redactText(record.method),
    url: redactText(record.url),
    status: record.status,
    timing: record.timing,
    headers: redactHeaderMap(record.headers),
  };
  if (record.body !== undefined) {
    redacted.body = redactText(record.body);
  }
  return redacted;
}

function redactHeaderMap(
  headers: Record<string, string>,
): Record<string, string> {
  const redacted = redactHeaders(headers);
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(redacted)) {
    output[name] = redactText(typeof value === "string" ? value : value.join("\n"));
  }
  return output;
}

function redactConsole(record: ConsoleRecord): ConsoleRecord {
  const redacted: ConsoleRecord = {
    level: redactLevel(record.level),
    text: redactText(record.text),
  };
  if (record.url !== undefined) {
    redacted.url = redactText(record.url);
  }
  return redacted;
}

function redactLevel(level: ConsoleRecord["level"]): ConsoleRecord["level"] {
  const redacted = redactText(level);
  if (redacted !== "warning" && redacted !== "error") {
    throw new Error("Invalid console level");
  }
  return redacted;
}

function redactPageError(record: PageErrorRecord): PageErrorRecord {
  const redacted: PageErrorRecord = {
    message: redactText(record.message),
  };
  if (record.url !== undefined) {
    redacted.url = redactText(record.url);
  }
  return redacted;
}

function redactArtifacts(artifacts: RunResult["artifacts"]): RunResult["artifacts"] {
  const trace = artifacts.trace;
  return {
    screenshots: artifacts.screenshots.map(redactText),
    ...(trace === undefined ? {} : { trace: redactText(trace) }),
  };
}

function redactFailure(
  failure: NonNullable<RunResult["failure"]>,
): NonNullable<RunResult["failure"]> {
  const redacted: NonNullable<RunResult["failure"]> = {
    category: redactCategory(failure.category),
    message: redactText(failure.message),
  };
  if (failure.stepId !== undefined) {
    redacted.stepId = redactText(failure.stepId);
  }
  return redacted;
}

function redactCategory(category: FailureCategory): FailureCategory {
  const redacted = redactText(category);
  if (!isFailureCategory(redacted)) {
    throw new Error("Invalid failure category");
  }
  return redacted;
}

function isFailureCategory(value: string): value is FailureCategory {
  return (
    value === "assertion" ||
    value === "locator" ||
    value === "navigation" ||
    value === "network" ||
    value === "timeout" ||
    value === "runtime"
  );
}

function parseRunResult(value: unknown): RunResult {
  if (!isRecord(value)) {
    throw new Error("Invalid run result");
  }
  if (!isRunStatus(value.status)) {
    throw new Error("Invalid run result field: status");
  }
  if (!isRecord(value.network) || !isRecord(value.console)) {
    throw new Error("Invalid run result");
  }
  if (
    !Array.isArray(value.steps) ||
    !Array.isArray(value.network.failedRequests) ||
    !Array.isArray(value.network.responses) ||
    !Array.isArray(value.console.errors) ||
    !Array.isArray(value.console.warnings) ||
    !Array.isArray(value.pageErrors)
  ) {
    throw new Error("Invalid run result");
  }

  const result: RunResult = {
    runId: expectString(value.runId, "runId"),
    flowId: expectString(value.flowId, "flowId"),
    status: value.status,
    startedAt: expectString(value.startedAt, "startedAt"),
    durationMs: expectNumber(value.durationMs, "durationMs"),
    steps: value.steps.map((step, index) => parseStep(step, `steps.${index}`)),
    network: {
      failedRequests: value.network.failedRequests.map((item, index) =>
        parseNetwork(item, `network.failedRequests.${index}`),
      ),
      responses: value.network.responses.map((item, index) =>
        parseNetwork(item, `network.responses.${index}`),
      ),
    },
    console: {
      errors: value.console.errors.map((item, index) =>
        parseConsole(item, `console.errors.${index}`),
      ),
      warnings: value.console.warnings.map((item, index) =>
        parseConsole(item, `console.warnings.${index}`),
      ),
    },
    pageErrors: value.pageErrors.map((item, index) =>
      parsePageError(item, `pageErrors.${index}`),
    ),
    artifacts: parseArtifacts(value.artifacts),
  };
  if (value.failure !== undefined) {
    const failure = parseFailure(value.failure);
    if (failure !== undefined) {
      result.failure = failure;
    }
  }
  return result;
}

function parseStep(value: unknown, field: string): StepResult {
  if (!isRecord(value) || !isRunStatus(value.status)) {
    throw new Error(`Invalid run result field: ${field}`);
  }
  const step: StepResult = {
    stepId: expectString(value.stepId, `${field}.stepId`),
    status: value.status,
    startedAt: expectString(value.startedAt, `${field}.startedAt`),
    durationMs: expectNumber(value.durationMs, `${field}.durationMs`),
  };
  if (value.error !== undefined) {
    step.error = expectString(value.error, `${field}.error`);
  }
  return step;
}

function parseNetwork(value: unknown, field: string): NetworkRecord {
  if (!isRecord(value)) {
    throw new Error(`Invalid run result field: ${field}`);
  }
  const record: NetworkRecord = {
    method: expectString(value.method, `${field}.method`),
    url: expectString(value.url, `${field}.url`),
    status: expectNumber(value.status, `${field}.status`),
    timing: expectNumber(value.timing, `${field}.timing`),
    headers: parseHeaders(value.headers, `${field}.headers`),
  };
  if (value.body !== undefined) {
    record.body = expectString(value.body, `${field}.body`);
  }
  return record;
}

function parseHeaders(value: unknown, field: string): Record<string, string> {
  if (!isRecord(value)) {
    throw new Error(`Invalid run result field: ${field}`);
  }
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    headers[name] = expectString(headerValue, `${field}.${name}`);
  }
  return headers;
}

function parseConsole(value: unknown, field: string): ConsoleRecord {
  if (
    !isRecord(value) ||
    (value.level !== "warning" && value.level !== "error")
  ) {
    throw new Error(`Invalid run result field: ${field}`);
  }
  const record: ConsoleRecord = {
    level: value.level,
    text: expectString(value.text, `${field}.text`),
  };
  if (value.url !== undefined) {
    record.url = expectString(value.url, `${field}.url`);
  }
  return record;
}

function parsePageError(value: unknown, field: string): PageErrorRecord {
  if (!isRecord(value)) {
    throw new Error(`Invalid run result field: ${field}`);
  }
  const record: PageErrorRecord = {
    message: expectString(value.message, `${field}.message`),
  };
  if (value.url !== undefined) {
    record.url = expectString(value.url, `${field}.url`);
  }
  return record;
}

function parseArtifacts(value: unknown): RunResult["artifacts"] {
  if (!isRecord(value) || !Array.isArray(value.screenshots)) {
    throw new Error("Invalid run result field: artifacts");
  }
  const screenshots = value.screenshots.map((item, index) => {
    const artifactPath = expectString(item, `artifacts.screenshots.${index}`);
    assertRelativeSafe(artifactPath);
    return artifactPath;
  });
  const artifacts: RunResult["artifacts"] = { screenshots };
  if (value.trace !== undefined) {
    const trace = expectString(value.trace, "artifacts.trace");
    assertRelativeSafe(trace);
    artifacts.trace = trace;
  }
  return artifacts;
}

function parseFailure(value: unknown): RunResult["failure"] {
  if (!isRecord(value) || !isFailureCategoryValue(value.category)) {
    throw new Error("Invalid run result field: failure");
  }
  const failure: NonNullable<RunResult["failure"]> = {
    category: value.category,
    message: expectString(value.message, "failure.message"),
  };
  if (value.stepId !== undefined) {
    failure.stepId = expectString(value.stepId, "failure.stepId");
  }
  return failure;
}

function isFailureCategoryValue(value: unknown): value is FailureCategory {
  return typeof value === "string" && isFailureCategory(value);
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Invalid run result field: ${field}`);
  }
  return value;
}

function expectNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid run result field: ${field}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
