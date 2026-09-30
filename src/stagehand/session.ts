import type { ProjectConfig } from "../config/schema.js";
import { QaError } from "../errors/qa-error.js";
import { assertUrlAllowed } from "../security/hosts.js";
import { assertStepsRemaining } from "../security/policy.js";
import { startBrowser } from "../playwright/runtime.js";
import type { DiscoveryClient } from "./fake-client.js";
import { createStagehand, requireApiKey } from "./llm-client.js";
import type { LlmProvider } from "./provider.js";
import {
  fromAgentResult,
  type AgentResultLike,
  type DiscoveryTrajectory,
} from "./trajectory.js";

/**
 * Injected discovery client. `close` is optional so the fake client can be
 * passed through. When present, it runs on abort and in `finally`.
 */
export type DiscoverySessionClient = DiscoveryClient & {
  close?: () => Promise<void> | void;
};

export type DiscoverOptions = {
  objective: string;
  startUrl: string;
  config: ProjectConfig;
  provider: LlmProvider;
  maxSteps: number;
  signal?: AbortSignal;
  /** When omitted, a local Stagehand session runs in DOM mode. */
  client?: DiscoverySessionClient;
};

type Closable = {
  close: () => Promise<void>;
};

type SessionResources = {
  stagehand?: Closable;
  browser?: Closable;
  clientClose?: () => Promise<void>;
};

/**
 * Loads `startUrl` and runs discovery until the objective succeeds or the
 * step cap is hit. Returns a trajectory and does not compile or save a flow.
 */
export async function discover(
  options: DiscoverOptions,
): Promise<DiscoveryTrajectory> {
  assertUrlAllowed(options.startUrl, options.config);

  const resources: SessionResources = {};
  const closeClient = options.client?.close;
  if (closeClient !== undefined) {
    resources.clientClose = async () => {
      await closeClient();
    };
  }

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing !== undefined) {
      return closing;
    }
    const stagehand = resources.stagehand;
    const browser = resources.browser;
    const clientClose = resources.clientClose;
    if (
      stagehand === undefined &&
      browser === undefined &&
      clientClose === undefined
    ) {
      return Promise.resolve();
    }
    resources.stagehand = undefined;
    resources.browser = undefined;
    resources.clientClose = undefined;
    closing = release(stagehand, browser, clientClose);
    return closing;
  };

  const signal = options.signal;
  const onAbort = (): void => {
    void close().catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort);

  let caught = false;
  let primaryError: unknown;
  let trajectory: DiscoveryTrajectory | undefined;
  try {
    if (signal?.aborted) {
      throw cancelled();
    }
    guardStep(0, options.maxSteps, 0);

    const startedAt = new Date().toISOString();
    const work =
      options.client === undefined
        ? runStagehand(options, resources)
        : options.client.run(options.objective);
    const result = await abortable(work, signal);
    if (signal?.aborted) {
      throw cancelled();
    }
    trajectory = acceptResult(result, options.maxSteps, startedAt);
  } catch (error: unknown) {
    caught = true;
    primaryError = error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await closeAfter(caught, primaryError, close);
  }

  if (trajectory === undefined) {
    throw primaryError;
  }
  return trajectory;
}

/**
 * Runs cleanup after discovery. A close rejection is attached to an earlier
 * failure so it cannot replace that failure, including a rejection of
 * `undefined`. With no earlier failure, the close rejection still surfaces.
 */
async function closeAfter(
  caught: boolean,
  primaryError: unknown,
  close: () => Promise<void>,
): Promise<void> {
  try {
    await close();
  } catch (closeError: unknown) {
    if (!caught) {
      throw closeError;
    }
    attachCloseFailure(primaryError, closeError);
  }
}

async function runStagehand(
  options: DiscoverOptions,
  resources: SessionResources,
): Promise<AgentResultLike> {
  const signal = options.signal;
  if (signal?.aborted) {
    throw cancelled();
  }

  requireApiKey(options.provider);
  const browserSession = await startBrowser({
    browser: options.config.playwright.browser,
    headless: options.config.playwright.headless,
    timeoutMs: options.config.playwright.timeoutMs,
    signal,
  });
  resources.browser = {
    close: () => browserSession.close(),
  };
  if (signal?.aborted) {
    throw cancelled();
  }

  const stagehand = createStagehand(options.provider, browserSession.browser);
  resources.stagehand = {
    close: () => stagehand.close(),
  };
  if (signal?.aborted) {
    throw cancelled();
  }

  await stagehand.init();
  if (signal?.aborted) {
    throw cancelled();
  }

  await openStartUrl(stagehand, options.startUrl, options.config.playwright.timeoutMs);
  if (signal?.aborted) {
    throw cancelled();
  }

  guardStep(0, options.maxSteps, 0);
  const agent = stagehand.agent({ mode: "dom" });
  const executed = await agent.execute({
    instruction: options.objective,
    maxSteps: options.maxSteps,
    ...(signal === undefined ? {} : { signal }),
  });
  return {
    success: executed.success,
    message: executed.message,
    actions: executed.actions,
    completed: executed.completed,
  };
}

async function openStartUrl(
  stagehand: {
    context: {
      activePage: () => { goto: PageGoto } | undefined;
      pages: () => { goto: PageGoto }[];
      newPage: (url?: string) => Promise<unknown>;
    };
  },
  startUrl: string,
  timeoutMs: number,
): Promise<void> {
  const pages = stagehand.context.pages();
  const page = stagehand.context.activePage() ?? pages[0];
  if (page === undefined) {
    await stagehand.context.newPage(startUrl);
    return;
  }
  await page.goto(startUrl, { timeoutMs });
}

type PageGoto = (
  url: string,
  options?: { timeoutMs?: number },
) => Promise<unknown>;

function acceptResult(
  result: AgentResultLike,
  maxSteps: number,
  startedAt: string,
): DiscoveryTrajectory {
  const trajectory = fromAgentResult(result, {
    startedAt,
    endedAt: new Date().toISOString(),
  });
  const count = trajectory.actions.length;
  if (count === 0) {
    throw discoveryFailed(count, maxSteps);
  }

  for (let used = 0; used < count; used += 1) {
    guardStep(used, maxSteps, count);
  }

  if (result.success !== true || result.completed === false || count > maxSteps) {
    throw discoveryFailed(count, maxSteps);
  }
  return trajectory;
}

function guardStep(used: number, maxSteps: number, actionCount: number): void {
  try {
    assertStepsRemaining(used, maxSteps);
  } catch (error: unknown) {
    if (error instanceof QaError && error.code === "POLICY_BLOCKED") {
      throw discoveryFailed(actionCount, maxSteps);
    }
    throw error;
  }
}

function abortable<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) {
    return work;
  }
  if (signal.aborted) {
    void work.catch(() => undefined);
    return Promise.reject(cancelled());
  }

  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      reject(cancelled());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) {
          reject(cancelled());
          return;
        }
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) {
          reject(cancelled());
          return;
        }
        reject(error);
      },
    );
  });
}

async function release(
  stagehand: Closable | undefined,
  browser: Closable | undefined,
  clientClose: (() => Promise<void>) | undefined,
): Promise<void> {
  const errors: unknown[] = [];
  await capture(errors, stagehand?.close());
  await capture(errors, browser?.close());
  await capture(errors, clientClose?.());
  const first = errors[0];
  if (first !== undefined) {
    throw first;
  }
}

async function capture(
  errors: unknown[],
  job: Promise<void> | undefined,
): Promise<void> {
  if (job === undefined) {
    return;
  }
  try {
    await job;
  } catch (error: unknown) {
    errors.push(error);
  }
}

function attachCloseFailure(primary: unknown, closeError: unknown): void {
  if (primary instanceof Error && primary.cause === undefined) {
    primary.cause = closeError;
  }
}

function discoveryFailed(actionCount: number, maxSteps: number): QaError {
  return new QaError({
    code: "DISCOVERY_FAILED",
    message: `Discovery stopped after ${actionCount} actions; maxSteps is ${maxSteps}.`,
  });
}

function cancelled(): QaError {
  return new QaError({
    code: "RUN_CANCELLED",
    message: "Discovery was cancelled.",
  });
}
