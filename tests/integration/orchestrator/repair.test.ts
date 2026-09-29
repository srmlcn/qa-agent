import { createServer, type Server } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { ProjectConfig } from "../../../src/config/schema.js";
import { readRun, writeRun } from "../../../src/evidence/store.js";
import type { FailureCategory, RunResult } from "../../../src/evidence/types.js";
import { QaError } from "../../../src/errors/qa-error.js";
import { list, read, save } from "../../../src/flows/repository.js";
import { parseFlowSpec, type Assertion, type FlowSpec, type Step } from "../../../src/flows/schema.js";
import { parseFlow } from "../../../src/flows/serialize.js";
import { repairFlow } from "../../../src/orchestrator/repair.js";
import { getRun } from "../../../src/orchestrator/runs.js";
import { createFakeClient, type FakeScript } from "../../../src/stagehand/fake-client.js";
import type { LlmProvider } from "../../../src/stagehand/provider.js";
import type { DiscoverySessionClient } from "../../../src/stagehand/session.js";

const TEST_TIMEOUT_MS = 60_000;
const ACTION_TIMEOUT_MS = 3_000;
const FLOW_ID = "page.save";
const FAILED_STEP_ID = "click-missing";
const OBJECTIVE = "Save the record";
const SEMANTIC_FALLBACK = "Click the Save button";

const PAGE_HTML = `<!DOCTYPE html>
<html>
  <body>
    <button type="button" id="save">Save</button>
    <p id="status">Idle</p>
    <script>
      document.getElementById("save").addEventListener("click", () => {
        document.getElementById("status").textContent = "Saved";
      });
    </script>
  </body>
</html>`;

const provider: LlmProvider = {
  provider: "openai-compatible",
  model: "test-model",
  baseUrl: "https://llm.example/v1",
  headers: {},
  timeoutMs: 1_000,
  maxRetries: 0,
  apiKeyEnv: "QA_AGENT_REPAIR_FLOW_KEY",
};

let pageUrl = "";
let closePage: (() => Promise<void>) | undefined;
let projectRoot = "";
let previousHome: string | undefined;
const scratchDirs: string[] = [];

beforeAll(async () => {
  const page = await startPage(PAGE_HTML);
  pageUrl = page.url;
  closePage = page.close;
});

afterAll(async () => {
  await closePage?.();
});

beforeEach(() => {
  previousHome = process.env.AUTONOMOUS_QA_HOME;
  const scratch = mkdtempSync(join(tmpdir(), "aqa-repair-"));
  scratchDirs.push(scratch);
  projectRoot = join(scratch, "project");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(join(scratch, "home"), { recursive: true });
  process.env.AUTONOMOUS_QA_HOME = join(scratch, "home");
});

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.AUTONOMOUS_QA_HOME;
  } else {
    process.env.AUTONOMOUS_QA_HOME = previousHome;
  }
  for (const scratch of scratchDirs.splice(0)) {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("an assertion failure does not call the discovery client", async () => {
  const { before, outcome, run } = await repairProductFailure("assertion");

  expect(run).not.toHaveBeenCalled();
  expect(outcome).toEqual({
    repaired: false,
    reason: "product-failure",
    runId: "run-assertion-failed",
  });
  expect(read(projectRoot, FLOW_ID)).toEqual(before);
  expect(readRun(projectRoot, "run-assertion-failed").failure?.category).toBe(
    "assertion",
  );
});

test("a page-error failure does not call the discovery client", async () => {
  const { before, outcome, run } = await repairProductFailure("runtime");

  expect(run).not.toHaveBeenCalled();
  expect(outcome).toEqual({
    repaired: false,
    reason: "product-failure",
    runId: "run-runtime-failed",
  });
  expect(read(projectRoot, FLOW_ID)).toEqual(before);
  expect(["failed", "error"]).toContain(
    readRun(projectRoot, "run-runtime-failed").status,
  );
});

test(
  "a locator failure rediscovers, replays, and saves validated",
  async () => {
    const runId = "run-locator-failed";
    const before = seedFlow();
    const resultPath = seedFailedRun(runId, "locator", "failed");
    const resultBefore = readFileSync(resultPath, "utf8");
    const { client, run } = scriptedClient(
      pageScript(pageUrl, "Save", "Click the Save button"),
    );

    const repaired = await repairFlow({
      flowId: FLOW_ID,
      failedStepId: FAILED_STEP_ID,
      runId,
      projectRoot,
      config: projectConfig(pageUrl),
      provider,
      client,
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toContain(OBJECTIVE);
    expect(run.mock.calls[0]?.[0]).toContain(SEMANTIC_FALLBACK);
    expect(repaired.repaired).toBe(true);
    if (repaired.repaired !== true) {
      return;
    }

    expect(repaired.runId).toBe(runId);
    expect(repaired.repairRunId).not.toBe(runId);
    expect(repaired.flow.state).toBe("validated");
    expect(repaired.flow.assertions).toEqual(before.assertions);
    expect(repaired.flow.assertions).not.toEqual([]);

    const saved = read(projectRoot, FLOW_ID);
    expect(saved.state).toBe("validated");
    expect(saved.assertions).toEqual(before.assertions);
    expect(saved.steps).not.toEqual(before.steps);
    expect(saved.id).toBe(FLOW_ID);

    expect(["failed", "error"]).toContain(readRun(projectRoot, runId).status);
    expect(readFileSync(resultPath, "utf8")).toBe(resultBefore);
    expect(["passed"]).toContain(repaired.result.status);
    expect(getRun(repaired.repairRunId).status).toBe("passed");
    expect(readRun(projectRoot, repaired.repairRunId).status).toBe("passed");

    const previousPath = join(
      projectRoot,
      ".autonomous-qa",
      "artifacts",
      runId,
      "previous-flow.yml",
    );
    expect(existsSync(previousPath)).toBe(true);
    const previous = parseFlow(readFileSync(previousPath, "utf8"), "yaml");
    expect(previous.steps).toEqual(before.steps);
    expect(previous.state).toBe("stale");
    expect(list(projectRoot).map((item) => item.id)).toEqual([FLOW_ID]);
    expect(
      readdirSync(join(projectRoot, ".autonomous-qa", "flows")).some((name) =>
        name.includes("previous"),
      ),
    ).toBe(false);
  },
  TEST_TIMEOUT_MS,
);

test(
  "a failed replay leaves the flow stale and keeps the original run",
  async () => {
    const runId = "run-replay-failed";
    const before = seedFlow();
    seedFailedRun(runId, "locator", "failed");
    const { client, run } = scriptedClient(
      pageScript(pageUrl, "Missing", "Click the missing button"),
    );

    const outcome = await repairFlow({
      flowId: FLOW_ID,
      failedStepId: FAILED_STEP_ID,
      runId,
      projectRoot,
      config: projectConfig(pageUrl),
      provider,
      client,
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(outcome.repaired).toBe(false);
    if (outcome.repaired || outcome.reason !== "replay-failure") {
      throw new Error("expected a replay failure");
    }
    expect(outcome.runId).toBe(runId);
    expect(outcome.repairRunId).not.toBe(runId);
    expect(read(projectRoot, FLOW_ID)).toEqual(before);
    expect(read(projectRoot, FLOW_ID).state).toBe("stale");
    expect(["failed", "error"]).toContain(readRun(projectRoot, runId).status);
    expect(["failed", "error"]).toContain(outcome.result.status);
    expect(["failed", "error"]).toContain(
      readRun(projectRoot, outcome.repairRunId).status,
    );
    expect(["failed", "error"]).toContain(getRun(outcome.repairRunId).status);
    expect(
      existsSync(
        join(
          projectRoot,
          ".autonomous-qa",
          "artifacts",
          runId,
          "previous-flow.yml",
        ),
      ),
    ).toBe(false);
  },
  TEST_TIMEOUT_MS,
);

test("a missing run throws run not found", async () => {
  seedFlow();
  const { client, run } = scriptedClient(
    pageScript(pageUrl, "Save", "Click the Save button"),
  );

  const pending = repairFlow({
    flowId: FLOW_ID,
    failedStepId: FAILED_STEP_ID,
    runId: "run-missing-01",
    projectRoot,
    config: projectConfig(pageUrl),
    provider,
    client,
  });

  await expect(pending).rejects.toBeInstanceOf(QaError);
  await expect(pending).rejects.toMatchObject({
    code: "FLOW_VALIDATION_FAILED",
    message: "run not found",
  });
  expect(run).not.toHaveBeenCalled();
  expect(read(projectRoot, FLOW_ID).state).toBe("stale");
});

async function repairProductFailure(category: FailureCategory): Promise<{
  before: FlowSpec;
  outcome: Awaited<ReturnType<typeof repairFlow>>;
  run: ReturnType<typeof vi.fn>;
}> {
  const runId = `run-${category}-failed`;
  const before = seedFlow();
  seedFailedRun(runId, category, category === "assertion" ? "failed" : "error");
  const { client, run } = scriptedClient(
    pageScript(pageUrl, "Save", "Click the Save button"),
  );
  const outcome = await repairFlow({
    flowId: FLOW_ID,
    failedStepId: FAILED_STEP_ID,
    runId,
    projectRoot,
    config: projectConfig(pageUrl),
    provider,
    client,
  });
  return { before, outcome, run };
}

function seedFlow(): FlowSpec {
  save(projectRoot, staleFlow(pageUrl));
  return read(projectRoot, FLOW_ID);
}

function seedFailedRun(
  runId: string,
  category: FailureCategory,
  status: "failed" | "error",
): string {
  writeRun(projectRoot, failedResult(runId, category, status));
  return join(projectRoot, ".autonomous-qa", "artifacts", runId, "result.json");
}

function staleFlow(url: string): FlowSpec {
  return parseFlowSpec({
    version: 1,
    id: FLOW_ID,
    name: "Save the page",
    objective: OBJECTIVE,
    state: "stale",
    inputs: {},
    steps: [gotoStep(url), missingClickStep()],
    assertions: [savedAssertion()],
  });
}

function gotoStep(url: string): Step {
  return {
    id: "open-page",
    intent: "Open the page",
    action: "goto",
    value: url,
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
): RunResult {
  return {
    runId,
    flowId: FLOW_ID,
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

function pageScript(url: string, buttonName: string, description: string): FakeScript {
  return [
    {
      method: "goto",
      selector: "",
      description: "Open the start page",
      arguments: { url },
    },
    {
      method: "click",
      selector: `role=button[name="${buttonName}"]`,
      description,
      arguments: [],
    },
  ];
}

function projectConfig(baseUrl: string): ProjectConfig {
  return {
    version: 1,
    project: { id: "demo-app" },
    application: {
      baseUrl,
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
      timeoutMs: ACTION_TIMEOUT_MS,
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

function startPage(html: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(html);
  });
  return new Promise((resolve, reject) => {
    const fail = (error: Error): void => {
      reject(error);
    };
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", fail);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Could not bind the inline page."));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}/`,
        close: () => closeServer(server),
      });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
