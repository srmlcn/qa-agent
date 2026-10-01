import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { captureProfile } from "../../../src/auth/capture.js";
import { QaError } from "../../../src/errors/qa-error.js";
import { tool as cancelRunTool } from "../../../src/mcp/tools/cancel-run.js";
import { tool as captureAuthTool } from "../../../src/mcp/tools/capture-auth.js";
import { tool as repairFlowTool } from "../../../src/mcp/tools/repair-flow.js";
import { repairFlow } from "../../../src/orchestrator/repair.js";
import { cancel, getRun } from "../../../src/orchestrator/runs.js";
import * as browserRuntime from "../../../src/playwright/runtime.js";

vi.mock("../../../src/orchestrator/repair.js", () => ({
  repairFlow: vi.fn(),
}));

vi.mock("../../../src/orchestrator/runs.js", () => ({
  cancel: vi.fn(),
  getRun: vi.fn(),
}));

vi.mock("../../../src/auth/capture.js", () => ({
  captureProfile: vi.fn(),
}));

const roots: string[] = [];

beforeEach(() => {
  vi.mocked(repairFlow).mockReset();
  vi.mocked(cancel).mockReset();
  vi.mocked(getRun).mockReset();
  vi.mocked(getRun).mockReturnValue({
    runId: "run-1",
    flowId: "archive-project",
    status: "cancelled",
    signal: new AbortController().signal,
  });
  vi.mocked(captureProfile).mockReset();
  vi.spyOn(browserRuntime, "startBrowser").mockRejectedValue(
    new Error("control tool tests must not launch a browser"),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("qa.repair_flow rejects a missing flowId and does not call repairFlow", async () => {
  const parsed = repairFlowTool.schema.safeParse({});
  expect(parsed.success).toBe(false);
  if (!parsed.success) {
    expect(parsed.error.issues.some((issue) => issue.path.includes("flowId"))).toBe(
      true,
    );
  }

  await expect(repairFlowTool.handler({})).rejects.toThrow();
  expect(repairFlow).not.toHaveBeenCalled();
  expect(browserRuntime.startBrowser).not.toHaveBeenCalled();
});

test("qa.repair_flow maps a product failure to the original run id", async () => {
  const projectRoot = createProjectRoot();
  vi.mocked(repairFlow).mockResolvedValue({
    repaired: false,
    reason: "product-failure",
    runId: "run-1",
  });

  const output = await withCwd(projectRoot, () =>
    repairFlowTool.handler({
      flowId: "project.archive",
      failedStepId: "confirm-archive",
      runId: "run-1",
      cookies: "secret-cookie",
      client: { act: true },
      projectRoot,
    }),
  );

  expect(repairFlow).toHaveBeenCalledTimes(1);
  const called = vi.mocked(repairFlow).mock.calls[0]?.[0];
  expect(Object.keys(called ?? {}).sort()).toEqual([
    "config",
    "failedStepId",
    "flowId",
    "projectRoot",
    "provider",
    "runId",
  ]);
  expect(called).toMatchObject({
    flowId: "project.archive",
    failedStepId: "confirm-archive",
    runId: "run-1",
    projectRoot,
  });
  expect(called).not.toHaveProperty("client");
  expect(output).toEqual({ repaired: false, runId: "run-1" });
  expect(output).not.toHaveProperty("reason");
  expect(output).not.toHaveProperty("repairRunId");
  expect(output).not.toHaveProperty("flow");
  expect(JSON.stringify(output)).not.toContain("cookies");
  expect(browserRuntime.startBrowser).not.toHaveBeenCalled();
});

test("qa.repair_flow maps a replay failure to the original run id", async () => {
  const projectRoot = createProjectRoot();
  vi.mocked(repairFlow).mockResolvedValue({
    repaired: false,
    reason: "replay-failure",
    runId: "run-1",
    repairRunId: "repair-9",
    result: {
      runId: "repair-9",
      flowId: "project.archive",
      status: "failed",
      startedAt: "2026-09-27T00:00:00.000Z",
      durationMs: 4,
      steps: [],
      network: { failedRequests: [], responses: [] },
      console: { errors: [], warnings: [] },
      pageErrors: [],
      artifacts: { screenshots: [] },
    },
  });

  const output = await withCwd(projectRoot, () =>
    repairFlowTool.handler({
      flowId: "project.archive",
      failedStepId: "confirm-archive",
      runId: "run-1",
      projectRoot,
    }),
  );

  expect(output).toEqual({ repaired: false, runId: "run-1" });
  expect(output).not.toHaveProperty("repairRunId");
  expect(output).not.toHaveProperty("reason");
});

test("qa.repair_flow returns the flow when repair succeeds", async () => {
  const projectRoot = createProjectRoot();
  const flow = { id: "project.archive" };
  vi.mocked(repairFlow).mockResolvedValue({
    repaired: true,
    runId: "run-1",
    repairRunId: "repair-9",
    flow: flow as never,
    result: {
      runId: "repair-9",
      flowId: "project.archive",
      status: "passed",
      startedAt: "2026-09-27T00:00:00.000Z",
      durationMs: 4,
      steps: [],
      network: { failedRequests: [], responses: [] },
      console: { errors: [], warnings: [] },
      pageErrors: [],
      artifacts: { screenshots: [] },
    },
  });

  const output = await withCwd(projectRoot, () =>
    repairFlowTool.handler({
      flowId: "project.archive",
      failedStepId: "confirm-archive",
      runId: "run-1",
      projectRoot,
    }),
  );

  expect(output).toEqual({ repaired: true, runId: "run-1", flow });
  expect(output).not.toHaveProperty("repairRunId");
});

test("omitting runId or failedStepId throws and does not call repairFlow", async () => {
  const projectRoot = createProjectRoot();

  await withCwd(projectRoot, async () => {
    await expect(
      repairFlowTool.handler({
        flowId: "project.archive",
        failedStepId: "confirm-archive",
        projectRoot,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "FLOW_VALIDATION_FAILED",
        message: "run not found",
      }),
    );

    await expect(
      repairFlowTool.handler({
        flowId: "project.archive",
        runId: "run-1",
        projectRoot,
      }),
    ).rejects.toBeInstanceOf(QaError);
  });

  expect(repairFlow).not.toHaveBeenCalled();
  expect(browserRuntime.startBrowser).not.toHaveBeenCalled();
});

test("qa.cancel_run calls cancel once and returns cancelled", async () => {
  const output = await cancelRunTool.handler({ runId: "run-1" });

  expect(cancel).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalledWith("run-1");
  expect(output).toEqual({ runId: "run-1", status: "cancelled" });
  expect(browserRuntime.startBrowser).not.toHaveBeenCalled();
});

test("qa.capture_auth returns the profile and does not return cookies", async () => {
  const projectRoot = createProjectRoot();
  vi.mocked(captureProfile).mockResolvedValue({
    projectId: "demo-app",
    profile: "owner",
  });

  const output = await withCwd(projectRoot, () =>
    captureAuthTool.handler({
      projectId: "demo-app",
      profile: "owner",
      startUrl: "http://localhost:3000/login",
      cookies: [{ name: "session", value: "secret-cookie" }],
      projectRoot,
    }),
  );

  expect(captureProfile).toHaveBeenCalledTimes(1);
  const called = vi.mocked(captureProfile).mock.calls[0]?.[0];
  expect(called).toMatchObject({
    projectId: "demo-app",
    profile: "owner",
    startUrl: "http://localhost:3000/login",
    config: expect.any(Object),
  });
  expect(called).not.toHaveProperty("cookies");
  expect(output).toEqual({ projectId: "demo-app", profile: "owner" });
  expect(JSON.stringify(output)).not.toContain("cookies");
  expect(browserRuntime.startBrowser).not.toHaveBeenCalled();
});

test("control tool sources do not import @browserbasehq/stagehand", () => {
  for (const filename of ["repair-flow.ts", "cancel-run.ts", "capture-auth.ts"]) {
    expect(readToolSource(filename).includes("@browserbasehq/stagehand")).toBe(false);
  }
});

function readToolSource(filename: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../src/mcp/tools/${filename}`, import.meta.url)),
    "utf8",
  );
}

async function withCwd<T>(directory: string, run: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(directory);
  try {
    return await run();
  } finally {
    process.chdir(previous);
  }
}

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "qa-control-tools-"));
  roots.push(root);
  const directory = join(root, ".autonomous-qa");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "config.yml"), projectConfigYaml(), "utf8");
  return root;
}

function projectConfigYaml(): string {
  return `
version: 1
project:
  id: demo-app
application:
  baseUrl: http://localhost:3000
  allowedHosts:
    - localhost
llm:
  provider: openai-compatible
  model: company-ui-agent
  baseUrl: https://llm.company.internal/v1
  apiKeyEnv: QA_CONTROL_FIXTURE_KEY
  timeoutMs: 60000
stagehand:
  enabled: true
  recoveryEnabled: true
playwright:
  workers: 3
  timeoutMs: 30000
evidence:
  screenshots: checkpoints
  network: true
  console: true
  trace: on-failure
`;
}
