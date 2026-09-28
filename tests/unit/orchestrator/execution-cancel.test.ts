import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { ProjectConfig } from "../../../src/config/schema.js";
import { QaError } from "../../../src/errors/qa-error.js";
import { save } from "../../../src/flows/repository.js";
import { parseFlowSpec, type FlowSpec, type Step } from "../../../src/flows/schema.js";
import { executeFlow } from "../../../src/orchestrator/execution.js";
import { cancel, getRun, listActive } from "../../../src/orchestrator/runs.js";

const CLOSED_TARGET = "page.click: Target page, context or browser has been closed";

const { runAction, failedSteps } = vi.hoisted(() => ({
  runAction: vi.fn<(page: unknown, step: unknown, timeoutMs: number) => Promise<void>>(),
  failedSteps: [] as { stepId: string; code: string }[],
}));

vi.mock("../../../src/playwright/actions.js", () => ({
  runAction,
}));

vi.mock("../../../src/playwright/runtime.js", () => ({
  startBrowser: async () => ({
    browser: {},
    context: {},
    page: {},
    close: async () => undefined,
  }),
}));

vi.mock("../../../src/evidence/network.js", () => ({
  startCapture: async () => ({
    capture: {
      network: { failedRequests: [], responses: [] },
      console: { errors: [], warnings: [] },
      pageErrors: [],
    },
    stop: async () => undefined,
  }),
}));

vi.mock("../../../src/evidence/traces.js", () => ({
  startTrace: async () => undefined,
  stopTrace: async () => undefined,
}));

vi.mock("../../../src/evidence/result.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/evidence/result.js")>(
    "../../../src/evidence/result.js",
  );
  return {
    ...actual,
    startRun(options: { runId: string; flowId: string }) {
      const builder = actual.startRun(options);
      return {
        stepPassed(stepId: string) {
          builder.stepPassed(stepId);
        },
        stepFailed(stepId: string, error: { code: string }) {
          failedSteps.push({ stepId, code: error.code });
          builder.stepFailed(stepId, error as Parameters<typeof builder.stepFailed>[1]);
        },
        finish() {
          return builder.finish();
        },
      };
    },
  };
});

const scratchDirs: string[] = [];

afterEach(() => {
  failedSteps.length = 0;
  runAction.mockReset();
  for (const runId of listActive()) {
    const flowId = getRun(runId).flowId;
    if (flowId === "page.cancel" || flowId === "page.error") {
      cancel(runId);
    }
  }
  for (const scratch of scratchDirs.splice(0)) {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a step interrupted by cancel is recorded as RUN_CANCELLED", async () => {
  runAction.mockImplementation(async () => {
    abortFlow("page.cancel");
    throw new QaError({
      code: "PAGE_ERROR",
      message: CLOSED_TARGET,
      flowId: "page.cancel",
      stepId: "click-save",
    });
  });

  const executed = await executeSaved(clickFlow("page.cancel"));

  expect(failedSteps).toEqual([{ stepId: "click-save", code: "RUN_CANCELLED" }]);
  expect(executed.result.status).toBe("error");
  expect(executed.result.steps).toEqual([
    expect.objectContaining({
      stepId: "click-save",
      status: "error",
      error: "run cancelled",
    }),
  ]);
  expect(executed.result.failure).toMatchObject({
    stepId: "click-save",
    message: "run cancelled",
  });
});

test("a page error that is not a cancel stays PAGE_ERROR", async () => {
  runAction.mockImplementation(async () => {
    throw new Error(CLOSED_TARGET);
  });

  const executed = await executeSaved(clickFlow("page.error"));

  expect(failedSteps).toEqual([{ stepId: "click-save", code: "PAGE_ERROR" }]);
  expect(executed.result.status).toBe("error");
  expect(executed.result.steps).toEqual([
    expect.objectContaining({
      stepId: "click-save",
      status: "error",
      error: CLOSED_TARGET,
    }),
  ]);
  expect(executed.result.failure).toMatchObject({
    stepId: "click-save",
    message: CLOSED_TARGET,
  });
});

function abortFlow(flowId: string): void {
  for (const runId of listActive()) {
    if (getRun(runId).flowId === flowId) {
      cancel(runId);
    }
  }
}

async function executeSaved(flow: FlowSpec) {
  const projectRoot = mkdtempSync(join(tmpdir(), "aqa-cancel-"));
  scratchDirs.push(projectRoot);
  mkdirSync(projectRoot, { recursive: true });
  save(projectRoot, flow);
  return executeFlow({
    flowId: flow.id,
    inputs: {},
    projectRoot,
    config: projectConfig(),
  });
}

function clickFlow(id: string): FlowSpec {
  const step: Step = {
    id: "click-save",
    intent: "Activate the button",
    action: "click",
    locator: { type: "role", role: "button", name: "Save" },
  };
  return parseFlowSpec({
    version: 1,
    id,
    name: "Click save",
    objective: "Record the click outcome.",
    state: "validated",
    inputs: {},
    steps: [step],
    assertions: [],
  });
}

function projectConfig(): ProjectConfig {
  return {
    version: 1,
    project: { id: "demo-app" },
    application: {
      baseUrl: "http://127.0.0.1/",
      allowedHosts: ["127.0.0.1"],
      productionAllowed: false,
    },
    llm: {
      provider: "openai-compatible",
      model: "test-model",
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
      timeoutMs: 1_000,
    },
    evidence: {
      screenshots: "checkpoints",
      network: false,
      console: false,
      trace: "off",
      maxResponseBodyBytes: 4096,
    },
    security: {
      redactHeaders: ["authorization", "cookie", "set-cookie"],
      destructiveActionsAllowed: false,
      maxRunDurationMs: 600_000,
    },
    auth: { workerProfiles: [] },
  };
}
