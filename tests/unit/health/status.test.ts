import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chromium } from "playwright";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { command } from "../../../src/cli/commands/doctor.js";
import { projectConfigPath } from "../../../src/config/load-project.js";
import { collectHealth } from "../../../src/health/status.js";
import { version } from "../../../src/index.js";
import { reportStatus } from "../../../src/mcp/tools/status.js";
import { recordProjectRoot } from "../../../src/runtime/project-registry.js";
import { appDir, userEnvPath, userMcpPath } from "../../../src/runtime/paths.js";

const FIXTURE_API_KEY = "doctor-fixture-key-do-not-print";
const API_KEY_ENV = "QA_DOCTOR_FIXTURE_KEY";

const roots: string[] = [];
let home: string;
let cursor: string;
let previousHome: string | undefined;
let previousCursor: string | undefined;
let previousKey: string | undefined;

beforeEach(() => {
  previousHome = process.env.AUTONOMOUS_QA_HOME;
  previousCursor = process.env.AUTONOMOUS_QA_CURSOR_DIR;
  previousKey = process.env[API_KEY_ENV];
  home = mkdtempSync(join(tmpdir(), "qa-doctor-home-"));
  cursor = mkdtempSync(join(tmpdir(), "qa-doctor-cursor-"));
  process.env.AUTONOMOUS_QA_HOME = home;
  process.env.AUTONOMOUS_QA_CURSOR_DIR = cursor;
  delete process.env[API_KEY_ENV];
});

afterEach(() => {
  vi.restoreAllMocks();
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
  rmSync(cursor, { recursive: true, force: true });
  if (previousKey === undefined) {
    delete process.env[API_KEY_ENV];
  } else {
    process.env[API_KEY_ENV] = previousKey;
  }
  const locked = join(home, "locked");
  if (existsSync(locked)) {
    chmodSync(locked, 0o700);
  }
  chmodSync(home, 0o700);
  rmSync(home, { recursive: true, force: true });
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a valid project returns configOk true", async () => {
  const root = createProject();
  writeProjectConfig(root);
  process.env[API_KEY_ENV] = FIXTURE_API_KEY;
  stubInstalledChromium();

  markUserInstall();
  const health = collectHealth(root);
  expect(health).toEqual({
    packageVersion: version,
    nodeOk: true,
    configOk: true,
    browserOk: true,
    llmOk: true,
    homeOk: true,
    appOk: true,
    userMcpOk: true,
    projectMcpOverride: false,
    userInstallOk: true,
    ffmpegAvailable: health.ffmpegAvailable,
    problems: [],
  });
  expect(JSON.stringify(health)).not.toContain(FIXTURE_API_KEY);
  expect(reportStatus(root)).toEqual(health);

  const printed = await runDoctor(root);
  expect(printed.code).toBe(0);
  expect(printed.stdout).not.toContain(FIXTURE_API_KEY);
  expect(JSON.parse(printed.stdout)).toEqual(health);
});

test("a missing project file loads global settings and does not fail a healthy user install", async () => {
  const root = createProject();
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      llm: {
        provider: "openai-compatible",
        model: "company-ui-agent",
        baseUrl: "https://llm.company.internal/v1",
        apiKeyEnv: API_KEY_ENV,
        timeoutMs: 60000,
      },
    }),
  );
  markUserInstall();
  stubInstalledChromium();
  const health = collectHealth(root);

  expect(health.configOk).toBe(true);
  expect(health.userInstallOk).toBe(true);
  expect(health.problems.some((problem) => problem.includes("Missing"))).toBe(false);
  expect(health.problems).toContain(
    `LLM API key environment variable ${API_KEY_ENV} is unset`,
  );

  const printed = await runDoctor(root);
  expect(printed.code).toBe(0);
  expect(JSON.parse(printed.stdout)).toEqual(health);
  expect(printed.stdout).not.toContain(projectConfigPath(root));
});

test("incomplete global llm settings keep configOk false without failing the user install", async () => {
  const root = createProject();
  markUserInstall();
  stubInstalledChromium();
  const health = collectHealth(root);

  expect(health.configOk).toBe(false);
  expect(health.userInstallOk).toBe(true);
  expect(health.problems.some((problem) => problem.includes("config.json"))).toBe(true);
  expect(health.problems.some((problem) => problem.includes("Missing"))).toBe(false);

  const printed = await runDoctor(root);
  expect(printed.code).toBe(0);
  expect(JSON.parse(printed.stdout)).toEqual(health);
});

test("an unset API key is a problem and doctor still exits 0", async () => {
  const root = createProject();
  writeProjectConfig(root);
  markUserInstall();
  process.env[API_KEY_ENV] = FIXTURE_API_KEY;
  stubInstalledChromium();
  const withKey = await runDoctor(root);
  expect(withKey.stdout).not.toContain(FIXTURE_API_KEY);
  delete process.env[API_KEY_ENV];

  const health = collectHealth(root);
  expect(health.llmOk).toBe(false);
  expect(health.problems).toContain(
    `LLM API key environment variable ${API_KEY_ENV} is unset`,
  );
  expect(JSON.stringify(health)).not.toContain(FIXTURE_API_KEY);

  const printed = await runDoctor(root);
  expect(printed.code).toBe(0);
  expect(printed.stdout).not.toContain(FIXTURE_API_KEY);
  expect(JSON.parse(printed.stdout)).toEqual(health);
});

test("home is ok at mode 0700 or when the directory is creatable", () => {
  const root = createProject();
  writeProjectConfig(root);
  expect(collectHealth(root).homeOk).toBe(true);

  const missing = join(home, "not-created");
  process.env.AUTONOMOUS_QA_HOME = missing;
  expect(collectHealth(root).homeOk).toBe(true);
  expect(existsSync(missing)).toBe(false);
});

test("home is not ok when the directory mode is not 0700", async () => {
  const root = createProject();
  writeProjectConfig(root);
  process.env[API_KEY_ENV] = FIXTURE_API_KEY;
  chmodSync(home, 0o755);

  const health = collectHealth(root);
  expect(health.homeOk).toBe(false);
  expect(health.problems.some((problem) => problem.includes(home))).toBe(true);

  const printed = await runDoctor(root);
  expect(printed.code).toBe(1);
  expect(printed.stdout).not.toContain(FIXTURE_API_KEY);
});

test("home is not ok when the directory cannot be created", () => {
  const root = createProject();
  const locked = join(home, "locked");
  mkdirSync(locked, { mode: 0o700 });
  chmodSync(locked, 0o555);
  process.env.AUTONOMOUS_QA_HOME = join(locked, "child");

  const health = collectHealth(root);
  expect(health.homeOk).toBe(false);
  expect(health.problems.some((problem) => problem.includes("cannot be created"))).toBe(
    true,
  );
});

test("a missing Chromium executable makes browserOk false and doctor exits 1", async () => {
  const root = createProject();
  writeProjectConfig(root);
  process.env[API_KEY_ENV] = FIXTURE_API_KEY;
  const spy = vi.spyOn(chromium, "executablePath").mockReturnValue(
    join(root, "missing-chromium"),
  );

  try {
    const health = collectHealth(root);
    expect(health.browserOk).toBe(false);
    expect(health.problems).toContain("Chromium is not installed");
    const printed = await runDoctor(root);
    expect(printed.code).toBe(1);
    expect(JSON.parse(printed.stdout)).toEqual(health);
    expect(printed.stdout).not.toContain(FIXTURE_API_KEY);
  } finally {
    spy.mockRestore();
  }
});

test("Node below 22 makes nodeOk false and doctor exits 1", async () => {
  const root = createProject();
  writeProjectConfig(root);
  process.env[API_KEY_ENV] = FIXTURE_API_KEY;
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, "node");
  Object.defineProperty(process.versions, "node", {
    value: "20.19.0",
    configurable: true,
    enumerable: true,
  });

  try {
    const health = collectHealth(root);
    expect(health.nodeOk).toBe(false);
    expect(health.problems).toContain("Node.js 20.19.0 is below 22");
    const printed = await runDoctor(root);
    expect(printed.code).toBe(1);
    expect(JSON.parse(printed.stdout)).toEqual(health);
  } finally {
    if (descriptor !== undefined) {
      Object.defineProperty(process.versions, "node", descriptor);
    }
  }
});

test("doctor reads the private env file and does not print the key", async () => {
  const root = createProject();
  writeProjectConfig(root);
  markUserInstall();
  stubInstalledChromium();
  writeFileSync(userEnvPath(), `${API_KEY_ENV}=${FIXTURE_API_KEY}\n`, { mode: 0o600 });
  chmodSync(userEnvPath(), 0o600);

  const printed = await runDoctor(root);
  const health = JSON.parse(printed.stdout) as { llmOk: boolean; problems: string[] };

  expect(printed.code).toBe(0);
  expect(health.llmOk).toBe(true);
  expect(printed.stdout).not.toContain(FIXTURE_API_KEY);
});

test("a shared project id and a project MCP server are problems with exit 0", async () => {
  const root = createProject();
  const other = createProject();
  writeProjectConfig(root);
  markUserInstall();
  stubInstalledChromium();
  process.env[API_KEY_ENV] = FIXTURE_API_KEY;
  recordProjectRoot("demo-app", other);
  recordProjectRoot("demo-app", root);
  mkdirSync(join(root, ".cursor"));
  writeFileSync(
    join(root, ".cursor", "mcp.json"),
    JSON.stringify({ mcpServers: { "autonomous-qa": { command: "custom" } } }),
  );

  const health = collectHealth(root);

  expect(health.userInstallOk).toBe(true);
  expect(health.projectMcpOverride).toBe(true);
  expect(health.problems).toContain(
    "Project .cursor/mcp.json overrides the user autonomous-qa server",
  );
  expect(health.problems).toContain(`Project id demo-app is also used at ${other}`);
  expect(JSON.stringify(health)).not.toContain(FIXTURE_API_KEY);

  const printed = await runDoctor(root);
  expect(printed.code).toBe(0);
  expect(printed.stdout).not.toContain(FIXTURE_API_KEY);
});

test("doctor is the autoloaded command name", () => {
  expect(command.name).toBe("doctor");
  expect(command.summary).toBe("report installation health");
});

/** CI does not install Chromium. These checks are not about browser setup. */
function stubInstalledChromium(): void {
  vi.spyOn(chromium, "executablePath").mockReturnValue(process.execPath);
}

function markUserInstall(): void {
  const entry = join(appDir(), "dist", "cli", "main.js");
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, "cli\n");
  writeFileSync(
    userMcpPath(),
    JSON.stringify({
      mcpServers: { "autonomous-qa": { command: process.execPath, args: ["mcp"] } },
    }),
  );
}

async function runDoctor(root: string): Promise<{ code: number; stdout: string }> {
  const previous = process.cwd();
  process.chdir(root);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});

  try {
    const code = await command.run([]);
    const stdout = log.mock.calls
      .map((call) => call.map((part) => String(part)).join(" "))
      .join("\n");
    return { code, stdout };
  } finally {
    log.mockRestore();
    process.chdir(previous);
  }
}

function createProject(): string {
  const root = mkdtempSync(join(tmpdir(), "qa-doctor-project-"));
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
