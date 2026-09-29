import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ZodError } from "zod";
import type { RunResult } from "../../../src/evidence/types.js";
import { QaError } from "../../../src/errors/qa-error.js";
import type { FlowSpec } from "../../../src/flows/schema.js";
import { tool } from "../../../src/mcp/tools/discover-flow.js";
import { discoverFlow } from "../../../src/orchestrator/discovery.js";

vi.mock("../../../src/orchestrator/discovery.js", () => ({
  discoverFlow: vi.fn(),
}));

const API_KEY = "discover-flow-fixture-key";
const API_KEY_ENV = "QA_DISCOVER_FLOW_FIXTURE_KEY";
const COOKIE = "discover-flow-cookie-secret";
const FLOW_ID_PATTERN = /^[a-z0-9]+(\.[a-z0-9-]+)*$/;

const sourcePath = fileURLToPath(
  new URL("../../../src/mcp/tools/discover-flow.ts", import.meta.url),
);

const roots: string[] = [];
let previousApiKey: string | undefined;

beforeEach(() => {
  previousApiKey = process.env[API_KEY_ENV];
  process.env[API_KEY_ENV] = API_KEY;
  vi.mocked(discoverFlow).mockReset();
});

afterEach(() => {
  if (previousApiKey === undefined) {
    delete process.env[API_KEY_ENV];
  } else {
    process.env[API_KEY_ENV] = previousApiKey;
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing objective fails schema validation before discoverFlow is called", async () => {
  await expect(tool.handler({})).rejects.toBeInstanceOf(ZodError);
  expect(discoverFlow).not.toHaveBeenCalled();
});

test("a successful mocked discovery returns runId and a flow id", async () => {
  const projectRoot = createProjectRoot();
  const flow = sampleFlow();
  const result = sampleResult(flow.id);
  vi.mocked(discoverFlow).mockResolvedValue({
    runId: result.runId,
    flow,
    result,
  });

  const output = await withCwd(projectRoot, () =>
    tool.handler({
      objective: "Save the page",
      startUrl: "http://127.0.0.1:9/save",
      authProfile: "owner",
      constraints: ["Do not delete records", "Stay on the save page"],
      maxSteps: 4,
    }),
  );

  expect(output.runId).toBe(result.runId);
  expect(output.flow.id).toBe(flow.id);
  expect(output.status).toBe("passed");
  expect(Object.keys(output).sort()).toEqual(["flow", "runId", "status"]);
  expect(discoverFlow).toHaveBeenCalledTimes(1);

  const called = vi.mocked(discoverFlow).mock.calls[0]?.[0];
  expect(called?.id).toMatch(FLOW_ID_PATTERN);
  expect(called).toMatchObject({
    name: "Save the page",
    objective: "Save the page\nDo not delete records\nStay on the save page",
    startUrl: "http://127.0.0.1:9/save",
    authProfile: "owner",
    maxSteps: 4,
    projectRoot,
  });
  expect(called?.provider.headers.Authorization).toBe(`Bearer ${API_KEY}`);

  const serialized = JSON.stringify(output);
  expect(serialized).not.toContain(API_KEY);
  expect(serialized).not.toContain(COOKIE);
  expect(serialized).not.toContain("storageState");
  expect(output).not.toHaveProperty("storageState");
});

test("a QaError from discoverFlow is thrown unchanged", async () => {
  const projectRoot = createProjectRoot();
  const error = new QaError({
    code: "POLICY_BLOCKED",
    message: "blocked",
  });
  vi.mocked(discoverFlow).mockRejectedValue(error);

  await withCwd(projectRoot, () =>
    expect(tool.handler({ objective: "Save the page" })).rejects.toBe(error),
  );
  expect(vi.mocked(discoverFlow).mock.calls[0]?.[0]?.objective).toBe("Save the page");
});

test("the handler imports the orchestrator and not the stagehand package", () => {
  const source = readFileSync(sourcePath, "utf8");

  expect(tool.name).toBe("qa.discover_flow");
  expect(source).not.toContain("@browserbasehq/stagehand");
  expect(source).toContain('from "../../orchestrator/discovery.js"');
  expect(source).toContain('from "../../stagehand/provider.js"');
  expect(source).not.toContain(".strict()");
});

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
  const root = mkdtempSync(join(tmpdir(), "qa-discover-flow-"));
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
  baseUrl: http://127.0.0.1:9
  allowedHosts:
    - 127.0.0.1
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

function sampleFlow(): FlowSpec {
  return {
    version: 1,
    id: "page.save",
    name: "Save the page",
    objective: "Save the page",
    state: "validated",
    inputs: {},
    steps: [],
    assertions: [],
  };
}

function sampleResult(flowId: string): RunResult {
  return {
    runId: "run-discover-1",
    flowId,
    status: "passed",
    startedAt: "2026-09-27T00:00:00.000Z",
    durationMs: 5,
    steps: [],
    network: {
      failedRequests: [],
      responses: [
        {
          method: "GET",
          url: "http://127.0.0.1:9/save",
          status: 200,
          timing: 1,
          headers: { cookie: COOKIE },
        },
      ],
    },
    console: { errors: [], warnings: [] },
    pageErrors: [],
    artifacts: { screenshots: [] },
  };
}
