import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { QaError } from "../../../src/errors/qa-error.js";
import type { RunResult } from "../../../src/evidence/types.js";
import { save } from "../../../src/flows/repository.js";
import { parseFlowSpec } from "../../../src/flows/schema.js";
import { version } from "../../../src/index.js";
import { createMcpServer } from "../../../src/mcp/server.js";
import { complete, createRun } from "../../../src/orchestrator/runs.js";

const FIXTURE_API_KEY = "fixture-api-key-do-not-print";
const API_KEY_ENV = "QA_STATUS_FIXTURE_KEY";
const STEP_BODY_MARKER = "STEP_BODY_MARKER_not_in_list";

const roots: string[] = [];
let client: Client;
let server: McpServer;
let previousApiKey: string | undefined;

beforeAll(async () => {
  previousApiKey = process.env[API_KEY_ENV];
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  server = await createMcpServer();
  await server.connect(serverTransport);
  client = new Client({ name: "qa-read-tools-test", version: "0.0.0" });
  await client.connect(clientTransport);
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

afterAll(async () => {
  if (previousApiKey === undefined) {
    delete process.env[API_KEY_ENV];
  } else {
    process.env[API_KEY_ENV] = previousApiKey;
  }
  await client.close();
  await server.close();
});

test("tools/list includes the read tools", async () => {
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  expect(names).toEqual([
    "qa.cancel_run",
    "qa.capture_auth",
    "qa.discover_flow",
    "qa.execute_flow",
    "qa.execute_suite",
    "qa.get_run",
    "qa.list_flows",
    "qa.ping",
    "qa.repair_flow",
    "qa.status",
  ]);
});

test("qa.list_flows returns one metadata object and no steps", async () => {
  const projectRoot = createProjectRoot();
  save(projectRoot, sampleFlow());

  const listed = await withCwd(projectRoot, () => callJson("qa.list_flows", { projectRoot }));
  expect(listed).toEqual([
    {
      id: "project.archive",
      name: "Archive an active project",
      state: "validated",
      authProfile: "project-owner",
    },
  ]);
  expect(Array.isArray(listed)).toBe(true);
  if (!Array.isArray(listed)) {
    return;
  }
  expect(listed).toHaveLength(1);
  expect(listed[0]).not.toHaveProperty("steps");
  expect(JSON.stringify(listed)).not.toContain("steps");
  expect(JSON.stringify(listed)).not.toContain(STEP_BODY_MARKER);
});

test("qa.get_run returns a stored result and relative artifact paths", async () => {
  const created = createRun("project.archive");
  const result = storedResult(created.runId, "project.archive");
  complete(created.runId, result);

  const output = await callJson("qa.get_run", { runId: created.runId });
  expect(output).toEqual({
    runId: created.runId,
    flowId: "project.archive",
    status: "passed",
    result,
    artifacts: ["screenshots/open.png", "trace.zip"],
  });
});

test("qa.get_run reports an unknown run as QaError JSON", async () => {
  const runId = "run-does-not-exist";
  const called = await client.callTool({
    name: "qa.get_run",
    arguments: { runId },
  });

  expect(called.isError).toBe(true);
  const text = textContent(called);
  expect(JSON.parse(text)).toEqual(
    new QaError({
      code: "FLOW_VALIDATION_FAILED",
      message: "run not found",
      runId,
    }).toJSON(),
  );
  expect(text).toBe(
    JSON.stringify(
      new QaError({
        code: "FLOW_VALIDATION_FAILED",
        message: "run not found",
        runId,
      }).toJSON(),
    ),
  );
});

test("qa.status does not include a fixture API key from the environment", async () => {
  const projectRoot = createProjectRoot();
  writeProjectConfig(projectRoot);
  const previousHome = process.env.AUTONOMOUS_QA_HOME;
  const previousCursor = process.env.AUTONOMOUS_QA_CURSOR_DIR;
  const home = mkdtempSync(join(tmpdir(), "qa-status-home-"));
  process.env.AUTONOMOUS_QA_HOME = home;
  process.env.AUTONOMOUS_QA_CURSOR_DIR = home;
  process.env[API_KEY_ENV] = FIXTURE_API_KEY;

  try {
    const ready = await withCwd(projectRoot, () => callJson("qa.status", { projectRoot }));
    expect(ready).toMatchObject({
      packageVersion: version,
      nodeOk: true,
      configOk: true,
      llmOk: true,
      homeOk: true,
    });
    expect(typeof ready).toBe("object");
    if (!isRecord(ready)) {
      return;
    }
    expect(typeof ready.browserOk).toBe("boolean");
    expect(JSON.stringify(ready)).not.toContain(FIXTURE_API_KEY);
    expect(ready.problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Installed app is missing"),
        expect.stringContaining("User MCP server is missing"),
      ]),
    );
    if (ready.browserOk !== true) {
      expect(ready.problems).toContain("Chromium is not installed");
    }

    delete process.env[API_KEY_ENV];
    const missingKey = await withCwd(projectRoot, () => callJson("qa.status", { projectRoot }));
    expect(missingKey).toMatchObject({
      configOk: true,
      llmOk: false,
      homeOk: true,
    });
    expect(JSON.stringify(missingKey)).not.toContain(FIXTURE_API_KEY);
    if (isRecord(missingKey) && Array.isArray(missingKey.problems)) {
      expect(missingKey.problems).toContain(
        `LLM API key environment variable ${API_KEY_ENV} is unset`,
      );
    }
  } finally {
    if (previousHome === undefined) {
      delete process.env.AUTONOMOUS_QA_HOME;
    } else {
      process.env.AUTONOMOUS_QA_HOME = previousHome;
    }
    if (previousCursor === undefined) {
      delete process.env.AUTONOMOUS_QA_CURSOR_DIR;
    } else {
      process.env.AUTONOMOUS_QA_CURSOR_DIR = previousCursor;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

async function callJson(name: string, args: Record<string, unknown>): Promise<unknown> {
  const called = await client.callTool({ name, arguments: args });
  expect(called.isError).not.toBe(true);
  if (isRecord(called) && called.structuredContent !== undefined) {
    return called.structuredContent;
  }
  return JSON.parse(textContent(called));
}

function textContent(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) {
    throw new Error("tool result is missing content");
  }
  const block = result.content[0];
  if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
    throw new Error("tool result is missing text");
  }
  return block.text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  const root = mkdtempSync(join(tmpdir(), "qa-read-tools-"));
  roots.push(root);
  return root;
}

function writeProjectConfig(projectRoot: string): void {
  const directory = join(projectRoot, ".autonomous-qa");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "config.yml"), projectConfigYaml(), "utf8");
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
  productionAllowed: false
llm:
  provider: openai-compatible
  model: company-ui-agent
  baseUrl: https://llm.company.internal/v1
  apiKeyEnv: ${API_KEY_ENV}
  timeoutMs: 60000
stagehand:
  enabled: true
  maxSteps: 30
  recoveryEnabled: true
playwright:
  browser: chromium
  headless: true
  workers: 1
  timeoutMs: 30000
evidence:
  screenshots: checkpoints
  network: true
  console: true
  trace: on-failure
  maxResponseBodyBytes: 262144
security:
  redactHeaders:
    - authorization
  destructiveActionsAllowed: false
`;
}

function sampleFlow() {
  return parseFlowSpec({
    version: 1,
    id: "project.archive",
    name: "Archive an active project",
    objective: "Archive a project and keep the archived state.",
    state: "validated",
    authProfile: "project-owner",
    inputs: {},
    steps: [
      {
        id: "confirm-archive",
        intent: STEP_BODY_MARKER,
        action: "click",
        locator: {
          type: "role",
          role: "button",
          name: "Archive project",
        },
      },
    ],
    assertions: [],
  });
}

function storedResult(runId: string, flowId: string): RunResult {
  return {
    runId,
    flowId,
    status: "passed",
    startedAt: "2026-09-27T00:00:00.000Z",
    durationMs: 12,
    steps: [
      {
        stepId: "open",
        status: "passed",
        startedAt: "2026-09-27T00:00:00.000Z",
        durationMs: 12,
      },
    ],
    network: { failedRequests: [], responses: [] },
    console: { errors: [], warnings: [] },
    pageErrors: [],
    artifacts: {
      screenshots: ["screenshots/open.png"],
      trace: "trace.zip",
    },
  };
}
