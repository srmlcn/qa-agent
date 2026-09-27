import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  start as startArchive,
  type ArchiveApp,
  type ArchiveVariant,
} from "../../fixtures/archive-app/server.js";
import {
  PASSWORD,
  USERNAME,
  start as startAuth,
  type AuthApp,
} from "../../fixtures/auth-app/server.js";
import { scriptedLogin } from "../../src/auth/import.js";
import { listProfiles } from "../../src/auth/store.js";
import { command as initCommand } from "../../src/cli/commands/init.js";
import { loadProjectConfig } from "../../src/config/load-project.js";
import type { ProjectConfig } from "../../src/config/schema.js";
import { readRun } from "../../src/evidence/store.js";
import { read, save } from "../../src/flows/repository.js";
import { parseFlowSpec, type FlowSpec, type Step } from "../../src/flows/schema.js";
import { discoverFlow } from "../../src/orchestrator/discovery.js";
import { executeFlow } from "../../src/orchestrator/execution.js";
import { repairFlow } from "../../src/orchestrator/repair.js";
import { executeSuite } from "../../src/orchestrator/suite.js";
import { logsDir } from "../../src/runtime/paths.js";
import { createFakeClient, type FakeScript } from "../../src/stagehand/fake-client.js";
import type { LlmProvider } from "../../src/stagehand/provider.js";

const TEST_TIMEOUT_MS = 180_000;
/** A stuck browser or fixture close fails the numbered step before the test budget. */
const STEP_BUDGET_MS = 120_000;
const CLOSE_BUDGET_MS = 10_000;
const FLOW_ID_PATTERN = /^[a-z0-9]+(\.[a-z0-9-]+)*$/;
const FLOW_ID = "project.archive";
const FLOW_NAME = "Archive an active project";
const PROFILE = "project-owner";
const USERNAME_ENV = "QA_E2E_USERNAME";
const PASSWORD_ENV = "QA_E2E_PASSWORD";
const API_KEY_ENV = "QA_AGENT_E2E_ACCEPTANCE_KEY";
/**
 * The auth fixture sets `qa_session` to this value and does not export it.
 */
const SESSION_COOKIE = "session-owner";
const TEXT_EXTENSIONS = new Set([".yml", ".yaml", ".json", ".log", ".txt", ".md"]);

const USERNAME_LOCATOR = { type: "label" as const, name: "Username" };
const PASSWORD_LOCATOR = { type: "label" as const, name: "Password" };
const SUBMIT_LOCATOR = { type: "role" as const, role: "button", name: "Sign in" };

const capturedLogs: string[] = [];
const scratchDirs: string[] = [];

let previousCwd = "";
let previousHome: string | undefined;
let previousUsername: string | undefined;
let previousPassword: string | undefined;
let previousApiKey: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  if (previousCwd.length > 0) {
    process.chdir(previousCwd);
  }
  restoreEnv("AUTONOMOUS_QA_HOME", previousHome);
  restoreEnv(USERNAME_ENV, previousUsername);
  restoreEnv(PASSWORD_ENV, previousPassword);
  restoreEnv(API_KEY_ENV, previousApiKey);
  for (const scratch of scratchDirs.splice(0)) {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test(
  "the v0.1 acceptance scenario discovers, replays, and repairs the archive flow",
  async () => {
    previousCwd = process.cwd();
    previousHome = process.env.AUTONOMOUS_QA_HOME;
    previousUsername = process.env[USERNAME_ENV];
    previousPassword = process.env[PASSWORD_ENV];
    previousApiKey = process.env[API_KEY_ENV];
    captureConsole();

    const scratch = mkdtempSync(join(tmpdir(), "aqa-e2e-"));
    scratchDirs.push(scratch);
    const home = join(scratch, "home");
    const projectRoot = join(scratch, "acceptance-app");
    mkdirSync(home, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });

    let authApp: AuthApp | undefined;
    let archive: ArchiveApp | undefined;
    let archiveUrl = "";
    let archivePort = 0;
    let config: ProjectConfig | undefined;
    let projectId = "";
    let provider: LlmProvider | undefined;
    let failedRunId = "";
    let failedStepId = "";

    try {
      await runStep(1, async () => {
        authApp = await startAuth(0);
        archive = await startArchive(0, { variant: "original" });
        archiveUrl = archive.url;
        archivePort = boundPort(archiveUrl);
      });

      await runStep(2, async () => {
        process.env.AUTONOMOUS_QA_HOME = home;
        process.chdir(projectRoot);
        const code = await initCommand.run([]);
        expect(code, "init command").toBe(0);
        editProjectConfig(projectRoot, archiveUrl);
        config = loadProjectConfig(projectRoot);
        projectId = config.project.id;
        expect(config.application.productionAllowed).toBe(false);
        expect(config.application.allowedHosts).toContain("127.0.0.1");
        expect(config.security.destructiveActionsAllowed).toBe(true);
        expect(config.application.baseUrl).toBe(archiveUrl);
      });

      await runStep(3, async () => {
        delete process.env[API_KEY_ENV];
        provider = acceptanceProvider();
        expect(process.env[provider.apiKeyEnv]).toBeUndefined();
      });

      await runStep(4, async () => {
        const loaded = requireConfig(config);
        const login = requireApp(authApp, "Auth fixture is not running.");
        process.env[USERNAME_ENV] = USERNAME;
        process.env[PASSWORD_ENV] = PASSWORD;
        const imported = await scriptedLogin({
          projectId,
          profile: PROFILE,
          loginUrl: login.url,
          usernameEnv: USERNAME_ENV,
          passwordEnv: PASSWORD_ENV,
          usernameLocator: USERNAME_LOCATOR,
          passwordLocator: PASSWORD_LOCATOR,
          submitLocator: SUBMIT_LOCATOR,
          config: loaded,
        });
        expect(imported).toEqual({ profile: PROFILE, projectId });
        expect(listProfiles(projectId)).toContain(PROFILE);
      });

      await runStep(5, async () => {
        const loaded = requireConfig(config);
        const model = requireProvider(provider);
        const script = archiveScript(archiveUrl, "Archive");
        const discovered = await discoverFlow({
          id: FLOW_ID,
          name: FLOW_NAME,
          objective: "Archive the active project Alpha.",
          startUrl: archiveUrl,
          authProfile: PROFILE,
          projectRoot,
          config: loaded,
          provider: model,
          maxSteps: script.length,
          client: createFakeClient(script),
        });
        expect(discovered.flow.id).toBe(FLOW_ID);
        expect(discovered.flow.id).toMatch(FLOW_ID_PATTERN);
        expect(discovered.flow.name).toBe(FLOW_NAME);
      });

      await runStep(6, async () => {
        const saved = read(projectRoot, FLOW_ID);
        expect(saved.state).toBe("validated");
        const yaml = readFileSync(flowYamlPath(projectRoot, FLOW_ID), "utf8");
        expect(yaml).not.toContain(SESSION_COOKIE);
      });

      await runStep(7, async () => {
        archive = await replaceArchive(archive, archivePort, archiveUrl, "original");
        const executed = await executeFlow({
          flowId: FLOW_ID,
          inputs: {},
          projectRoot,
          config: requireConfig(config),
        });
        expect(executed.result.status).toBe("passed");
        expect(read(projectRoot, FLOW_ID).state).toBe("validated");
      });

      await runStep(8, async () => {
        archive = await replaceArchive(archive, archivePort, archiveUrl, "original");
        const flowIds = ["project.visible.a", "project.visible.b", "project.visible.c", "project.visible.d"];
        for (const id of flowIds) {
          expect(id).toMatch(FLOW_ID_PATTERN);
          save(projectRoot, visibleFlow(id, archiveUrl));
        }
        const summary = await executeSuite({
          flowIds,
          workers: 4,
          authStrategy: "shared",
          projectRoot,
          config: requireConfig(config),
          inputs: {},
        });
        expect(summary.passed).toBe(flowIds.length);
        expect(summary.failed).toBe(0);
        expect(summary.error).toBe(0);
        expect(summary.runs.map((run) => run.status)).toEqual(flowIds.map(() => "passed"));
      });

      await runStep(9, async () => {
        archive = await replaceArchive(archive, archivePort, archiveUrl, "renamed");
        const executed = await executeFlow({
          flowId: FLOW_ID,
          inputs: {},
          projectRoot,
          config: requireConfig(config),
        });
        expect(executed.result.failure?.category).toBe("locator");
        const saved = read(projectRoot, FLOW_ID);
        expect(saved.state).toBe("stale");
        failedRunId = executed.runId;
        failedStepId = executed.result.failure?.stepId ?? "";
        expect(failedStepId).toBe(archiveMenuStepId(saved));
      });

      await runStep(10, async () => {
        const repaired = await repairFlow({
          flowId: FLOW_ID,
          failedStepId,
          runId: failedRunId,
          projectRoot,
          config: requireConfig(config),
          provider: requireProvider(provider),
          client: createFakeClient(archiveScript(archiveUrl, "Move to archive")),
        });
        if (!repaired.repaired) {
          throw new Error(`repair left the flow stale (${repaired.reason})`);
        }
        expect(read(projectRoot, FLOW_ID).state).toBe("validated");
        expect(["failed", "error"]).toContain(readRun(projectRoot, failedRunId).status);
        const runDir = join(projectRoot, ".autonomous-qa", "artifacts", failedRunId);
        expect(existsSync(join(runDir, "previous-flow.yml"))).toBe(true);
        expect(existsSync(join(runDir, "result.json"))).toBe(true);
      });

      await runStep(11, async () => {
        assertTreeClean(join(projectRoot, ".autonomous-qa", "flows"));
        assertTreeClean(join(projectRoot, ".autonomous-qa", "artifacts"));
        assertTreeClean(logsDir());
        assertTextClean("captured logs", capturedLogs.join("\n"));
      });
    } finally {
      await closeApp(archive);
      await closeApp(authApp);
      if (previousCwd.length > 0) {
        process.chdir(previousCwd);
      }
      restoreEnv("AUTONOMOUS_QA_HOME", previousHome);
      restoreEnv(USERNAME_ENV, previousUsername);
      restoreEnv(PASSWORD_ENV, previousPassword);
      restoreEnv(API_KEY_ENV, previousApiKey);
      rmSync(scratch, { recursive: true, force: true });
    }
  },
  TEST_TIMEOUT_MS,
);

async function runStep(stepNumber: number, action: () => Promise<void>): Promise<void> {
  process.stderr.write(`step ${stepNumber} started\n`);
  try {
    await withBudget(action(), STEP_BUDGET_MS, `timed out after ${STEP_BUDGET_MS}ms`);
    process.stderr.write(`step ${stepNumber} passed\n`);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`step ${stepNumber} failed: ${detail}`, { cause: error });
  }
}

function archiveScript(url: string, menuName: string): FakeScript {
  return [
    {
      method: "goto",
      selector: "",
      description: "Open the project list",
      arguments: { url },
    },
    {
      method: "click",
      selector: 'role=button[name="Options for Alpha"]',
      description: "Open the options menu for Alpha",
      arguments: [],
    },
    {
      method: "click",
      selector: `role=menuitem[name="${menuName}"]`,
      description: "Choose the archive operation",
      arguments: [],
    },
    {
      method: "click",
      selector: 'role=button[name="Archive project"]',
      description: "Confirm that the project should be archived",
      arguments: [],
    },
  ];
}

function acceptanceProvider(): LlmProvider {
  return {
    provider: "openai-compatible",
    model: "test-model",
    baseUrl: "https://llm.example/v1",
    headers: {},
    timeoutMs: 1_000,
    maxRetries: 0,
    apiKeyEnv: API_KEY_ENV,
  };
}

/**
 * The archive fixture keeps archived projects until close.
 * Rebinding the same port leaves saved goto URLs valid.
 */
async function replaceArchive(
  current: ArchiveApp | undefined,
  port: number,
  expectedUrl: string,
  variant: ArchiveVariant,
): Promise<ArchiveApp> {
  await closeApp(current);
  const next = await listenArchive(port, variant);
  if (next.url !== expectedUrl) {
    await next.close();
    throw new Error(`Archive fixture rebound to ${next.url} instead of ${expectedUrl}.`);
  }
  return next;
}

async function listenArchive(port: number, variant: ArchiveVariant): Promise<ArchiveApp> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await startArchive(port, { variant });
    } catch (error: unknown) {
      lastError = error;
      if (!isAddrInUse(error)) {
        throw error;
      }
      await delay(50);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Could not bind the archive fixture.");
}

function visibleFlow(id: string, archiveUrl: string): FlowSpec {
  return parseFlowSpec({
    version: 1,
    id,
    name: "See project Alpha",
    objective: "Project Alpha stays on the active list.",
    state: "validated",
    inputs: {},
    steps: [
      {
        id: "open-projects",
        intent: "Open the project list",
        action: "goto",
        value: archiveUrl,
      },
    ],
    assertions: [
      {
        id: "alpha-visible",
        type: "visible",
        locator: { type: "text", text: "Alpha" },
      },
    ],
  });
}

function editProjectConfig(projectRoot: string, baseUrl: string): void {
  const configPath = join(projectRoot, ".autonomous-qa", "config.yml");
  const source = readFileSync(configPath, "utf8");
  const edited = source
    .replace("baseUrl: http://localhost:3000", `baseUrl: ${baseUrl}`)
    .replace(
      "  allowedHosts:\n    - localhost\n",
      "  allowedHosts:\n    - localhost\n    - 127.0.0.1\n",
    )
    .replace("destructiveActionsAllowed: false", "destructiveActionsAllowed: true");
  if (edited === source) {
    throw new Error("Project config still has the init defaults.");
  }
  writeFileSync(configPath, edited, "utf8");
}

function archiveMenuStepId(flow: FlowSpec): string {
  const step = flow.steps.find((candidate) => isArchiveMenuStep(candidate));
  if (step === undefined) {
    throw new Error("Saved flow is missing the Archive menu step.");
  }
  return stepIdOf(step);
}

function isArchiveMenuStep(step: Step): boolean {
  if (step.action !== "click") {
    return false;
  }
  const locator = step.locator;
  return locator.type === "role" && locator.role === "menuitem" && locator.name === "Archive";
}

function stepIdOf(step: Step): string {
  const id = (step as { id?: unknown }).id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("Archive menu step is missing an id.");
  }
  return id;
}

function flowYamlPath(projectRoot: string, id: string): string {
  return join(projectRoot, ".autonomous-qa", "flows", `${id.replaceAll(".", "--")}.yml`);
}

function assertTreeClean(root: string): void {
  if (!existsSync(root)) {
    return;
  }
  for (const file of textFiles(root)) {
    assertTextClean(file, readFileSync(file, "utf8"));
  }
}

function textFiles(root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...textFiles(path));
      continue;
    }
    if (entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name))) {
      found.push(path);
    }
  }
  return found;
}

function assertTextClean(label: string, text: string): void {
  expect(text.includes(PASSWORD), `${label} contains the auth password`).toBe(false);
  expect(text.includes(SESSION_COOKIE), `${label} contains the session cookie`).toBe(false);
}

function captureConsole(): void {
  for (const method of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      capturedLogs.push(args.map(formatLogPart).join(" "));
    });
  }
}

function formatLogPart(part: unknown): string {
  if (typeof part === "string") {
    return part;
  }
  try {
    return JSON.stringify(part);
  } catch {
    return String(part);
  }
}

function requireConfig(config: ProjectConfig | undefined): ProjectConfig {
  if (config === undefined) {
    throw new Error("Project config was not loaded.");
  }
  return config;
}

function requireProvider(provider: LlmProvider | undefined): LlmProvider {
  if (provider === undefined) {
    throw new Error("LLM provider was not built.");
  }
  return provider;
}

function requireApp(app: AuthApp | undefined, message: string): AuthApp {
  if (app === undefined) {
    throw new Error(message);
  }
  return app;
}

function boundPort(url: string): number {
  const port = Number(new URL(url).port);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Fixture URL ${url} is missing a bound port.`);
  }
  return port;
}

function isAddrInUse(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EADDRINUSE";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function closeApp(app: { close: () => Promise<void> } | undefined): Promise<void> {
  if (app === undefined) {
    return;
  }
  await withBudget(app.close(), CLOSE_BUDGET_MS, `close timed out after ${CLOSE_BUDGET_MS}ms`);
}

async function withBudget<T>(
  work: Promise<T>,
  budgetMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A budget winner leaves `work` running. Observe a later rejection here.
  void work.catch(() => undefined);
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(message));
        }, budgetMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
