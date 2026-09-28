import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ProjectConfig } from "../../../src/config/schema.js";
import { readRun, writeRun } from "../../../src/evidence/store.js";
import type { FailureCategory, RunResult } from "../../../src/evidence/types.js";
import { QaError } from "../../../src/errors/qa-error.js";
import { read, save } from "../../../src/flows/repository.js";
import {
  parseFlowSpec,
  type Assertion,
  type FlowSpec,
  type Step,
} from "../../../src/flows/schema.js";
import { parseFlow } from "../../../src/flows/serialize.js";
import { validateFlow } from "../../../src/flows/validator.js";
import { repairFlow } from "../../../src/orchestrator/repair.js";
import { startBrowser } from "../../../src/playwright/runtime.js";
import { createFakeClient, type FakeScript } from "../../../src/stagehand/fake-client.js";
import type { LlmProvider } from "../../../src/stagehand/provider.js";
import type { DiscoverySessionClient } from "../../../src/stagehand/session.js";

vi.mock("../../../src/playwright/runtime.js", () => ({
  startBrowser: vi.fn(async () => ({
    page: {},
    close: async () => undefined,
  })),
}));

vi.mock("../../../src/flows/validator.js", async () => {
  const { transition } = await import("../../../src/flows/state.js");
  return {
    validateFlow: vi.fn(
      async (input: { flow: Parameters<typeof transition>[0] }) => ({
        ok: true as const,
        flow: transition(input.flow, "validate"),
      }),
    ),
  };
});

const FLOW_ID = "page.save";
const OTHER_FLOW_ID = "page.other";
const FAILED_STEP_ID = "click-missing";
const OBJECTIVE = "Save the record";
const SEMANTIC_FALLBACK = "Click the Save button";
const PAGE_URL = "http://127.0.0.1:9/";

const provider: LlmProvider = {
  provider: "openai-compatible",
  model: "test-model",
  baseUrl: "https://llm.example/v1",
  headers: {},
  timeoutMs: 1_000,
  maxRetries: 0,
  apiKeyEnv: "QA_AGENT_REPAIR_FLOW_KEY",
};

let projectRoot = "";
const scratchDirs: string[] = [];

beforeEach(() => {
  const scratch = mkdtempSync(join(tmpdir(), "aqa-repair-unit-"));
  scratchDirs.push(scratch);
  projectRoot = join(scratch, "project");
  mkdirSync(projectRoot, { recursive: true });
  vi.mocked(startBrowser).mockClear();
  vi.mocked(validateFlow).mockClear();
});

afterEach(() => {
  for (const scratch of scratchDirs.splice(0)) {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a run from another flow throws run not found", async () => {
  const runId = "run-other-flow01";
  const before = seedFlow();
  const resultPath = seedFailedRun(runId, "locator", "failed", OTHER_FLOW_ID);
  const resultBefore = readFileSync(resultPath, "utf8");
  const { client, run } = scriptedClient(repairScript());

  const pending = repairFlow({
    flowId: FLOW_ID,
    failedStepId: FAILED_STEP_ID,
    runId,
    projectRoot,
    config: projectConfig(),
    provider,
    client,
  });

  await expect(pending).rejects.toBeInstanceOf(QaError);
  await expect(pending).rejects.toMatchObject({
    code: "FLOW_VALIDATION_FAILED",
    message: "run not found",
    runId,
    flowId: FLOW_ID,
  });
  const error = await pending.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(QaError);
  if (error instanceof QaError) {
    expect(error.message).toBe("run not found");
  }
  expect(run).not.toHaveBeenCalled();
  expect(startBrowser).not.toHaveBeenCalled();
  expect(validateFlow).not.toHaveBeenCalled();
  expect(read(projectRoot, FLOW_ID)).toEqual(before);
  expect(readFileSync(resultPath, "utf8")).toBe(resultBefore);
  expect(existsSync(previousFlowPath(runId))).toBe(false);
});

test("a matching locator failure still repairs", async () => {
  const runId = "run-locator-ok";
  const before = seedFlow();
  const resultPath = seedFailedRun(runId, "locator", "failed", FLOW_ID);
  const resultBefore = readFileSync(resultPath, "utf8");
  const { client, run } = scriptedClient(repairScript());

  const repaired = await repairFlow({
    flowId: FLOW_ID,
    failedStepId: FAILED_STEP_ID,
    runId,
    projectRoot,
    config: projectConfig(),
    provider,
    client,
  });

  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0]?.[0]).toContain(OBJECTIVE);
  expect(run.mock.calls[0]?.[0]).toContain(SEMANTIC_FALLBACK);
  expect(startBrowser).toHaveBeenCalledTimes(1);
  expect(validateFlow).toHaveBeenCalledTimes(1);
  expect(repaired.repaired).toBe(true);
  if (repaired.repaired !== true) {
    return;
  }

  expect(repaired.runId).toBe(runId);
  expect(repaired.flow.state).toBe("validated");
  expect(repaired.flow.id).toBe(FLOW_ID);
  expect(repaired.flow.assertions).toEqual(before.assertions);

  const saved = read(projectRoot, FLOW_ID);
  expect(saved.state).toBe("validated");
  expect(saved.id).toBe(FLOW_ID);
  expect(saved.assertions).toEqual(before.assertions);
  expect(saved.steps).not.toEqual(before.steps);
  expect(readFileSync(resultPath, "utf8")).toBe(resultBefore);
  expect(readRun(projectRoot, runId).flowId).toBe(FLOW_ID);

  const previous = parseFlow(readFileSync(previousFlowPath(runId), "utf8"), "yaml");
  expect(previous.id).toBe(FLOW_ID);
  expect(previous.state).toBe("stale");
  expect(previous.steps).toEqual(before.steps);
});

function previousFlowPath(runId: string): string {
  return join(
    projectRoot,
    ".autonomous-qa",
    "artifacts",
    runId,
    "previous-flow.yml",
  );
}

function seedFlow(): FlowSpec {
  save(projectRoot, staleFlow());
  return read(projectRoot, FLOW_ID);
}

function seedFailedRun(
  runId: string,
  category: FailureCategory,
  status: "failed" | "error",
  flowId: string,
): string {
  writeRun(projectRoot, failedResult(runId, category, status, flowId));
  return join(projectRoot, ".autonomous-qa", "artifacts", runId, "result.json");
}

function staleFlow(): FlowSpec {
  return parseFlowSpec({
    version: 1,
    id: FLOW_ID,
    name: "Save the page",
    objective: OBJECTIVE,
    state: "stale",
    inputs: {},
    steps: [gotoStep(), missingClickStep()],
    assertions: [savedAssertion()],
  });
}

function gotoStep(): Step {
  return {
    id: "open-page",
    intent: "Open the page",
    action: "goto",
    value: PAGE_URL,
  };
}

function missingClickStep(): Step {
  return {
    id: FAILED_STEP_ID,
    intent: "Activate the button",
    semanticFallback: SEMANTIC_FALLBACK,
    action: "click",
    locator: { type: "role", role: "button", name: "Missing" },
  };
}

function savedAssertion(): Assertion {
  return {
    id: "status-saved",
    type: "text",
    locator: { type: "text", text: "Saved" },
    text: "Saved",
  };
}

function failedResult(
  runId: string,
  category: FailureCategory,
  status: "failed" | "error",
  flowId: string,
): RunResult {
  return {
    runId,
    flowId,
    status,
    startedAt: "2026-09-27T00:00:00.000Z",
    durationMs: 12,
    steps: [
      {
        stepId: FAILED_STEP_ID,
        status,
        startedAt: "2026-09-27T00:00:00.000Z",
        durationMs: 12,
        error: `${category} failure`,
      },
    ],
    network: { failedRequests: [], responses: [] },
    console: { errors: [], warnings: [] },
    pageErrors: [],
    artifacts: { screenshots: [] },
    failure: {
      stepId: FAILED_STEP_ID,
      category,
      message: `${category} failure`,
    },
  };
}

function scriptedClient(script: FakeScript): {
  client: DiscoverySessionClient;
  run: ReturnType<typeof vi.fn>;
} {
  const fake = createFakeClient(script);
  const run = vi.fn((objective: string) => fake.run(objective));
  return { client: { run }, run };
}

function repairScript(): FakeScript {
  return [
    {
      method: "goto",
      selector: "",
      description: "Open the start page",
      arguments: { url: PAGE_URL },
    },
    {
      method: "click",
      selector: 'role=button[name="Save"]',
      description: "Click the Save button",
      arguments: [],
    },
  ];
}

function projectConfig(): ProjectConfig {
  return {
    version: 1,
    project: { id: "demo-app" },
    application: {
      baseUrl: PAGE_URL,
      allowedHosts: ["127.0.0.1"],
      productionAllowed: false,
    },
    llm: {
      provider: "openai-compatible",
      model: "test-model",
      baseUrl: "https://llm.example/v1",
      apiKeyEnv: "QA_AGENT_REPAIR_FLOW_KEY",
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
