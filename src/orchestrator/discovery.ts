import { readProfilePath } from "../auth/store.js";
import type { ProjectConfig } from "../config/schema.js";
import { startRun, type RunBuilder } from "../evidence/result.js";
import { writeRun } from "../evidence/store.js";
import type { RunResult } from "../evidence/types.js";
import { compile } from "../flows/compiler.js";
import { save } from "../flows/repository.js";
import type { FlowSpec } from "../flows/schema.js";
import { transition } from "../flows/state.js";
import { assertUrlAllowed } from "../security/hosts.js";
import { assertActionAllowed } from "../security/policy.js";
import type { LlmProvider } from "../stagehand/provider.js";
import { discover, type DiscoverOptions } from "../stagehand/session.js";
import { complete, createRun } from "./runs.js";

export type DiscoverFlowInput = {
  /** Stable flow id passed to the compiler and the run registry. */
  id: string;
  name: string;
  objective: string;
  /** Checked before discovery. Defaults to `application.baseUrl`. */
  startUrl?: string;
  /** Loaded before discovery. A missing file throws `AUTH_MISSING`. */
  authProfile?: string;
  projectRoot: string;
  config: ProjectConfig;
  provider: LlmProvider;
  /** Defaults to `config.stagehand.maxSteps`. */
  maxSteps?: number;
  /** Session client. Tests pass a fake client; omit it to use Stagehand. */
  client?: DiscoverOptions["client"];
};

export type DiscoverFlowResult = {
  runId: string;
  flow: FlowSpec;
  result: RunResult;
};

/**
 * Checks the start URL, runs a bounded discovery session, compiles the
 * trajectory, and saves the validated flow.
 * A successful Stagehand trajectory is the proof that each click was possible.
 * Those clicks are not replayed: the page they leave behind can hide a control
 * that existed only in the state the click started from.
 * Destructive step intents are refused after compile and before the flow is saved.
 */
export async function discoverFlow(
  input: DiscoverFlowInput,
): Promise<DiscoverFlowResult> {
  const { runId, signal } = createRun(input.id);
  const startUrl = resolveStartUrl(input);
  assertUrlAllowed(startUrl, input.config);

  const storageState =
    input.authProfile === undefined
      ? undefined
      : readProfilePath(input.config.project.id, input.authProfile);

  const trajectory = await discover({
    objective: input.objective,
    startUrl,
    config: input.config,
    provider: input.provider,
    maxSteps: input.maxSteps ?? input.config.stagehand.maxSteps,
    signal,
    ...(storageState === undefined ? {} : { storageState }),
    ...(input.client === undefined ? {} : { client: input.client }),
  });

  const draft = compile(trajectory, {
    id: input.id,
    name: input.name,
    objective: input.objective,
    ...(input.authProfile === undefined
      ? {}
      : { authProfile: input.authProfile }),
  });

  for (const step of draft.steps) {
    assertActionAllowed(stepPolicy(step), input.config);
  }

  assertCompiledGotoUrls(draft, input.config);
  const flow = transition(draft, "validate");
  const builder = startRun({ runId, flowId: input.id });
  recordPassed(builder, flow);
  save(input.projectRoot, flow);
  const result = builder.finish();
  complete(runId, result);
  writeRun(input.projectRoot, result);
  return { runId, flow, result };
}

/**
 * Relative goto values resolve against `application.baseUrl`, matching
 * execution. Each target must be allowlisted before the flow is saved.
 */
function assertCompiledGotoUrls(flow: FlowSpec, config: ProjectConfig): void {
  const baseUrl = config.application.baseUrl;
  for (const value of gotoValues(flow)) {
    assertUrlAllowed(resolveAgainstBase(value, baseUrl), config);
  }
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

function gotoValue(step: unknown): string | undefined {
  if (!isGoto(step)) {
    return undefined;
  }
  return step.value;
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

function resolveStartUrl(input: DiscoverFlowInput): string {
  return input.startUrl ?? input.config.application.baseUrl;
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
function stepPolicy(step: FlowSpec["steps"][number]): { id: string; intent: string } {
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
