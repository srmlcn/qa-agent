import { materializeEvidence } from "../config/materialize-evidence.js";
import type { ProjectConfig } from "../config/schema.js";
import { applyCapture } from "../evidence/console.js";
import { startCapture, type CaptureSession } from "../evidence/network.js";
import { startRun, type RunBuilder } from "../evidence/result.js";
import { screenshotAfter } from "../evidence/screenshots.js";
import {
  finalizeVideo,
  recordVideoDir,
  shouldRecordVideo,
} from "../evidence/video.js";
import { attach, createRunDir, writeRun } from "../evidence/store.js";
import { startTrace, stopTrace, type TraceMode } from "../evidence/traces.js";
import type { RunResult } from "../evidence/types.js";
import { QaError } from "../errors/qa-error.js";
import { readProfilePath } from "../auth/store.js";
import { interpolateFlow, type FlowInputs } from "../flows/interpolate.js";
import { read, save } from "../flows/repository.js";
import type { FlowSpec, Locator } from "../flows/schema.js";
import { transition } from "../flows/state.js";
import { runAction } from "../playwright/actions.js";
import { runAssertion } from "../playwright/assertions.js";
import { startBrowser, type BrowserSession } from "../playwright/runtime.js";
import { redactBody } from "../security/redaction.js";
import { assertUrlAllowed } from "../security/hosts.js";
import { createRun, complete, setOnCancel } from "./runs.js";

const MAX_MESSAGE_CHARS = 500;
/**
 * `startBrowser` applies one timeout to process launch and to the page.
 * Locator waits use `playwright.timeoutMs`. Launch keeps a floor so a short
 * action timeout cannot abort Chromium startup.
 */
const MIN_LAUNCH_TIMEOUT_MS = 30_000;

export type ExecuteFlowOptions = {
  flowId: string;
  inputs: FlowInputs;
  /** Overrides `flow.authProfile` when set. The storage-state file is not read here. */
  authProfile?: string;
  projectRoot: string;
  config: ProjectConfig;
  /** Chromium stays headless unless this is true. */
  headed?: boolean;
  /**
   * When false, the in-progress trace is stopped with mode `off` and no zip is kept.
   * When true, a failure trace is kept even if config trace is `off`.
   * When omitted, `config.evidence.trace` decides.
   */
  collectTrace?: boolean;
};

export type ExecuteFlowResult = {
  runId: string;
  result: RunResult;
};

type PreparedFlow = {
  stored: FlowSpec;
  flow: FlowSpec;
  storageState?: string;
};

/**
 * Replays one saved flow with Playwright and returns the recorded run.
 * A locator failure marks the stored flow stale and does not rewrite its steps.
 * An assertion failure leaves the stored flow as it was.
 */
export async function executeFlow(
  options: ExecuteFlowOptions,
): Promise<ExecuteFlowResult> {
  const config: ProjectConfig = {
    ...options.config,
    evidence: materializeEvidence(options.config.evidence),
  };
  const runOptions: ExecuteFlowOptions = { ...options, config };
  const { runId, signal } = createRun(runOptions.flowId);
  let session: BrowserSession | undefined;
  setOnCancel(runId, () => {
    if (session === undefined) {
      return;
    }
    void session.close().catch(() => {
      // The abort signal already stops the run. Close failures surface from `finally`.
    });
  });

  try {
    const prepared = prepareFlow(runOptions);
    const runDir = createRunDir(runOptions.projectRoot, runId);
    const recordVideo = shouldRecordVideo(config.evidence.video)
      ? {
          dir: recordVideoDir(runDir),
          size: config.evidence.video.size,
        }
      : undefined;
    session = await startBrowser({
      browser: config.playwright.browser,
      headless: runOptions.headed !== true,
      timeoutMs: Math.max(
        config.playwright.timeoutMs,
        MIN_LAUNCH_TIMEOUT_MS,
      ),
      signal,
      ...(prepared.storageState === undefined
        ? {}
        : { storageState: prepared.storageState }),
      ...(recordVideo === undefined ? {} : { recordVideo }),
    });
    const result = await runSession(
      runOptions,
      prepared,
      session,
      runId,
      signal,
      runDir,
    );
    complete(runId, result);
    writeRun(runOptions.projectRoot, result);
    return { runId, result };
  } finally {
    await session?.close();
  }
}

function prepareFlow(options: ExecuteFlowOptions): PreparedFlow {
  const stored = read(options.projectRoot, options.flowId);
  const interpolated = interpolateFlow(stored, options.inputs);
  assertFlowUrls(interpolated, options.config);
  const profile = options.authProfile ?? stored.authProfile;
  const prepared: PreparedFlow = {
    stored,
    flow: withAbsoluteGotos(interpolated, options.config.application.baseUrl),
  };
  if (profile !== undefined) {
    prepared.storageState = readProfilePath(options.config.project.id, profile);
  }
  return prepared;
}

async function runSession(
  options: ExecuteFlowOptions,
  prepared: PreparedFlow,
  session: BrowserSession,
  runId: string,
  signal: AbortSignal,
  runDir: string,
): Promise<RunResult> {
  const capture = await startCapture(session.page, {
    evidence: {
      network: options.config.evidence.network,
      console: options.config.evidence.console,
      maxResponseBodyBytes: options.config.evidence.maxResponseBodyBytes,
    },
    redactHeaderNames: options.config.security.redactHeaders,
  });
  let tracing = false;
  let captureStopped = false;
  try {
    await startTrace(session.context);
    tracing = true;
    const screenshots: string[] = [];
    const builder = startRun({ runId, flowId: options.flowId });
    const locatorFailed = await runSteps(
      session,
      prepared.flow,
      builder,
      screenshots,
      runDir,
      options.config.playwright.timeoutMs,
      signal,
      runId,
      options.config,
    );
    if (locatorFailed) {
      markStoredFlowStale(options.projectRoot, prepared.stored);
    }
    await capture.stop();
    captureStopped = true;
    const result = builder.finish();
    applyCapture(result, capture.capture);
    const trace = await stopTrace(session.context, {
      failed: result.status !== "passed",
      dest: runDir,
      mode: traceModeFor(options),
    });
    tracing = false;
    const video = await collectVideoArtifact(
      session,
      runDir,
      options.config.evidence.video,
      result.status === "passed",
    );
    attach(result, {
      screenshots,
      ...(trace === undefined ? {} : { trace }),
      ...(video === undefined ? {} : { video }),
    });
    return result;
  } finally {
    await stopEvidence(capture, captureStopped, session, tracing, runDir, options);
  }
}

/**
 * `false` discards the trace. `true` keeps one after a failure.
 * An omitted flag leaves the project trace mode unchanged.
 */
function traceModeFor(options: ExecuteFlowOptions): TraceMode {
  if (options.collectTrace === false) {
    return "off";
  }
  if (options.collectTrace === true) {
    return "on-failure";
  }
  return options.config.evidence.trace;
}

async function stopEvidence(
  capture: CaptureSession,
  captureStopped: boolean,
  session: BrowserSession,
  tracing: boolean,
  runDir: string,
  options: ExecuteFlowOptions,
): Promise<void> {
  if (!captureStopped) {
    await capture.stop().catch(() => {
      // The step result is already decided. Listener cleanup must not replace it.
    });
  }
  if (!tracing) {
    return;
  }
  await stopTrace(session.context, {
    failed: true,
    dest: runDir,
    mode: traceModeFor(options),
  }).catch(() => {
    // A trace that cannot be saved still leaves the recorded step result.
  });
}

async function runSteps(
  session: BrowserSession,
  flow: FlowSpec,
  builder: RunBuilder,
  screenshots: string[],
  runDir: string,
  timeoutMs: number,
  signal: AbortSignal,
  runId: string,
  config: ProjectConfig,
): Promise<boolean> {
  let locatorFailed = false;
  for (const step of flow.steps) {
    const stepId = stepIdOf(step);
    if (signal.aborted) {
      builder.stepFailed(stepId, cancelledStep(signal, stepId, runId, flow.id));
      return locatorFailed;
    }
    try {
      await runAction(session.page, step, timeoutMs);
      const shot = await screenshotAfter(
        session.page,
        stepId,
        runDir,
        flow.evidence,
        captureContext(config, step, false),
      );
      if (shot !== undefined) {
        screenshots.push(shot);
      }
      builder.stepPassed(stepId);
    } catch (error) {
      // Cancel closes the page while the action is still running. The
      // closed-target error must stay a cancellation, including when it
      // already arrived as a page error. `asQaError` still wraps other
      // non-QaError failures as PAGE_ERROR.
      const qaError = signal.aborted
        ? cancelledStep(signal, stepId, runId, flow.id)
        : asQaError(error, stepId, runId, flow.id);
      builder.stepFailed(stepId, qaError);
      const failureShot = await screenshotAfter(
        session.page,
        stepId,
        runDir,
        flow.evidence,
        captureContext(config, step, true),
      );
      if (failureShot !== undefined) {
        screenshots.push(failureShot);
      }
      if (qaError.code === "LOCATOR_STALE") {
        locatorFailed = true;
      }
      return locatorFailed;
    }
  }

  for (const assertion of flow.assertions) {
    const stepId = assertionIdOf(assertion);
    if (signal.aborted) {
      builder.stepFailed(stepId, cancelledStep(signal, stepId, runId, flow.id));
      return locatorFailed;
    }
    try {
      await runAssertion(session.page, assertion, timeoutMs);
      builder.stepPassed(stepId);
    } catch (error) {
      // Cancel closes the page while the assertion is still running.
      const qaError = signal.aborted
        ? cancelledStep(signal, stepId, runId, flow.id)
        : asQaError(error, stepId, runId, flow.id);
      builder.stepFailed(stepId, qaError);
      if (qaError.code === "LOCATOR_STALE") {
        locatorFailed = true;
      }
      return locatorFailed;
    }
  }

  return locatorFailed;
}

/**
 * `mark-stale` is legal only from `validated` or `stable`.
 * Other states keep their stored steps and state. The run result still returns.
 */
function markStoredFlowStale(projectRoot: string, stored: FlowSpec): void {
  if (stored.state !== "validated" && stored.state !== "stable") {
    return;
  }
  save(projectRoot, transition(stored, "mark-stale"));
}

function assertFlowUrls(flow: FlowSpec, config: ProjectConfig): void {
  const baseUrl = config.application.baseUrl;
  assertUrlAllowed(baseUrl, config);
  for (const value of gotoValues(flow)) {
    assertUrlAllowed(resolveAgainstBase(value, baseUrl), config);
  }
}

function withAbsoluteGotos(flow: FlowSpec, baseUrl: string): FlowSpec {
  const copy = structuredClone(flow);
  for (const step of copy.steps) {
    const value = gotoValue(step);
    if (value !== undefined) {
      writeGotoValue(step, resolveAgainstBase(value, baseUrl));
    }
  }
  for (const assertion of copy.assertions) {
    if (assertion.type !== "sequence") {
      continue;
    }
    for (const entry of assertion.sequence) {
      const value = gotoValue(entry);
      if (value !== undefined) {
        writeGotoValue(entry, resolveAgainstBase(value, baseUrl));
      }
    }
  }
  return copy;
}

function gotoValues(flow: FlowSpec): string[] {
  const values: string[] = [];
  for (const step of flow.steps) {
    const value = gotoValue(step);
    if (value !== undefined) {
      values.push(value);
    }
  }
  for (const assertion of flow.assertions) {
    if (assertion.type !== "sequence") {
      continue;
    }
    for (const entry of assertion.sequence) {
      const value = gotoValue(entry);
      if (value !== undefined) {
        values.push(value);
      }
    }
  }
  return values;
}

/**
 * Zod's inferred step union keeps `action` and drops the other fields.
 * The stored object still has `id` and `value` at runtime.
 */
async function collectVideoArtifact(
  session: BrowserSession,
  destDir: string,
  plan: ProjectConfig["evidence"]["video"],
  runPassed: boolean,
): Promise<string | undefined> {
  if (!plan.enabled) {
    return undefined;
  }
  await session.page.close();
  await session.context.close();
  const finalized = await finalizeVideo({
    context: session.context,
    page: session.page,
    destDir,
    plan,
    runPassed,
  });
  return finalized.path;
}

function captureContext(
  config: ProjectConfig,
  step: FlowSpec["steps"][number],
  isFailure: boolean,
): {
  projectEvidence: ProjectConfig["evidence"];
  stepAction: string;
  stepLocator?: Locator;
  isFailure: boolean;
} {
  return {
    projectEvidence: config.evidence,
    stepAction: step.action,
    stepLocator: stepLocatorOf(step),
    isFailure,
  };
}

function stepLocatorOf(step: FlowSpec["steps"][number]): Locator | undefined {
  const locator = (step as { locator?: Locator }).locator;
  return locator;
}

function stepIdOf(step: FlowSpec["steps"][number]): string {
  const id = (step as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : "step";
}

function assertionIdOf(assertion: FlowSpec["assertions"][number]): string {
  const id = (assertion as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : "assertion";
}

function gotoValue(step: unknown): string | undefined {
  if (!isGoto(step)) {
    return undefined;
  }
  return step.value;
}

function writeGotoValue(step: unknown, value: string): void {
  if (isGoto(step)) {
    step.value = value;
  }
}

function isGoto(step: unknown): step is { action: "goto"; value: string } {
  if (typeof step !== "object" || step === null) {
    return false;
  }
  const record = step as { action?: unknown; value?: unknown };
  return record.action === "goto" && typeof record.value === "string";
}

function resolveAgainstBase(value: string, baseUrl: string): string {
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return value;
  }
}

function asQaError(
  error: unknown,
  stepId: string,
  runId: string,
  flowId: string,
): QaError {
  if (error instanceof QaError) {
    return error;
  }
  const message = error instanceof Error ? error.message : "Step failed.";
  return new QaError({
    code: "PAGE_ERROR",
    message: redactBody(message, MAX_MESSAGE_CHARS),
    runId,
    flowId,
    stepId,
  });
}

function cancelledStep(
  signal: AbortSignal,
  stepId: string,
  runId: string,
  flowId: string,
): QaError {
  if (signal.reason instanceof QaError) {
    return signal.reason;
  }
  return new QaError({
    code: "RUN_CANCELLED",
    message: "run cancelled",
    runId,
    flowId,
    stepId,
  });
}
