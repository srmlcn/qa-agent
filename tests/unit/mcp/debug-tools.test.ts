import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, test } from "vitest";
import { loadProjectConfig } from "../../../src/config/load-project.js";
import { loadTools } from "../../../src/mcp/load-tools.js";
import { createMcpServer } from "../../../src/mcp/server.js";
import {
  debugTools,
  setDebugSession,
  type DebugBrowserContext,
  type DebugPage,
  type DebugSession,
} from "../../../src/mcp/tools/debug.js";

const DEBUG_TOOL_NAMES = [
  "browser.console",
  "browser.inspect",
  "browser.network",
  "browser.screenshot",
  "browser.trace",
];

const BASE_TOOL_NAMES = [
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
];

const NO_PAGE = {
  code: "FLOW_VALIDATION_FAILED",
  message: "no active page",
  recoveryAppropriate: false,
};

const roots: string[] = [];

afterEach(() => {
  setDebugSession(undefined);
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("autoload does not register browser debug tools", async () => {
  const loaded = await import("../../../src/mcp/tools/debug.js");
  expect(loaded.tool).toBeUndefined();

  const names = (await loadTools()).map((tool) => tool.name);
  expect(names).toContain("qa.ping");
  expect(names).not.toContain("browser.screenshot");
  for (const name of DEBUG_TOOL_NAMES) {
    expect(names).not.toContain(name);
  }
}, 20_000);

test("tools/list omits browser debug tools unless stagehand.debugTools is true", async () => {
  const missingRoot = mkdtempSync(join(tmpdir(), "qa-debug-missing-"));
  roots.push(missingRoot);
  const missing = await listedNames(missingRoot);
  expect(missing).toEqual(BASE_TOOL_NAMES);
  expect(missing).not.toContain("browser.screenshot");

  const omittedRoot = writeProject(undefined);
  expect(loadProjectConfig(omittedRoot).stagehand.debugTools).toBe(false);
  expect(await listedNames(omittedRoot)).toEqual(BASE_TOOL_NAMES);

  const disabledRoot = writeProject(false);
  expect(await listedNames(disabledRoot)).not.toContain("browser.screenshot");

  const enabled = writeProject(true);
  expect(loadProjectConfig(enabled).stagehand.debugTools).toBe(true);
  expect(await listedNames(enabled)).toEqual([
    ...DEBUG_TOOL_NAMES,
    ...BASE_TOOL_NAMES,
  ]);
});

test("debug tool schemas and handlers do not accept a command or a path", async () => {
  const outside = join(mkdtempSync(join(tmpdir(), "qa-debug-outside-")), "caller.png");
  roots.push(join(outside, ".."));
  const shots: string[] = [];
  const traces: string[] = [];
  const artifactDir = createArtifactDir();
  setDebugSession(session(recordingPage(shots), artifactDir, recordingTrace(traces)));

  for (const tool of debugTools()) {
    expect(tool.schema.safeParse({}).success).toBe(true);
    expect(tool.schema.safeParse({ command: "id" }).success).toBe(false);
    expect(tool.schema.safeParse({ path: outside }).success).toBe(false);
    expect(tool.schema.safeParse({ dest: outside }).success).toBe(false);
  }

  const serverNames = await listedSchemas(writeProject(true));
  for (const tool of serverNames) {
    expect(tool.properties).not.toHaveProperty("command");
    expect(tool.properties).not.toHaveProperty("path");
    expect(tool.properties).not.toHaveProperty("dest");
  }

  const screenshot = debugTools().find((tool) => tool.name === "browser.screenshot");
  if (screenshot === undefined) {
    throw new Error("browser.screenshot is missing");
  }
  await screenshot.handler({ command: "id", path: outside, dest: outside });
  expect(shots).toEqual([join(artifactDir, "screenshot.png")]);
  expect(existsSync(outside)).toBe(false);

  const clientShots = shots.length;
  await callTool(writeProject(true), "browser.screenshot", { command: "uname" });
  expect(shots).toHaveLength(clientShots);
});

test("debug tools report no active page without using BROWSER_CRASHED", async () => {
  for (const tool of debugTools()) {
    expect(await tool.handler({})).toEqual(NO_PAGE);
    expect(JSON.stringify(await tool.handler({ command: "id" }))).not.toContain(
      "BROWSER_CRASHED",
    );
  }

  const root = writeProject(true);
  for (const name of DEBUG_TOOL_NAMES) {
    const result = await callTool(root, name, {});
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual(NO_PAGE);
    expect(JSON.stringify(result)).not.toContain("BROWSER_CRASHED");
  }
});

test("inspect returns the url and title and not page HTML", async () => {
  const secret = "SECRET-DOM-TOKEN";
  const page = {
    url: () => "http://localhost:3000/items",
    title: async () => "Items",
    content: async () => `<html><body>${secret}</body></html>`,
    innerHTML: async () => `<div>${secret}</div>`,
    screenshot: async () => {
      throw new Error("screenshot was not requested");
    },
  };
  setDebugSession(session(page, createArtifactDir(), recordingTrace([])));

  const inspect = debugTools().find((tool) => tool.name === "browser.inspect");
  if (inspect === undefined) {
    throw new Error("browser.inspect is missing");
  }
  const result = await inspect.handler({});
  expect(result).toEqual({
    url: "http://localhost:3000/items",
    title: "Items",
  });
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.stringify(result)).not.toContain("<html");
});

test("screenshot and trace write only inside the active run artifact directory", async () => {
  const shots: string[] = [];
  const traces: string[] = [];
  const artifactDir = createArtifactDir();
  setDebugSession(session(recordingPage(shots), artifactDir, recordingTrace(traces)));

  const screenshot = toolNamed("browser.screenshot");
  const trace = toolNamed("browser.trace");
  expect(await screenshot.handler({})).toEqual({ screenshot: "screenshot.png" });
  expect(await trace.handler({})).toEqual({ trace: "trace.zip" });
  expect(shots).toEqual([join(artifactDir, "screenshot.png")]);
  expect(traces).toEqual([join(artifactDir, "trace.zip")]);
  expect(existsSync(join(artifactDir, "screenshot.png"))).toBe(true);
  expect(existsSync(join(artifactDir, "trace.zip"))).toBe(true);
});

test("network and console results omit secrets and raw document HTML", async () => {
  const secret = "session=super-secret";
  const html = "<html><body>SECRET-DOM-TOKEN</body></html>";
  setDebugSession({
    ...session(recordingPage([]), createArtifactDir(), recordingTrace([])),
    network: [
      {
        method: "GET",
        url: "http://localhost:3000/api",
        status: 200,
        headers: { cookie: secret, accept: "application/json" },
      },
    ],
    console: [
      {
        level: "error",
        text: `document.cookie = "${secret}"`,
        url: "http://localhost:3000/items",
      },
    ],
  });

  const network = await toolNamed("browser.network").handler({});
  const messages = await toolNamed("browser.console").handler({});
  const serialized = JSON.stringify({ network, messages });
  expect(serialized).not.toContain(secret);
  expect(serialized).not.toContain(html);
  expect(serialized).toContain("[redacted]");
  expect(serialized).toContain("application/json");
  expect(network).toEqual({
    events: [
      {
        method: "GET",
        url: "http://localhost:3000/api",
        status: 200,
        headers: { cookie: "[redacted]", accept: "application/json" },
      },
    ],
  });
});

test("network uses project redactHeaders and redacts secrets in the url", async () => {
  const apiKey = "project-x-api-key-secret";
  const bearer = "bearer-token-in-url-value";
  const queryApiKey = "query-api-key-secret";
  const queryPassword = "query-password-secret";
  const userinfoPassword = "userinfo-password-secret";
  const events = [
    {
      method: "POST",
      url: `http://ada:${userinfoPassword}@localhost:3000/cb?api_key=${queryApiKey}&x-api-key=${apiKey}&password=${queryPassword}&ok=1&code=${bearer}#keep`,
      status: 201,
      headers: {
        "X-Api-Key": apiKey,
        Authorization: `Bearer ${bearer}`,
        Accept: "application/json",
      },
    },
  ];
  setDebugSession({
    ...session(recordingPage([]), createArtifactDir(), recordingTrace([])),
    redactHeaders: ["authorization", "cookie", "set-cookie", "x-api-key"],
    network: events,
  });

  const network = await toolNamed("browser.network").handler({});
  expect(network).toEqual({
    events: [
      {
        method: "POST",
        url: "http://ada:[redacted]@localhost:3000/cb?api_key=[redacted]&x-api-key=[redacted]&password=[redacted]&ok=1&code=[redacted]#keep",
        status: 201,
        headers: {
          "X-Api-Key": "[redacted]",
          Authorization: "[redacted]",
          Accept: "application/json",
        },
      },
    ],
  });
  expect(events[0]?.headers["X-Api-Key"]).toBe(apiKey);
  expect(events[0]?.url).toContain(apiKey);
});

test("network keeps the default header list and still redacts url secrets", async () => {
  const apiKey = "visible-x-api-key-secret";
  const bearer = "default-bearer-token-value";
  const queryPassword = "default-query-password";
  setDebugSession({
    ...session(recordingPage([]), createArtifactDir(), recordingTrace([])),
    network: [
      {
        method: "GET",
        url: `http://localhost:3000/cb?password=${queryPassword}&x-api-key=${apiKey}&authorization=${bearer}&q=1`,
        status: 200,
        headers: {
          "X-Api-Key": apiKey,
          Authorization: `Bearer ${bearer}`,
          cookie: "session=default-cookie-secret",
          accept: "text/plain",
        },
      },
    ],
  });

  const network = await toolNamed("browser.network").handler({});
  expect(network).toEqual({
    events: [
      {
        method: "GET",
        url: `http://localhost:3000/cb?password=[redacted]&x-api-key=${apiKey}&authorization=[redacted]&q=1`,
        status: 200,
        headers: {
          "X-Api-Key": apiKey,
          Authorization: "[redacted]",
          cookie: "[redacted]",
          accept: "text/plain",
        },
      },
    ],
  });
  const serialized = JSON.stringify(network);
  expect(serialized).not.toContain(bearer);
  expect(serialized).not.toContain(queryPassword);
  expect(serialized).not.toContain("default-cookie-secret");
  expect(serialized).toContain(apiKey);
});

test("console redacts authorization, json secrets, and cookies in text and url", async () => {
  const authSecret = "console-auth-secret-value";
  const password = "console-password-secret";
  const apiKey = "console-api-key-secret";
  const cookie = "console-cookie-secret";
  const projectHeader = "console-project-header-secret";
  setDebugSession({
    ...session(recordingPage([]), createArtifactDir(), recordingTrace([])),
    redactHeaders: ["x-api-key"],
    console: [
      {
        level: "error",
        text: [
          `Authorization: Bearer ${authSecret}`,
          `{"user":"ada","password":"${password}","api_key":"${apiKey}"}`,
          `document.cookie = "session=${cookie}"`,
        ].join("\n"),
        url: `http://localhost:3000/items?password=${password}&api_key=${apiKey}&x-api-key=${projectHeader}&ok=1`,
      },
    ],
  });

  const messages = await toolNamed("browser.console").handler({});
  expect(messages).toEqual({
    messages: [
      {
        level: "error",
        text: [
          "Authorization: [redacted]",
          '{"user":"ada","password":"[redacted]","api_key":"[redacted]"}',
          'document.cookie = "session=[redacted]"',
        ].join("\n"),
        url: "http://localhost:3000/items?password=[redacted]&api_key=[redacted]&x-api-key=[redacted]&ok=1",
      },
    ],
  });
  const serialized = JSON.stringify(messages);
  expect(serialized).not.toContain(authSecret);
  expect(serialized).not.toContain(password);
  expect(serialized).not.toContain(apiKey);
  expect(serialized).not.toContain(cookie);
  expect(serialized).not.toContain(projectHeader);
});

test("console still redacts secrets when the session has no header list", async () => {
  const authSecret = "fallback-auth-secret-value";
  const password = "fallback-password-secret";
  setDebugSession({
    ...session(recordingPage([]), createArtifactDir(), recordingTrace([])),
    console: [
      {
        level: "warning",
        text: `Authorization: Bearer ${authSecret}\n{"password":"${password}","note":"kept"}`,
        url: `http://localhost:3000/log?password=${password}&x-api-key=kept-project-header`,
      },
    ],
  });

  const messages = await toolNamed("browser.console").handler({});
  expect(messages).toEqual({
    messages: [
      {
        level: "warning",
        text: 'Authorization: [redacted]\n{"password":"[redacted]","note":"kept"}',
        url: "http://localhost:3000/log?password=[redacted]&x-api-key=kept-project-header",
      },
    ],
  });
  expect(JSON.stringify(messages)).not.toContain(authSecret);
  expect(JSON.stringify(messages)).not.toContain(password);
});

test("v0.1 acceptance tests do not call browser debug tools", () => {
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const source = readFileSync(join(repoRoot, "src/mcp/tools/debug.ts"), "utf8");
  expect(source).not.toContain("export const tool");
  expect(source).not.toContain("child_process");
  expect(source).not.toContain("innerHTML");
  expect(source).not.toContain(".content(");
  expect(source).not.toContain("execFile");
  expect(source).not.toContain("spawn(");

  for (const relative of ["tests/e2e", "tests/acceptance"]) {
    const directory = join(repoRoot, relative);
    if (!existsSync(directory)) {
      continue;
    }
    const entries = readdirSync(directory, { recursive: true });
    for (const entry of entries) {
      const name = typeof entry === "string" ? entry : entry.toString();
      if (!name.endsWith(".ts")) {
        continue;
      }
      const text = readFileSync(join(directory, name), "utf8");
      for (const toolName of DEBUG_TOOL_NAMES) {
        expect(text, join(relative, name)).not.toContain(toolName);
      }
    }
  }
});

function toolNamed(name: string) {
  const tool = debugTools().find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`${name} is missing`);
  }
  return tool;
}

function session(
  page: DebugPage,
  artifactDir: string,
  context: DebugBrowserContext,
): DebugSession {
  return { page, artifactDir, context };
}

function recordingPage(shots: string[]): DebugPage {
  return {
    url: () => "http://localhost:3000/items",
    title: async () => "Items",
    screenshot: async (options) => {
      shots.push(options.path);
      writeFileSync(options.path, "png");
    },
  };
}

function recordingTrace(traces: string[]): DebugBrowserContext {
  return {
    tracing: {
      stop: async (options) => {
        if (options?.path === undefined) {
          traces.push("");
          return;
        }
        traces.push(options.path);
        writeFileSync(options.path, "zip");
      },
    },
  };
}

function createArtifactDir(): string {
  const root = mkdtempSync(join(tmpdir(), "qa-debug-artifacts-"));
  roots.push(root);
  const artifactDir = join(root, ".autonomous-qa", "artifacts", "run-0123456789abcdef");
  mkdirSync(artifactDir, { recursive: true });
  return artifactDir;
}

async function listedNames(projectRoot: string): Promise<string[]> {
  return withClient(projectRoot, async (client) => {
    const listed = await client.listTools();
    return listed.tools.map((tool) => tool.name);
  });
}

async function listedSchemas(
  projectRoot: string,
): Promise<Array<{ name: string; properties: object }>> {
  return withClient(projectRoot, async (client) => {
    const listed = await client.listTools();
    return listed.tools
      .filter((tool) => tool.name.startsWith("browser."))
      .map((tool) => ({
        name: tool.name,
        properties: tool.inputSchema.properties ?? {},
      }));
  });
}

async function callTool(
  projectRoot: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean; structuredContent?: unknown }> {
  return withClient(projectRoot, async (client) => {
    const result = await client.callTool({ name, arguments: args });
    return {
      ...(result.isError === undefined ? {} : { isError: result.isError }),
      ...(result.structuredContent === undefined
        ? {}
        : { structuredContent: result.structuredContent }),
    };
  });
}

async function withClient<T>(
  projectRoot: string,
  use: (client: Client) => Promise<T>,
): Promise<T> {
  const server = await createMcpServer(projectRoot);
  const client = new Client({ name: "debug-tools-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    return await use(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function writeProject(debugToolsFlag: boolean | undefined): string {
  const debugLine =
    debugToolsFlag === undefined ? "" : `  debugTools: ${String(debugToolsFlag)}\n`;
  const yaml = `version: 1
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
${debugLine}playwright:
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
  const root = mkdtempSync(join(tmpdir(), "qa-debug-config-"));
  roots.push(root);
  mkdirSync(join(root, ".autonomous-qa"));
  writeFileSync(join(root, ".autonomous-qa", "config.yml"), yaml, "utf8");
  return root;
}
