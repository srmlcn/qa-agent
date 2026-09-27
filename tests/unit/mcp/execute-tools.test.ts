import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ZodArray,
  ZodBoolean,
  ZodDefault,
  ZodEnum,
  ZodObject,
  ZodOptional,
  ZodString,
  type ZodTypeAny,
} from "zod";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { RunResult } from "../../../src/evidence/types.js";
import { tool as executeFlowTool } from "../../../src/mcp/tools/execute-flow.js";
import { tool as executeSuiteTool } from "../../../src/mcp/tools/execute-suite.js";
import { executeFlow } from "../../../src/orchestrator/execution.js";
import { executeSuite } from "../../../src/orchestrator/suite.js";
import * as browserRuntime from "../../../src/playwright/runtime.js";

vi.mock("../../../src/orchestrator/execution.js", () => ({
  executeFlow: vi.fn(),
}));

vi.mock("../../../src/orchestrator/suite.js", () => ({
  executeSuite: vi.fn(),
}));

const roots: string[] = [];

beforeEach(() => {
  vi.mocked(executeFlow).mockReset();
  vi.mocked(executeSuite).mockReset();
  vi.spyOn(browserRuntime, "startBrowser").mockRejectedValue(
    new Error("execute tool tests must not launch a browser"),
  );
  vi.mocked(executeFlow).mockResolvedValue({
    runId: "run-1",
    result: runResult("run-1", "project.archive", "passed"),
  });
  vi.mocked(executeSuite).mockResolvedValue({
    runs: [{ flowId: "project.archive", runId: "run-1", status: "passed" }],
    passed: 1,
    failed: 0,
    error: 0,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("qa.execute_flow rejects a missing flowId and does not call executeFlow", async () => {
  const parsed = executeFlowTool.schema.safeParse({});
  expect(parsed.success).toBe(false);
  if (!parsed.success) {
    expect(parsed.error.issues.some((issue) => issue.path.includes("flowId"))).toBe(
      true,
    );
  }

  await expect(executeFlowTool.handler({})).rejects.toThrow();
  expect(executeFlow).not.toHaveBeenCalled();
  expect(browserRuntime.startBrowser).not.toHaveBeenCalled();
});

test("qa.execute_suite rejects a missing flowIds and does not call executeSuite", async () => {
  const parsed = executeSuiteTool.schema.safeParse({});
  expect(parsed.success).toBe(false);
  if (!parsed.success) {
    expect(parsed.error.issues.some((issue) => issue.path.includes("flowIds"))).toBe(
      true,
    );
  }

  await expect(executeSuiteTool.handler({})).rejects.toThrow();
  expect(executeSuite).not.toHaveBeenCalled();
  expect(browserRuntime.startBrowser).not.toHaveBeenCalled();
});

test("execute tool schemas have no model or objective field", () => {
  const flowShape = objectShape(executeFlowTool.schema);
  const suiteShape = objectShape(executeSuiteTool.schema);

  expect(Object.keys(flowShape)).toEqual([
    "flowId",
    "inputs",
    "authProfile",
    "headed",
    "collectTrace",
    "projectRoot",
  ]);
  expect(flowShape.flowId).toBeInstanceOf(ZodString);
  expect(flowShape.inputs).toBeInstanceOf(ZodDefault);
  expect(flowShape.headed).toBeInstanceOf(ZodDefault);
  expect(flowShape.collectTrace).toBeInstanceOf(ZodOptional);
  expect(unwrapOptional(flowShape.collectTrace)).toBeInstanceOf(ZodBoolean);
  expect(flowShape.model).toBeUndefined();
  expect(flowShape.objective).toBeUndefined();

  expect(Object.keys(suiteShape)).toEqual([
    "flowIds",
    "workers",
    "authStrategy",
    "projectRoot",
  ]);
  expect(suiteShape.flowIds).toBeInstanceOf(ZodArray);
  expect(suiteShape.authStrategy).toBeInstanceOf(ZodOptional);
  expect(unwrapOptional(suiteShape.authStrategy)).toBeInstanceOf(ZodEnum);
  expect(enumOptions(unwrapOptional(suiteShape.authStrategy))).toEqual([
    "shared",
    "per-worker",
  ]);
  expect(suiteShape.model).toBeUndefined();
  expect(suiteShape.objective).toBeUndefined();
});

test("qa.execute_flow calls executeFlow once and forwards collectTrace false", async () => {
  const projectRoot = createProjectRoot();
  const failure = {
    stepId: "confirm-archive",
    category: "assertion" as const,
    message: "Archive button was not visible",
  };
  vi.mocked(executeFlow).mockResolvedValue({
    runId: "run-1",
    result: runResult("run-1", "project.archive", "failed", failure),
  });

  const output = await executeFlowTool.handler({
    flowId: "project.archive",
    inputs: { sku: "a-1" },
    authProfile: "project-owner",
    headed: true,
    collectTrace: false,
    projectRoot,
    model: "company-ui-agent",
    objective: "Archive a project",
  });

  expect(executeFlow).toHaveBeenCalledTimes(1);
  expect(executeFlow).toHaveBeenCalledWith({
    flowId: "project.archive",
    inputs: { sku: "a-1" },
    authProfile: "project-owner",
    headed: true,
    collectTrace: false,
    projectRoot,
    config: expect.any(Object),
  });
  expect(output).toEqual({
    runId: "run-1",
    status: "failed",
    failure,
  });
  expect(browserRuntime.startBrowser).not.toHaveBeenCalled();
});

test("qa.execute_flow omits failure when the run has none", async () => {
  const projectRoot = createProjectRoot();

  const output = await executeFlowTool.handler({
    flowId: "project.archive",
    projectRoot,
  });

  expect(executeFlow).toHaveBeenCalledTimes(1);
  expect(executeFlow).toHaveBeenCalledWith({
    flowId: "project.archive",
    inputs: {},
    headed: false,
    projectRoot,
    config: expect.any(Object),
  });
  expect(output).toEqual({
    runId: "run-1",
    status: "passed",
  });
  expect(output).not.toHaveProperty("failure");
  expect(output).not.toHaveProperty("collectTrace");
});

test("qa.execute_suite calls executeSuite once with shared auth and no workers", async () => {
  const projectRoot = createProjectRoot();
  const aggregate = {
    runs: [{ flowId: "project.archive", runId: "run-1", status: "passed" as const }],
    passed: 1,
    failed: 0,
    error: 0,
  };
  vi.mocked(executeSuite).mockResolvedValue(aggregate);

  const output = await executeSuiteTool.handler({
    flowIds: ["project.archive", "project.restore"],
    projectRoot,
    model: "company-ui-agent",
    objective: "Run the suite",
  });

  expect(executeSuite).toHaveBeenCalledTimes(1);
  const options = vi.mocked(executeSuite).mock.calls[0]?.[0];
  expect(options).toMatchObject({
    flowIds: ["project.archive", "project.restore"],
    authStrategy: "shared",
    inputs: {},
    projectRoot,
  });
  expect(options).not.toHaveProperty("workers");
  expect(options?.config.playwright.workers).toBe(3);
  expect(output).toEqual(aggregate);
  expect(browserRuntime.startBrowser).not.toHaveBeenCalled();
});

test("qa.execute_suite forwards workers and per-worker auth", async () => {
  const projectRoot = createProjectRoot();

  await executeSuiteTool.handler({
    flowIds: ["project.archive"],
    workers: 2,
    authStrategy: "per-worker",
    projectRoot,
  });

  expect(executeSuite).toHaveBeenCalledTimes(1);
  expect(executeSuite).toHaveBeenCalledWith(
    expect.objectContaining({
      flowIds: ["project.archive"],
      workers: 2,
      authStrategy: "per-worker",
      inputs: {},
      projectRoot,
    }),
  );
});

test("execute tool sources do not contain stagehand", () => {
  const flowSource = readToolSource("execute-flow.ts");
  const suiteSource = readToolSource("execute-suite.ts");

  expect(flowSource.toLowerCase().includes("stagehand")).toBe(false);
  expect(suiteSource.toLowerCase().includes("stagehand")).toBe(false);
  expect(flowSource.includes("@browserbasehq/stagehand")).toBe(false);
  expect(suiteSource.includes("@browserbasehq/stagehand")).toBe(false);
});

function objectShape(schema: ZodTypeAny): Record<string, ZodTypeAny> {
  expect(schema).toBeInstanceOf(ZodObject);
  if (!(schema instanceof ZodObject)) {
    throw new Error("tool schema must be a Zod object");
  }
  return schema.shape;
}

function unwrapOptional(schema: ZodTypeAny | undefined): ZodTypeAny {
  if (!(schema instanceof ZodOptional)) {
    throw new Error("expected an optional Zod schema");
  }
  return schema.unwrap();
}

function enumOptions(schema: ZodTypeAny): readonly string[] {
  if (!(schema instanceof ZodEnum)) {
    throw new Error("expected a Zod enum");
  }
  return schema.options;
}

function readToolSource(filename: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../src/mcp/tools/${filename}`, import.meta.url)),
    "utf8",
  );
}

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "qa-execute-tools-"));
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
  apiKeyEnv: QA_EXECUTE_FIXTURE_KEY
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

function runResult(
  runId: string,
  flowId: string,
  status: RunResult["status"],
  failure?: RunResult["failure"],
): RunResult {
  const result: RunResult = {
    runId,
    flowId,
    status,
    startedAt: "2026-09-27T00:00:00.000Z",
    durationMs: 4,
    steps: [],
    network: { failedRequests: [], responses: [] },
    console: { errors: [], warnings: [] },
    pageErrors: [],
    artifacts: { screenshots: [] },
  };
  if (failure !== undefined) {
    result.failure = failure;
  }
  return result;
}
