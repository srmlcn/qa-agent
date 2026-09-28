import { readProfilePath } from "../auth/store.js";
import type { ProjectConfig } from "../config/schema.js";
import { startRun, type RunBuilder } from "../evidence/result.js";
import { writeRun } from "../evidence/store.js";
import type { RunResult } from "../evidence/types.js";
import type { QaError } from "../errors/qa-error.js";
import { compile } from "../flows/compiler.js";
import { save } from "../flows/repository.js";
import type { FlowSpec } from "../flows/schema.js";
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
 * trajectory, replays it from that start URL, and saves the validated flow.
 * A replay failure saves the draft and returns that draft with the run error.
 * Destructive step intents are refused after compile and before replay.
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

  const replayed = await replayDraft(input, draft, runId, signal, storageState);
  const flow = replayed.ok ? replayed.flow : draft;
  const builder = startRun({ runId, flowId: input.id });
  if (replayed.ok) {
    recordPassed(builder, flow);
  } else {
    recordFailure(builder, draft, replayed.error);
  }
  save(input.projectRoot, flow);
  const result = builder.finish();
  complete(runId, result);
  writeRun(input.projectRoot, result);
  return { runId, flow, result };
}

async function replayDraft(
  input: DiscoverFlowInput,
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
    await openReplayStart(session.page, input, flow);
    return await validateFlow({
      flow,
      page: session.page,
      timeoutMs: input.config.playwright.timeoutMs,
    });
  } finally {
    await session?.close();
  }
}

/**
 * The discovery browser is already closed, so this page is `about:blank`.
 * `openStartUrl` is not a compiled step. Open the allowlisted start URL
 * before the compiled steps, unless the draft already begins with that `goto`.
 */
async function openReplayStart(
  page: BrowserSession["page"],
  input: DiscoverFlowInput,
  flow: FlowSpec,
): Promise<void> {
  const startUrl = resolveStartUrl(input);
  assertUrlAllowed(startUrl, input.config);
  if (startsWithStartGoto(flow, startUrl)) {
    return;
  }
  await page.goto(startUrl, {
    waitUntil: "domcontentloaded",
    timeout: input.config.playwright.timeoutMs,
  });
}

function resolveStartUrl(input: DiscoverFlowInput): string {
  return input.startUrl ?? input.config.application.baseUrl;
}

function startsWithStartGoto(flow: FlowSpec, startUrl: string): boolean {
  const first = flow.steps[0] as { action?: unknown; value?: unknown } | undefined;
  return first?.action === "goto" && first.value === startUrl;
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
    builder.stepFailed(first === undefined ? "validation" : stepIdOf(first), error);
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
