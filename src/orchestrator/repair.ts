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
import { assertUrlAllowed } from "../security/hosts.js";
import { assertActionAllowed } from "../security/policy.js";
import type { LlmProvider } from "../stagehand/provider.js";
import { discover, type DiscoverOptions } from "../stagehand/session.js";
import { complete, createRun } from "./runs.js";

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
      repaired: true;
      runId: string;
      repairRunId: string;
      flow: FlowSpec;
      result: RunResult;
    };

/**
 * Repairs a stale flow when the failed run's category is `locator`.
 * The stored run must belong to this flow. A missing run and a run recorded
 * for a different flow are both `run not found`, and neither starts discovery.
 * Any other category is a product failure: the discovery client is not called.
 * A successful discovery follows stale -> repaired -> validated and archives the
 * previous spec under the original run. The clicks are not replayed. The
 * original run result stays readable.
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
    ...(storageState === undefined ? {} : { storageState }),
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
  const flow = transition(
    {
      ...marked,
      steps: compiled.steps,
      assertions: stored.assertions,
    },
    "validate",
  );

  const builder = startRun({ runId: repairRunId, flowId: input.flowId });
  recordPassed(builder, flow);
  save(input.projectRoot, flow);
  writePreviousFlow(input.projectRoot, input.runId, stored);

  const result = builder.finish();
  complete(repairRunId, result);
  writeRun(input.projectRoot, result);

  return {
    repaired: true,
    runId: input.runId,
    repairRunId,
    flow,
    result,
  };
}

function loadFailedRun(
  projectRoot: string,
  runId: string,
  flowId: string,
): RunResult {
  const failedRun = readStoredRun(projectRoot, runId, flowId);
  if (failedRun.flowId !== flowId) {
    throw runNotFound(runId, flowId);
  }
  return failedRun;
}

function readStoredRun(
  projectRoot: string,
  runId: string,
  flowId: string,
): RunResult {
  try {
    return readRun(projectRoot, runId);
  } catch (error) {
    if (isMissingRun(error)) {
      throw runNotFound(runId, flowId);
    }
    throw error;
  }
}

function runNotFound(runId: string, flowId: string): QaError {
  return new QaError({
    code: "FLOW_VALIDATION_FAILED",
    message: "run not found",
    runId,
    flowId,
  });
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
