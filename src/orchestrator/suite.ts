import { readProfilePath } from "../auth/store.js";
import type { ProjectConfig } from "../config/schema.js";
import type { RunStatus } from "../evidence/types.js";
import { QaError } from "../errors/qa-error.js";
import type { FlowInputs } from "../flows/interpolate.js";
import { read } from "../flows/repository.js";
import {
  runPool,
  type AuthStrategy,
  type WorkerPoolResult,
} from "../playwright/workers.js";
import { executeFlow, type ExecuteFlowResult } from "./execution.js";

export type ExecuteSuiteOptions = {
  flowIds: readonly string[];
  /** Defaults to `config.playwright.workers`. */
  workers?: number;
  authStrategy: AuthStrategy;
  /**
   * Shared-strategy override. When omitted, every flow uses the first flow's
   * `authProfile`. Per-worker auth uses `config.auth.workerProfiles` instead.
   */
  authProfile?: string;
  projectRoot: string;
  config: ProjectConfig;
  inputs: FlowInputs;
  /** Chromium stays headless unless this is true. */
  headed?: boolean;
};

export type SuiteRun = {
  flowId: string;
  runId: string;
  status: RunStatus;
};

export type SuiteResult = {
  runs: SuiteRun[];
  passed: number;
  failed: number;
  error: number;
};

type ProfilePlan = {
  storageStates: readonly string[];
  profileFor(workerIndex: number): string | undefined;
};

/**
 * Runs saved flows on the worker pool and returns one aggregate.
 * A failed flow stays in the aggregate and does not cancel the others.
 * The pool launches a browser so each slot is isolated. Each item then calls
 * {@link executeFlow}, which replays the flow in its own browser.
 */
export async function executeSuite(
  options: ExecuteSuiteOptions,
): Promise<SuiteResult> {
  const plan = profilePlan(options);
  const pooled = await runPool({
    concurrency: options.workers ?? options.config.playwright.workers,
    items: options.flowIds,
    authStrategy: options.authStrategy,
    storageStates: plan.storageStates,
    run: ({ item, workerIndex }) =>
      executeFlow({
        flowId: item,
        inputs: options.inputs,
        projectRoot: options.projectRoot,
        config: options.config,
        ...optionalAuth(plan.profileFor(workerIndex)),
        ...optionalHeaded(options.headed),
      }),
  });
  return aggregate(pooled);
}

function profilePlan(options: ExecuteSuiteOptions): ProfilePlan {
  if (options.authStrategy === "per-worker") {
    return perWorkerPlan(options.config);
  }
  return sharedPlan(options);
}

function perWorkerPlan(config: ProjectConfig): ProfilePlan {
  const profiles = config.auth.workerProfiles;
  if (profiles.length === 0) {
    throw new QaError({
      code: "AUTH_MISSING",
      message: "per-worker auth requires at least one worker profile.",
    });
  }
  return {
    storageStates: profiles.map((profile) =>
      readProfilePath(config.project.id, profile),
    ),
    profileFor(workerIndex: number): string | undefined {
      // Same slot as runPool storageStateFor: workerIndex % length.
      return profiles[workerIndex % profiles.length];
    },
  };
}

function sharedPlan(options: ExecuteSuiteOptions): ProfilePlan {
  const profile = sharedProfile(options);
  const storageStates =
    profile === undefined
      ? []
      : [readProfilePath(options.config.project.id, profile)];
  return {
    storageStates,
    profileFor: () => profile,
  };
}

function sharedProfile(options: ExecuteSuiteOptions): string | undefined {
  if (options.authProfile !== undefined) {
    return options.authProfile;
  }
  const firstId = options.flowIds[0];
  if (firstId === undefined) {
    return undefined;
  }
  return read(options.projectRoot, firstId).authProfile;
}

function optionalAuth(
  authProfile: string | undefined,
): { authProfile: string } | Record<string, never> {
  if (authProfile === undefined) {
    return {};
  }
  return { authProfile };
}

function optionalHeaded(
  headed: boolean | undefined,
): { headed: boolean } | Record<string, never> {
  if (headed === undefined) {
    return {};
  }
  return { headed };
}

function aggregate(
  pooled: WorkerPoolResult<string, ExecuteFlowResult>,
): SuiteResult {
  const runs: SuiteRun[] = [];
  let passed = 0;
  let failed = 0;
  let error = 0;
  for (const item of pooled.results) {
    if (item.value === undefined) {
      error += 1;
      continue;
    }
    const status = item.value.result.status;
    runs.push({
      flowId: item.value.result.flowId,
      runId: item.value.runId,
      status,
    });
    if (status === "passed") {
      passed += 1;
    } else if (status === "failed") {
      failed += 1;
    } else {
      error += 1;
    }
  }
  return { runs, passed, failed, error };
}
