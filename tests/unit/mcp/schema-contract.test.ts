import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { loadProjectConfig } from "../../../src/config/load-project.js";
import { createMcpServer } from "../../../src/mcp/server.js";
import * as browserRuntime from "../../../src/playwright/runtime.js";

/**
 * Public tool names. `qa.ping` may be listed and is not part of this contract.
 * `browser.screenshot` is absent unless `stagehand.debugTools` is true.
 */
const REQUIRED_TOOL_NAMES = [
  "qa.status",
  "qa.discover_flow",
  "qa.execute_flow",
  "qa.execute_suite",
  "qa.repair_flow",
  "qa.get_run",
  "qa.capture_auth",
  "qa.list_flows",
  "qa.cancel_run",
] as const;

type InputSchema = {
  type: "object";
  properties?: Record<string, object>;
  required?: string[];
  additionalProperties?: unknown;
};

type ListedTool = {
  name: string;
  inputSchema: InputSchema;
};

const roots: string[] = [];

beforeEach(() => {
  vi.spyOn(browserRuntime, "startBrowser").mockRejectedValue(
    new Error("schema contract tests must not launch a browser"),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tools/list covers the public MCP tool schema contract", async () => {
  const projectRoot = writeDefaultProject();
  expect(loadProjectConfig(projectRoot).stagehand.debugTools).toBe(false);

  const tools = await listedTools(projectRoot);
  const names = tools.map((tool) => tool.name);
  for (const name of REQUIRED_TOOL_NAMES) {
    expect(names, name).toContain(name);
  }
  expect(names).not.toContain("browser.screenshot");

  for (const name of REQUIRED_TOOL_NAMES) {
    const schema = publishedSchema(tools, name);
    expect(schema.additionalProperties).toBe(false);
  }

  const discover = publishedSchema(tools, "qa.discover_flow");
  expectRequired(discover, ["objective"]);
  for (const accepted of ["startUrl", "authProfile", "constraints", "maxSteps"]) {
    expect(propertiesOf(discover)).toHaveProperty(accepted);
    expect(discover.required ?? []).not.toContain(accepted);
  }

  const executeFlow = publishedSchema(tools, "qa.execute_flow");
  expectRequired(executeFlow, ["flowId"]);
  expect(propertiesOf(executeFlow)).toHaveProperty("flowId");
  expect(propertiesOf(executeFlow)).not.toHaveProperty("objective");
  expect(hasField(executeFlow, "objective")).toBe(false);

  const executeSuite = publishedSchema(tools, "qa.execute_suite");
  expectRequired(executeSuite, ["flowIds"]);
  expect(propertiesOf(executeSuite)).toHaveProperty("flowIds");
  expect(field(executeSuite, "authStrategy")).toMatchObject({
    enum: ["shared", "per-worker"],
  });

  const repair = publishedSchema(tools, "qa.repair_flow");
  expectRequired(repair, ["flowId"]);
  expect(propertiesOf(repair)).toHaveProperty("failedStepId");
  expect(propertiesOf(repair)).toHaveProperty("runId");
  expect(repair.required ?? []).not.toContain("failedStepId");
  expect(repair.required ?? []).not.toContain("runId");

  const capture = publishedSchema(tools, "qa.capture_auth");
  expectRequired(capture, ["projectId", "profile", "startUrl"]);

  for (const name of [
    "qa.status",
    "qa.list_flows",
    "qa.discover_flow",
    "qa.execute_flow",
    "qa.execute_suite",
    "qa.repair_flow",
    "qa.capture_auth",
  ]) {
    const schema = publishedSchema(tools, name);
    expect(hasField(schema, "projectRoot"), name).toBe(true);
    expect(schema.required ?? [], name).not.toContain("projectRoot");
  }

  expect(browserRuntime.startBrowser).not.toHaveBeenCalled();
});

test("a missing project config leaves debug tools off", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "qa-schema-missing-"));
  roots.push(projectRoot);

  const tools = await listedTools(projectRoot);
  const names = tools.map((tool) => tool.name);
  for (const name of REQUIRED_TOOL_NAMES) {
    expect(names, name).toContain(name);
  }
  expect(names).not.toContain("browser.screenshot");
  expect(browserRuntime.startBrowser).not.toHaveBeenCalled();
});

function publishedSchema(tools: readonly ListedTool[], name: string): InputSchema {
  const tool = tools.find((candidate) => candidate.name === name);
  expect(tool, name).toBeDefined();
  if (tool === undefined) {
    throw new Error(`${name} is missing`);
  }
  expect(tool.inputSchema.type).toBe("object");
  return tool.inputSchema;
}

function expectRequired(schema: InputSchema, names: readonly string[]): void {
  expect([...(schema.required ?? [])].sort()).toEqual([...names].sort());
}

function propertiesOf(schema: InputSchema): Record<string, object> {
  expect(schema.properties).toBeDefined();
  if (schema.properties === undefined) {
    throw new Error("inputSchema is missing properties");
  }
  return schema.properties;
}

function field(schema: InputSchema, name: string): Record<string, unknown> {
  const value = propertiesOf(schema)[name];
  if (!isPlainObject(value)) {
    throw new Error(`${name} is missing`);
  }
  return value;
}

function hasField(schema: InputSchema, name: string): boolean {
  if (Object.prototype.hasOwnProperty.call(schema, name)) {
    return true;
  }
  const properties = schema.properties;
  if (properties !== undefined && Object.prototype.hasOwnProperty.call(properties, name)) {
    return true;
  }
  if ((schema.required ?? []).includes(name)) {
    return true;
  }
  return Object.values(schema.properties ?? {}).some((property) => nestedHasField(property, name));
}

function nestedHasField(value: object, name: string): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => isPlainObject(entry) && nestedHasField(entry, name));
  }
  if (Object.prototype.hasOwnProperty.call(value, name)) {
    return true;
  }
  return Object.values(value).some((entry) => isPlainObject(entry) && nestedHasField(entry, name));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function listedTools(projectRoot: string): Promise<ListedTool[]> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await createMcpServer(projectRoot);
  await server.connect(serverTransport);
  const client = new Client({ name: "qa-schema-contract-test", version: "0.0.0" });
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    return listed.tools.map((tool) => ({
      name: tool.name,
      inputSchema: tool.inputSchema,
    }));
  } finally {
    await client.close();
    await server.close();
  }
}

function writeDefaultProject(): string {
  const root = mkdtempSync(join(tmpdir(), "qa-schema-contract-"));
  roots.push(root);
  mkdirSync(join(root, ".autonomous-qa"));
  writeFileSync(join(root, ".autonomous-qa", "config.yml"), defaultProjectYaml(), "utf8");
  return root;
}

function defaultProjectYaml(): string {
  return `version: 1
project:
  id: demo-app
application:
  baseUrl: http://localhost:3000
  allowedHosts:
    - localhost
llm:
  provider: openai
  model: configured-model
  apiKeyEnv: OPENAI_API_KEY
  timeoutMs: 60000
stagehand:
  enabled: true
  maxSteps: 30
  recoveryEnabled: false
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
security:
  destructiveActionsAllowed: false
`;
}
