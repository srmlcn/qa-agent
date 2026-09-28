import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";
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
});

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

test("browser.trace redacts cookie, authorization, and configured header secrets", async () => {
  const cookie = "debug-cookie-secret-9f3a";
  const auth = "debug-auth-secret-9f3a";
  const custom = "debug-custom-secret-9f3a";
  const marker = "debug-accept-marker-9f3a";
  const artifactDir = createArtifactDir();
  const traces: string[] = [];
  setDebugSession({
    ...session(
      recordingPage([]),
      artifactDir,
      recordingTrace(traces, secretTraceZip(cookie, auth, custom, marker)),
    ),
    redactHeaders: ["authorization", "cookie", "set-cookie", "x-secret-token"],
  });

  expect(await toolNamed("browser.trace").handler({})).toEqual({
    trace: "trace.zip",
  });
  const saved = join(artifactDir, "trace.zip");
  expect(traces).toEqual([saved]);
  const text = unzip(saved);
  expect(text.includes(Buffer.from(cookie))).toBe(false);
  expect(text.includes(Buffer.from(auth))).toBe(false);
  expect(text.includes(Buffer.from(custom))).toBe(false);
  expect(text.includes(Buffer.from(marker))).toBe(true);
  expect(text.includes(Buffer.from("[redacted]"))).toBe(true);
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

function recordingTrace(
  traces: string[],
  zip: Buffer = emptyZip(),
): DebugBrowserContext {
  return {
    tracing: {
      stop: async (options) => {
        if (options?.path === undefined) {
          traces.push("");
          return;
        }
        traces.push(options.path);
        writeFileSync(options.path, zip);
      },
    },
  };
}

function emptyZip(): Buffer {
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  return eocd;
}

function secretTraceZip(
  cookie: string,
  auth: string,
  custom: string,
  marker: string,
): Buffer {
  const network = {
    type: "resource-snapshot",
    snapshot: {
      request: {
        cookies: [{ name: "session", value: cookie }],
        headers: [
          { name: "Accept", value: marker },
          { name: "authorization", value: `Bearer ${auth}` },
          { name: "cookie", value: `session=${cookie}` },
          { name: "x-secret-token", value: custom },
        ],
      },
    },
  };
  return deflatedZip([
    { name: "trace.network", data: `${JSON.stringify(network)}\n` },
  ]);
}

function deflatedZip(files: { name: string; data: string }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const data = Buffer.from(file.data, "utf8");
    const name = Buffer.from(file.name, "utf8");
    const compressed = deflateRawSync(data);
    const checksum = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x808, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(name.length, 26);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(checksum, 4);
    descriptor.writeUInt32LE(compressed.length, 8);
    descriptor.writeUInt32LE(data.length, 12);
    locals.push(local, name, compressed, descriptor);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x808, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + compressed.length + 16;
  }
  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, eocd]);
}

function unzip(filePath: string): Buffer {
  return execFileSync("python3", ["-c", PYTHON_UNZIP, filePath]);
}

const PYTHON_UNZIP = `
import sys
import zipfile
archive = zipfile.ZipFile(sys.argv[1])
for info in archive.infolist():
    sys.stdout.buffer.write(archive.read(info.filename))
`;

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
