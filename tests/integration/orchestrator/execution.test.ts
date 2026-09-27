import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import type { ProjectConfig } from "../../../src/config/schema.js";
import { readRun } from "../../../src/evidence/store.js";
import { QaError } from "../../../src/errors/qa-error.js";
import type { FlowInputs } from "../../../src/flows/interpolate.js";
import { read, save } from "../../../src/flows/repository.js";
import {
  parseFlowSpec,
  type Assertion,
  type FlowSpec,
  type Step,
} from "../../../src/flows/schema.js";
import { executeFlow } from "../../../src/orchestrator/execution.js";
import { getRun } from "../../../src/orchestrator/runs.js";

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
      console.error("execution-marker");
    </script>
  </body>
</html>`;

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
  const scratch = mkdtempSync(join(tmpdir(), "aqa-execute-"));
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

test(
  "a validated two-step flow returns passed",
  async () => {
    const flow = makeFlow({
      id: "page.save",
      steps: [gotoStep(), clickStep("Save", "click-save")],
      assertions: [textAssertion("status-saved", "Saved", "Saved")],
    });
    const { before, executed, after } = await runSaved(flow);

    expect(executed.result.status).toBe("passed");
    expect(executed.result.failure).toBeUndefined();
    expect(executed.result.flowId).toBe(flow.id);
    expect(executed.result.steps.map((step) => [step.stepId, step.status])).toEqual([
      ["open-page", "passed"],
      ["click-save", "passed"],
      ["status-saved", "passed"],
    ]);
    expect(executed.result.artifacts.screenshots).toEqual(["open-page.png"]);
    expect(executed.result.artifacts.trace).toBeUndefined();
    expect(executed.result.network.responses.some((record) => record.url.startsWith(pageUrl))).toBe(
      true,
    );
    expect(
      executed.result.console.errors.some((record) =>
        record.text.includes("execution-marker"),
      ),
    ).toBe(true);
    expect(after).toEqual(before);
    expect(getRun(executed.runId).status).toBe("passed");
    expect(readRun(projectRoot, executed.runId).status).toBe("passed");
    const runDir = join(projectRoot, ".autonomous-qa", "artifacts", executed.runId);
    expect(existsSync(join(runDir, "open-page.png"))).toBe(true);
    expect(existsSync(join(runDir, "trace.zip"))).toBe(false);
  },
  TEST_TIMEOUT_MS,
);

test(
  "a broken locator returns category locator and marks the flow stale",
  async () => {
    const flow = makeFlow({
      id: "page.missing",
      steps: [gotoStep(), clickStep("Missing", "click-missing")],
      assertions: [textAssertion("status-saved", "Saved", "Saved")],
    });
    const { before, executed, after } = await runSaved(flow);

    expect(executed.result.status).toBe("failed");
    expect(executed.result.failure).toMatchObject({
      category: "locator",
      stepId: "click-missing",
    });
    expect(executed.result.steps.map((step) => [step.stepId, step.status])).toEqual([
      ["open-page", "passed"],
      ["click-missing", "failed"],
    ]);
    expect(after.state).toBe("stale");
    expect(after.steps).toEqual(before.steps);
    expect({ ...after, state: before.state }).toEqual(before);
    expect(executed.result.artifacts.trace).toBe("trace.zip");
    expect(
      existsSync(
        join(projectRoot, ".autonomous-qa", "artifacts", executed.runId, "trace.zip"),
      ),
    ).toBe(true);
    expect(getRun(executed.runId).status).toBe("failed");
  },
  TEST_TIMEOUT_MS,
);

test(
  "an assertion failure returns category assertion and does not mark the flow stale",
  async () => {
    const flow = makeFlow({
      id: "page.expect",
      steps: [gotoStep(), clickStep("Save", "click-save")],
      assertions: [textAssertion("status-idle", "Saved", "Idle")],
    });
    const { before, executed, after } = await runSaved(flow);

    expect(executed.result.status).toBe("failed");
    expect(executed.result.failure).toMatchObject({
      category: "assertion",
      stepId: "status-idle",
    });
    expect(executed.result.steps.map((step) => step.status)).toEqual([
      "passed",
      "passed",
      "failed",
    ]);
    expect(after).toEqual(before);
    expect(after.state).toBe("validated");
    expect(getRun(executed.runId).status).toBe("failed");
  },
  TEST_TIMEOUT_MS,
);

test("a missing auth profile throws AUTH_MISSING and does not launch a run directory", async () => {
  const flow = makeFlow({
    id: "page.auth",
    steps: [gotoStep(), clickStep("Save", "click-save")],
    assertions: [],
    authProfile: "missing-owner",
  });
  save(projectRoot, flow);
  const before = read(projectRoot, flow.id);

  const pending = executeFlow({
    flowId: flow.id,
    inputs: { target: pageUrl },
    projectRoot,
    config: projectConfig(pageUrl),
  });

  await expect(pending).rejects.toBeInstanceOf(QaError);
  await expect(pending).rejects.toMatchObject({ code: "AUTH_MISSING" });
  expect(read(projectRoot, flow.id)).toEqual(before);
  expect(existsSync(join(projectRoot, ".autonomous-qa", "artifacts"))).toBe(false);
});

test("a goto outside the allowlist throws POLICY_BLOCKED", async () => {
  const flow = makeFlow({
    id: "page.blocked",
    steps: [
      {
        id: "open-page",
        intent: "Open a blocked host",
        action: "goto",
        value: "https://evil.test/secret",
      },
      clickStep("Save", "click-save"),
    ],
    assertions: [],
  });
  save(projectRoot, flow);
  const before = read(projectRoot, flow.id);

  const pending = executeFlow({
    flowId: flow.id,
    inputs: { target: pageUrl },
    projectRoot,
    config: projectConfig(pageUrl),
  });

  await expect(pending).rejects.toBeInstanceOf(QaError);
  await expect(pending).rejects.toMatchObject({ code: "POLICY_BLOCKED" });
  expect(read(projectRoot, flow.id)).toEqual(before);
  expect(existsSync(join(projectRoot, ".autonomous-qa", "artifacts"))).toBe(false);
});

async function runSaved(
  flow: FlowSpec,
  inputs: FlowInputs = { target: pageUrl },
): Promise<{
  before: FlowSpec;
  executed: Awaited<ReturnType<typeof executeFlow>>;
  after: FlowSpec;
}> {
  save(projectRoot, flow);
  const before = read(projectRoot, flow.id);
  const executed = await executeFlow({
    flowId: flow.id,
    inputs,
    projectRoot,
    config: projectConfig(pageUrl),
  });
  return { before, executed, after: read(projectRoot, flow.id) };
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
