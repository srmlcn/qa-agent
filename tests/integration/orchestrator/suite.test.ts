import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from "vitest";
import type { BrowserContext, Page } from "playwright";
import { saveProfile, type StorageState } from "../../../src/auth/store.js";
import type { ProjectConfig } from "../../../src/config/schema.js";
import { QaError } from "../../../src/errors/qa-error.js";
import { save } from "../../../src/flows/repository.js";
import {
  parseFlowSpec,
  type Assertion,
  type FlowSpec,
  type Step,
} from "../../../src/flows/schema.js";
import {
  executeFlow,
  type ExecuteFlowOptions,
  type ExecuteFlowResult,
} from "../../../src/orchestrator/execution.js";
import { getRun } from "../../../src/orchestrator/runs.js";
import { executeSuite } from "../../../src/orchestrator/suite.js";
import { runPool, type RunPoolOptions } from "../../../src/playwright/workers.js";

const { runPoolMock, executeFlowMock } = vi.hoisted(() => ({
  runPoolMock: vi.fn(),
  executeFlowMock: vi.fn(),
}));

vi.mock("../../../src/playwright/workers.js", () => ({
  runPool: runPoolMock,
}));

vi.mock("../../../src/orchestrator/execution.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/orchestrator/execution.js")>();
  return {
    ...actual,
    executeFlow: executeFlowMock,
  };
});

const TEST_TIMEOUT_MS = 60_000;
const ACTION_TIMEOUT_MS = 3_000;

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

const EMPTY_STORAGE: StorageState = { cookies: [], origins: [] };

type RunPoolFn = typeof import("../../../src/playwright/workers.js").runPool;
type ExecuteFlowFn = typeof import("../../../src/orchestrator/execution.js").executeFlow;

let actualRunPool: RunPoolFn;
let actualExecuteFlow: ExecuteFlowFn;
let pageUrl = "";
let closePage: (() => Promise<void>) | undefined;
let projectRoot = "";
let previousHome: string | undefined;
const scratchDirs: string[] = [];

beforeAll(async () => {
  const workers =
    await vi.importActual<typeof import("../../../src/playwright/workers.js")>(
      "../../../src/playwright/workers.js",
    );
  const execution =
    await vi.importActual<typeof import("../../../src/orchestrator/execution.js")>(
      "../../../src/orchestrator/execution.js",
    );
  actualRunPool = workers.runPool;
  actualExecuteFlow = execution.executeFlow;
  const page = await startPage(PAGE_HTML);
  pageUrl = page.url;
  closePage = page.close;
});

afterAll(async () => {
  await closePage?.();
});

beforeEach(() => {
  runPoolMock.mockReset();
  executeFlowMock.mockReset();
  runPoolMock.mockImplementation((options: RunPoolOptions<string, ExecuteFlowResult>) =>
    actualRunPool(options),
  );
  executeFlowMock.mockImplementation((options: ExecuteFlowOptions) =>
    actualExecuteFlow(options),
  );
  previousHome = process.env.AUTONOMOUS_QA_HOME;
  const scratch = mkdtempSync(join(tmpdir(), "aqa-suite-"));
  scratchDirs.push(scratch);
  projectRoot = join(scratch, "project");
  mkdirSync(join(projectRoot, ".autonomous-qa"), { recursive: true });
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

test(
  "two shared flows with concurrency 2 both complete",
  async () => {
    const before = browserPids();
    const flows = ["page.one", "page.two"].map((id) =>
      makeFlow({
        id,
        steps: [gotoStep(), clickStep("Save", "click-save")],
        assertions: [textAssertion("status-saved", "Saved", "Saved")],
      }),
    );
    for (const flow of flows) {
      save(projectRoot, flow);
    }
    const seen: Array<{ concurrency: number; authStrategy: string; storageStates: readonly string[] }> =
      [];
    runPoolMock.mockImplementation((options: RunPoolOptions<string, ExecuteFlowResult>) => {
      seen.push({
        concurrency: options.concurrency,
        authStrategy: options.authStrategy,
        storageStates: options.storageStates,
      });
      return actualRunPool(options);
    });

    const summary = await executeSuite({
      flowIds: flows.map((flow) => flow.id),
      authStrategy: "shared",
      inputs: { target: pageUrl },
      projectRoot,
      config: projectConfig(pageUrl, { workers: 2 }),
    });

    expect(seen).toEqual([
      { concurrency: 2, authStrategy: "shared", storageStates: [] },
    ]);
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.error).toBe(0);
    expect(summary.runs.map((run) => [run.flowId, run.status])).toEqual([
      ["page.one", "passed"],
      ["page.two", "passed"],
    ]);
    expect(new Set(summary.runs.map((run) => run.runId)).size).toBe(2);
    for (const run of summary.runs) {
      expect(getRun(run.runId).status).toBe("passed");
    }
    await expectBrowsersClosed(before);
  },
  TEST_TIMEOUT_MS,
);

test(
  "a locator failure in one flow still returns the other",
  async () => {
    const before = browserPids();
    const saved = makeFlow({
      id: "page.save",
      steps: [gotoStep(), clickStep("Save", "click-save")],
      assertions: [textAssertion("status-saved", "Saved", "Saved")],
    });
    const missing = makeFlow({
      id: "page.missing",
      steps: [gotoStep(), clickStep("Missing", "click-missing")],
      assertions: [textAssertion("status-saved", "Saved", "Saved")],
    });
    save(projectRoot, saved);
    save(projectRoot, missing);
    let concurrency: number | undefined;
    runPoolMock.mockImplementation((options: RunPoolOptions<string, ExecuteFlowResult>) => {
      concurrency = options.concurrency;
      return actualRunPool(options);
    });

    const summary = await executeSuite({
      flowIds: [missing.id, saved.id],
      workers: 2,
      authStrategy: "shared",
      inputs: { target: pageUrl },
      projectRoot,
      config: projectConfig(pageUrl, { workers: 1 }),
    });

    expect(concurrency).toBe(2);
    expect(summary.runs).toHaveLength(2);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.error).toBe(0);
    const byId = new Map(summary.runs.map((run) => [run.flowId, run]));
    expect(byId.get(missing.id)?.status).toBe("failed");
    expect(byId.get(saved.id)?.status).toBe("passed");
    expect(getRun(byId.get(missing.id)?.runId ?? "").status).toBe("failed");
    expect(getRun(byId.get(saved.id)?.runId ?? "").status).toBe("passed");
    await expectBrowsersClosed(before);
  },
  TEST_TIMEOUT_MS,
);

test("per-worker assigns profiles to worker slots in order", async () => {
  const saved = makeFlow({
    id: "page.save",
    steps: [gotoStep(), clickStep("Save", "click-save")],
    assertions: [],
    authProfile: "flow-save",
  });
  const other = makeFlow({
    id: "page.other",
    steps: [gotoStep(), clickStep("Save", "click-other")],
    assertions: [],
    authProfile: "flow-other",
  });
  save(projectRoot, saved);
  save(projectRoot, other);
  const config = projectConfig(pageUrl, {
    workers: 2,
    workerProfiles: ["worker-a", "worker-b"],
  });
  const profileA = saveProfile(config.project.id, "worker-a", EMPTY_STORAGE, {
    projectRoot,
  });
  const profileB = saveProfile(config.project.id, "worker-b", EMPTY_STORAGE, {
    projectRoot,
  });
  const assigned: Array<{ flowId: string; authProfile?: string }> = [];
  executeFlowMock.mockImplementation(async (options: ExecuteFlowOptions) => {
    assigned.push({ flowId: options.flowId, authProfile: options.authProfile });
    return passedExecution(options.flowId);
  });
  runPoolMock.mockImplementation(
    async (options: RunPoolOptions<string, ExecuteFlowResult>) => {
      expect(options.authStrategy).toBe("per-worker");
      expect(options.storageStates).toEqual([profileA.path, profileB.path]);
      // Item 0 runs on worker 1 so a zip by item index cannot satisfy the assertion.
      const slots = [
        { index: 0, workerIndex: 1 },
        { index: 1, workerIndex: 0 },
      ];
      const results = [];
      for (const slot of slots) {
        const item = options.items[slot.index];
        if (item === undefined) {
          throw new Error("missing suite item");
        }
        const value = await options.run({
          item,
          index: slot.index,
          workerIndex: slot.workerIndex,
          page: {} as Page,
          context: {} as BrowserContext,
        });
        results.push({ index: slot.index, item, value });
      }
      return { results, errors: [] };
    },
  );

  const summary = await executeSuite({
    flowIds: [saved.id, other.id],
    workers: 2,
    authStrategy: "per-worker",
    inputs: { target: pageUrl },
    projectRoot,
    config,
  });

  expect(assigned).toEqual([
    { flowId: saved.id, authProfile: "worker-b" },
    { flowId: other.id, authProfile: "worker-a" },
  ]);
  expect(summary.runs.map((run) => [run.flowId, run.runId, run.status])).toEqual([
    [saved.id, "run-page.save", "passed"],
    [other.id, "run-page.other", "passed"],
  ]);
  expect(summary.passed).toBe(2);
  expect(summary.failed).toBe(0);
  expect(summary.error).toBe(0);
  expect(executeFlow).toBe(executeFlowMock);
  expect(runPool).toBe(runPoolMock);
});

test("per-worker with zero profiles throws AUTH_MISSING before launch", async () => {
  const before = browserPids();
  runPoolMock.mockClear();
  executeFlowMock.mockClear();
  const pending = executeSuite({
    flowIds: ["page.missing", "page.save"],
    workers: 2,
    authStrategy: "per-worker",
    inputs: { target: pageUrl },
    projectRoot,
    config: projectConfig(pageUrl, { workers: 2, workerProfiles: [] }),
  });

  await expect(pending).rejects.toBeInstanceOf(QaError);
  await expect(pending).rejects.toMatchObject({
    code: "AUTH_MISSING",
    recoveryAppropriate: false,
  });
  await expect(pending).rejects.toThrow(/worker profile/);
  expect(runPoolMock).not.toHaveBeenCalled();
  expect(executeFlowMock).not.toHaveBeenCalled();
  expect(extraPids(before)).toEqual([]);
});

test("the suite module does not import stagehand", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../../../src/orchestrator/suite.ts", import.meta.url)),
    "utf8",
  );
  expect(source.toLowerCase()).not.toContain("stagehand");
  expect(source).toContain('from "../playwright/workers.js"');
  expect(source).toContain('from "./execution.js"');
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

function makeFlow(options: {
  id: string;
  steps: Step[];
  assertions: Assertion[];
  authProfile?: string;
}): FlowSpec {
  return parseFlowSpec({
    version: 1,
    id: options.id,
    name: "Exercise the page",
    objective: "Run the saved steps.",
    state: "validated",
    ...(options.authProfile === undefined
      ? {}
      : { authProfile: options.authProfile }),
    inputs: {
      target: { type: "string", required: true },
    },
    steps: options.steps,
    assertions: options.assertions,
    evidence: {
      screenshots: [{ after: "open-page" }],
      trace: "on-failure",
    },
  });
}

function gotoStep(): Step {
  return {
    id: "open-page",
    intent: "Open the page",
    action: "goto",
    value: "${target}",
  };
}

function clickStep(name: string, id: string): Step {
  return {
    id,
    intent: "Activate the button",
    action: "click",
    locator: { type: "role", role: "button", name },
  };
}

function textAssertion(id: string, locatorText: string, text: string): Assertion {
  return {
    id,
    type: "text",
    locator: { type: "text", text: locatorText },
    text,
  };
}

function projectConfig(
  baseUrl: string,
  options: { workers?: number; workerProfiles?: string[] } = {},
): ProjectConfig {
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
      workers: options.workers ?? 1,
      timeoutMs: ACTION_TIMEOUT_MS,
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
    auth: { workerProfiles: options.workerProfiles ?? [] },
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

async function expectBrowsersClosed(before: readonly number[]): Promise<void> {
  await expect.poll(() => extraPids(before), { timeout: 10_000 }).toEqual([]);
}

function browserPids(): number[] {
  let output = "";
  try {
    output = execFileSync("ps", ["-A", "-o", "pid=,command="], {
      encoding: "utf8",
    });
  } catch {
    return [];
  }

  const pids: number[] = [];
  for (const line of output.split("\n")) {
    if (!line.includes("ms-playwright")) {
      continue;
    }
    const pidText = line.trim().split(/\s+/, 1)[0];
    if (pidText === undefined) {
      continue;
    }
    const pid = Number(pidText);
    if (Number.isInteger(pid)) {
      pids.push(pid);
    }
  }
  return pids;
}

function extraPids(before: readonly number[]): number[] {
  const known = new Set(before);
  return browserPids().filter((pid) => !known.has(pid));
}
