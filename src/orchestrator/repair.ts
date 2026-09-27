import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readProfilePath } from "../auth/store.js";
import type { ProjectConfig } from "../config/schema.js";
import { startRun, type RunBuilder } from "../evidence/result.js";
import { createRunDir, readRun, writeRun } from "../evidence/store.js";
import type { RunResult } from "../evidence/types.js";
import { QaError } from "../errors/qa-error.js";
import { compile } from "../flows/compiler.js";
import { read, save } from "../flows/repository.js";
import type { FlowSpec } from "../flows/schema.js";
import { stringifyFlow } from "../flows/serialize.js";
import { transition } from "../flows/state.js";
import { validateFlow } from "../flows/validator.js";
import { startBrowser, type BrowserSession } from "../playwright/runtime.js";
import { assertUrlAllowed } from "../security/hosts.js";
import { assertActionAllowed } from "../security/policy.js";
import type { LlmProvider } from "../stagehand/provider.js";
import { discover, type DiscoverOptions } from "../stagehand/session.js";
import { complete, createRun, setOnCancel } from "./runs.js";

/**
 * `startBrowser` applies one timeout to process launch and to the page.
 * Locator waits use `playwright.timeoutMs`. Launch keeps a floor so a short
 * action timeout cannot abort Chromium startup.
 */
const MIN_LAUNCH_TIMEOUT_MS = 30_000;
const PRIVATE_FILE_MODE = 0o600;
const PREVIOUS_FLOW_FILE = "previous-flow.yml";

export type RepairFlowInput = {
  flowId: string;
  failedStepId: string;
  /** Original failed run. Its `result.json` is left in place. */
  runId: string;
  projectRoot: string;
  config: ProjectConfig;
  provider: LlmProvider;
  /** Session client. Tests pass a fake client; omit it to use Stagehand. */
  client?: DiscoverOptions["client"];
};

export type RepairFlowResult =
  | {
      repaired: false;
      reason: "product-failure";
      runId: string;
    }
  | {
      repaired: false;
      reason: "replay-failure";
      runId: string;
      repairRunId: string;
      result: RunResult;
    }
  | {
      repaired: true;
      runId: string;
      repairRunId: string;
      flow: FlowSpec;
      result: RunResult;
    };

/**
 * Repairs a stale flow when the failed run's category is `locator`.
 * Any other category is a product failure: the discovery client is not called.
 * A successful replay follows stale -> repaired -> validated and archives the
 * previous spec under the original run. The original run result stays readable.
 */
export async function repairFlow(
  input: RepairFlowInput,
): Promise<RepairFlowResult> {
  const stored = read(input.projectRoot, input.flowId);
  const failedRun = loadFailedRun(input.projectRoot, input.runId, input.flowId);
  if (failedRun.failure?.category !== "locator") {
    return {
      repaired: false,
      reason: "product-failure",
      runId: input.runId,
    };
  }

  const failedStep = findStep(stored, input.failedStepId);
  const objective = joinObjective(
    stored.objective,
    semanticFallbackOf(failedStep),
  );
  const startUrl = input.config.application.baseUrl;
  assertUrlAllowed(startUrl, input.config);

  const storageState =
    stored.authProfile === undefined
      ? undefined
      : readProfilePath(input.config.project.id, stored.authProfile);

  const { runId: repairRunId, signal } = createRun(input.flowId);
  const trajectory = await discover({
    objective,
    startUrl,
    config: input.config,
    provider: input.provider,
    maxSteps: input.config.stagehand.maxSteps,
    signal,
    ...(input.client === undefined ? {} : { client: input.client }),
  });

  const compiled = compile(trajectory, {
    id: stored.id,
    name: stored.name,
    objective: stored.objective,
    ...(stored.authProfile === undefined
      ? {}
      : { authProfile: stored.authProfile }),
  });

  for (const step of compiled.steps) {
    assertActionAllowed(stepPolicy(step), input.config);
  }

  // `transition` does not replace steps. Take the legal stale edge, then
  // substitute the compiled steps before `validate` moves repaired to validated.
  const marked = transition(stored, "mark-repaired");
  const candidate: FlowSpec = {
    ...marked,
    steps: compiled.steps,
    assertions: stored.assertions,
  };

  const replayed = await replayCandidate(
    input,
    candidate,
    repairRunId,
    signal,
    storageState,
  );
  const builder = startRun({ runId: repairRunId, flowId: input.flowId });
  if (replayed.ok) {
    recordPassed(builder, replayed.flow);
    save(input.projectRoot, replayed.flow);
    writePreviousFlow(input.projectRoot, input.runId, stored);
  } else {
    recordFailure(builder, candidate, replayed.error);
  }

  const result = builder.finish();
  complete(repairRunId, result);
  writeRun(input.projectRoot, result);

  if (replayed.ok) {
    return {
      repaired: true,
      runId: input.runId,
      repairRunId,
      flow: replayed.flow,
      result,
    };
  }

  return {
    repaired: false,
    reason: "replay-failure",
    runId: input.runId,
    repairRunId,
    result,
  };
}

function loadFailedRun(
  projectRoot: string,
  runId: string,
  flowId: string,
): RunResult {
  try {
    return readRun(projectRoot, runId);
  } catch (error) {
    if (isMissingRun(error)) {
      throw new QaError({
        code: "FLOW_VALIDATION_FAILED",
        message: "run not found",
        runId,
        flowId,
      });
    }
    throw error;
  }
}

function isMissingRun(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Run not found:");
}

function findStep(
  flow: FlowSpec,
  stepId: string,
): FlowSpec["steps"][number] {
  const step = flow.steps.find((candidate) => stepIdOf(candidate) === stepId);
  if (step === undefined) {
    throw new QaError({
      code: "FLOW_VALIDATION_FAILED",
      message: `step not found: ${stepId}`,
      flowId: flow.id,
      stepId,
    });
  }
  return step;
}

function joinObjective(objective: string, fallback: string | undefined): string {
  if (fallback === undefined) {
    return objective;
  }
  return `${objective}\n${fallback}`;
}

function semanticFallbackOf(
  step: FlowSpec["steps"][number],
): string | undefined {
  const fallback = (step as { semanticFallback?: unknown }).semanticFallback;
  if (typeof fallback !== "string") {
    return undefined;
  }
  const trimmed = fallback.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function replayCandidate(
  input: RepairFlowInput,
  flow: FlowSpec,
  runId: string,
  signal: AbortSignal,
  storageState: string | undefined,
): Promise<Awaited<ReturnType<typeof validateFlow>>> {
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
    session = await startBrowser({
      browser: input.config.playwright.browser,
      headless: input.config.playwright.headless,
      timeoutMs: Math.max(
        input.config.playwright.timeoutMs,
        MIN_LAUNCH_TIMEOUT_MS,
      ),
      signal,
      ...(storageState === undefined ? {} : { storageState }),
    });
    return await validateFlow({
      flow,
      page: session.page,
      timeoutMs: input.config.playwright.timeoutMs,
    });
  } finally {
    await session?.close();
  }
}

function writePreviousFlow(
  projectRoot: string,
  runId: string,
  flow: FlowSpec,
): void {
  const runDir = createRunDir(projectRoot, runId);
  const filePath = join(runDir, PREVIOUS_FLOW_FILE);
  writeFileSync(filePath, stringifyFlow(flow, "yaml"), {
    encoding: "utf8",
    mode: PRIVATE_FILE_MODE,
  });
  chmodSync(filePath, PRIVATE_FILE_MODE);
}

function recordPassed(builder: RunBuilder, flow: FlowSpec): void {
  for (const step of flow.steps) {
    builder.stepPassed(stepIdOf(step));
  }
}

/**
 * `validateFlow` stops at the first replay failure. Steps before that id ran.
 */
function recordFailure(
  builder: RunBuilder,
  flow: FlowSpec,
  error: QaError,
): void {
  const failedAt = error.stepId;
  const first = flow.steps[0];
  if (failedAt === undefined) {
    builder.stepFailed(
      first === undefined ? "validation" : stepIdOf(first),
      error,
    );
    return;
  }

  let recorded = false;
  for (const step of flow.steps) {
    const id = stepIdOf(step);
    if (id === failedAt) {
      builder.stepFailed(id, error);
      recorded = true;
      break;
    }
    builder.stepPassed(id);
  }
  if (!recorded) {
    builder.stepFailed(failedAt, error);
  }
}

/**
 * Zod's inferred step union keeps `action` and drops the other fields.
 * The compiled object still has `id` and `intent` at runtime.
 */
function stepPolicy(step: FlowSpec["steps"][number]): {
  id: string;
  intent: string;
} {
  return { id: stepIdOf(step), intent: stepIntentOf(step) };
}

function stepIdOf(step: FlowSpec["steps"][number]): string {
  const id = (step as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : "step";
}

function stepIntentOf(step: FlowSpec["steps"][number]): string {
  const intent = (step as { intent?: unknown }).intent;
  return typeof intent === "string" ? intent : "";
}
