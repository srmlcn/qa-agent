import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BrowserContext, Page } from "playwright";
import { saveProfile, type StorageState } from "../../../src/auth/store.js";
import type { ProjectConfig } from "../../../src/config/schema.js";
import type { ExecuteFlowOptions, ExecuteFlowResult } from "../../../src/orchestrator/execution.js";
import { executeSuite } from "../../../src/orchestrator/suite.js";
import type { RunPoolOptions } from "../../../src/playwright/workers.js";

const { runPoolMock, executeFlowMock } = vi.hoisted(() => ({
  runPoolMock: vi.fn(),
  executeFlowMock: vi.fn(),
}));

vi.mock("../../../src/playwright/workers.js", () => ({
  runPool: runPoolMock,
}));

vi.mock("../../../src/orchestrator/execution.js", () => ({
  executeFlow: executeFlowMock,
}));

const EMPTY_STORAGE: StorageState = { cookies: [], origins: [] };

let previousHome: string | undefined;
let scratch = "";

beforeEach(() => {
  runPoolMock.mockReset();
  executeFlowMock.mockReset();
  previousHome = process.env.AUTONOMOUS_QA_HOME;
  scratch = mkdtempSync(join(tmpdir(), "aqa-suite-unit-"));
  process.env.AUTONOMOUS_QA_HOME = join(scratch, "home");
  mkdirSync(process.env.AUTONOMOUS_QA_HOME, { recursive: true });
});

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.AUTONOMOUS_QA_HOME;
  } else {
    process.env.AUTONOMOUS_QA_HOME = previousHome;
  }
  rmSync(scratch, { recursive: true, force: true });
});

test("a worker past the profile list runs with the repeated profile", async () => {
  const profiles = ["worker-a", "worker-b"] as const;
  const config = projectConfig(profiles);
  const projectRoot = join(scratch, "project");
  mkdirSync(projectRoot, { recursive: true });
  const paths = profiles.map(
    (profile) =>
      saveProfile(config.project.id, profile, EMPTY_STORAGE, { projectRoot }).path,
  );
  const flowIds = ["page.one", "page.two", "page.three"];
  const assigned: Array<{ flowId: string; authProfile?: string }> = [];
  executeFlowMock.mockImplementation(async (options: ExecuteFlowOptions) => {
    assigned.push({
      flowId: options.flowId,
      authProfile: options.authProfile,
    });
    expect(Object.hasOwn(options, "authProfile")).toBe(true);
    return passedExecution(options.flowId);
  });
  runPoolMock.mockImplementation(
    async (options: RunPoolOptions<string, ExecuteFlowResult>) => {
      expect(options.authStrategy).toBe("per-worker");
      expect(options.concurrency).toBe(4);
      expect(options.storageStates).toEqual(paths);
      // Worker slots past the profile list must wrap, matching storageStateFor.
      const slots = [
        { index: 0, workerIndex: 2 },
        { index: 1, workerIndex: 3 },
        { index: 2, workerIndex: 0 },
      ];
      const results = [];
      for (const slot of slots) {
        const item = options.items[slot.index];
        if (item === undefined) {
          throw new Error("missing suite item");
        }
        const storageState =
          options.storageStates[slot.workerIndex % options.storageStates.length];
        const profile = profiles[slot.workerIndex % profiles.length];
        expect(storageState).toBe(paths[slot.workerIndex % profiles.length]);
        const value = await options.run({
          item,
          index: slot.index,
          workerIndex: slot.workerIndex,
          page: {} as Page,
          context: {} as BrowserContext,
        });
        expect(value).toBeDefined();
        expect(assigned.at(-1)?.authProfile).toBe(profile);
        results.push({ index: slot.index, item, value });
      }
      return { results, errors: [] };
    },
  );

  const summary = await executeSuite({
    flowIds,
    workers: 4,
    authStrategy: "per-worker",
    inputs: {},
    projectRoot,
    config,
  });

  expect(assigned).toEqual([
    { flowId: "page.one", authProfile: "worker-a" },
    { flowId: "page.two", authProfile: "worker-b" },
    { flowId: "page.three", authProfile: "worker-a" },
  ]);
  expect(summary.passed).toBe(3);
  expect(summary.failed).toBe(0);
  expect(summary.error).toBe(0);
});

function passedExecution(flowId: string): ExecuteFlowResult {
  const runId = `run-${flowId}`;
  return {
    runId,
    result: {
      runId,
      flowId,
      status: "passed",
      startedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 1,
      steps: [],
      network: { failedRequests: [], responses: [] },
      console: { errors: [], warnings: [] },
      pageErrors: [],
      artifacts: { screenshots: [] },
    },
  };
}

function projectConfig(workerProfiles: readonly string[]): ProjectConfig {
  return {
    version: 1,
    project: { id: "demo-app" },
    application: {
      baseUrl: "http://127.0.0.1:3000",
      allowedHosts: ["127.0.0.1"],
      productionAllowed: false,
    },
    llm: {
      provider: "openai-compatible",
      model: "test-model",
      baseUrl: "https://llm.example/v1",
      apiKeyEnv: "QA_AGENT_TEST_LLM_KEY",
      timeoutMs: 1_000,
    },
    stagehand: {
      enabled: false,
      maxSteps: 30,
      recoveryEnabled: false,
      debugTools: false,
    },
    playwright: {
      browser: "chromium",
      headless: true,
      workers: 1,
      timeoutMs: 3_000,
    },
    evidence: {
      screenshots: "checkpoints",
      network: true,
      console: true,
      trace: "on-failure",
      maxResponseBodyBytes: 4096,
    },
    security: {
      redactHeaders: ["authorization", "cookie", "set-cookie"],
      destructiveActionsAllowed: false,
      maxRunDurationMs: 600_000,
    },
    auth: { workerProfiles: [...workerProfiles] },
  };
}
