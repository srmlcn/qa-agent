import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  start as startArchive,
  type ArchiveApp,
} from "../../../fixtures/archive-app/server.js";
import {
  PASSWORD,
  USERNAME,
  start as startAuth,
  type AuthApp,
} from "../../../fixtures/auth-app/server.js";
import { scriptedLogin } from "../../../src/auth/import.js";
import { listProfiles, readProfilePath } from "../../../src/auth/store.js";
import type { ProjectConfig } from "../../../src/config/schema.js";
import { readRun } from "../../../src/evidence/store.js";
import type { RunResult } from "../../../src/evidence/types.js";
import type { Assertion, Locator } from "../../../src/flows/schema.js";
import { parseFlowSpec } from "../../../src/flows/schema.js";
import { save } from "../../../src/flows/repository.js";
import { executeFlow } from "../../../src/orchestrator/execution.js";
import { runAssertion } from "../../../src/playwright/assertions.js";
import { runPool } from "../../../src/playwright/workers.js";

const TEST_TIMEOUT_MS = 180_000;
const ACTION_TIMEOUT_MS = 30_000;
/** `evidence.trace` mode that keeps `trace.zip` only after a failed run. */
const TRACE_ON_FAILURE = "on-failure" as const;
const PROJECT_ID = "composition";
const PROFILE = "owner";
const USERNAME_ENV = "QA_AUTH_APP_USERNAME";
const PASSWORD_ENV = "QA_AUTH_APP_PASSWORD";
const REDACTED = "[redacted]";

const USERNAME_LOCATOR: Locator = { type: "label", name: "Username" };
const PASSWORD_LOCATOR: Locator = { type: "label", name: "Password" };
const SUBMIT_LOCATOR: Locator = {
  type: "role",
  role: "button",
  name: "Sign in",
};

const ALPHA_VISIBLE: Assertion = {
  id: "alpha-visible",
  type: "visible",
  locator: { type: "text", text: "Alpha" },
};

test(
  "runtime composition reuses auth, records failure evidence, and isolates workers",
  async () => {
    const before = browserPids();
    const previousHome = process.env.AUTONOMOUS_QA_HOME;
    const previousUsername = process.env[USERNAME_ENV];
    const previousPassword = process.env[PASSWORD_ENV];
    const scratch = mkdtempSync(join(tmpdir(), "aqa-composition-"));
    const home = join(scratch, "home");
    const projectRoot = join(scratch, "project");
    mkdirSync(home, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    process.env.AUTONOMOUS_QA_HOME = home;
    process.env[USERNAME_ENV] = USERNAME;
    process.env[PASSWORD_ENV] = PASSWORD;

    let authApp: AuthApp | undefined;
    let archive: ArchiveApp | undefined;
    try {
      authApp = await startAuth(0);
      archive = await startArchive(0);

      const imported = await scriptedLogin({
        projectId: PROJECT_ID,
        profile: PROFILE,
        loginUrl: authApp.url,
        usernameEnv: USERNAME_ENV,
        passwordEnv: PASSWORD_ENV,
        usernameLocator: USERNAME_LOCATOR,
        passwordLocator: PASSWORD_LOCATOR,
        submitLocator: SUBMIT_LOCATOR,
        config: projectConfig(authApp.url),
      });
      expect(imported).toEqual({ profile: PROFILE, projectId: PROJECT_ID });
      expect(listProfiles(PROJECT_ID)).toEqual([PROFILE]);
      const storageState = readProfilePath(PROJECT_ID, PROFILE);
      const cookieValues = storageCookieValues(storageState);
      expect(cookieValues.length).toBeGreaterThan(0);

      await assertAuthReuse(authApp.url, storageState);

      save(projectRoot, failedAuthFlow(`${authApp.url}/app`));
      const failed = await executeFlow({
        flowId: "auth.signed-in",
        inputs: {},
        projectRoot,
        config: projectConfig(authApp.url),
      });
      assertFailureEvidence(projectRoot, failed.result, cookieValues);

      save(projectRoot, passingArchiveFlow(archive.url));
      const passed = await executeFlow({
        flowId: "archive.visible",
        inputs: {},
        projectRoot,
        config: projectConfig(archive.url),
      });
      assertPassingRun(projectRoot, passed.result, cookieValues);

      await assertParallelWorkers(archive.url);

      expect(traceFiles(projectRoot)).toEqual([
        join(projectRoot, ".autonomous-qa", "artifacts", failed.runId, "trace.zip"),
      ]);
      await expectBrowsersClosed(before);
    } finally {
      await authApp?.close();
      await archive?.close();
      restoreEnv("AUTONOMOUS_QA_HOME", previousHome);
      restoreEnv(USERNAME_ENV, previousUsername);
      restoreEnv(PASSWORD_ENV, previousPassword);
      rmSync(scratch, { recursive: true, force: true });
    }
  },
  TEST_TIMEOUT_MS,
);

async function assertAuthReuse(authUrl: string, storageState: string): Promise<void> {
  const outcome = await runPool({
    concurrency: 2,
    items: ["first", "second"],
    authStrategy: "shared",
    storageStates: [storageState],
    run: async ({ page }) => {
      const paths: string[] = [];
      page.on("request", (request) => {
        paths.push(new URL(request.url()).pathname);
      });
      await page.goto(`${authUrl}/app`);
      return {
        pathname: new URL(page.url()).pathname,
        projects: await page
          .getByRole("heading", { name: "Projects", exact: true })
          .count(),
        signIn: await page.getByRole("button", { name: "Sign in", exact: true }).count(),
        sawLogin: paths.includes("/login"),
      };
    },
  });

  expect(outcome.errors, "a parallel auth context failed").toEqual([]);
  expect(outcome.results).toHaveLength(2);
  for (const result of outcome.results) {
    expect(result.error, `auth context ${String(result.index)} failed`).toBeUndefined();
    expect(result.value).toEqual({
      pathname: "/app",
      projects: 1,
      signIn: 0,
      sawLogin: false,
    });
  }
}

function assertFailureEvidence(
  projectRoot: string,
  result: RunResult,
  cookieValues: readonly string[],
): void {
  expect(result.status).toBe("failed");
  expect(result.failure).toMatchObject({
    category: "assertion",
    stepId: "projects-archived",
  });
  expect(result.artifacts.screenshots).toEqual(["open-app.png"]);
  expect(result.artifacts.trace).toBe("trace.zip");
  expect(result.network.responses.some((record) => record.url.includes("/app"))).toBe(
    true,
  );
  expect(Array.isArray(result.console.errors)).toBe(true);
  expect(Array.isArray(result.console.warnings)).toBe(true);

  const cookieHeaders = cookieHeaderValues(result);
  expect(cookieHeaders.length).toBeGreaterThan(0);
  expect(cookieHeaders.every((value) => value === REDACTED)).toBe(true);

  const runDir = join(projectRoot, ".autonomous-qa", "artifacts", result.runId);
  const screenshot = join(runDir, "open-app.png");
  const trace = join(runDir, "trace.zip");
  expect(existsSync(screenshot)).toBe(true);
  expect(statSync(screenshot).size).toBeGreaterThan(0);
  expect(existsSync(trace)).toBe(true);
  expect(statSync(trace).size).toBeGreaterThan(0);
  expect(readRun(projectRoot, result.runId).artifacts.trace).toBe("trace.zip");
  assertSecretsAbsent(readFileSync(join(runDir, "result.json"), "utf8"), cookieValues);
  assertSecretsAbsent(JSON.stringify(result), cookieValues);
}

function assertPassingRun(
  projectRoot: string,
  result: RunResult,
  cookieValues: readonly string[],
): void {
  expect(result.status).toBe("passed");
  expect(result.failure).toBeUndefined();
  expect(result.steps.every((step) => step.status === "passed")).toBe(true);
  expect(result.artifacts.screenshots).toEqual(["open-projects.png"]);
  expect(result.artifacts.trace).toBeUndefined();
  expect(result.network.responses.length).toBeGreaterThan(0);
  expect(Array.isArray(result.console.errors)).toBe(true);
  expect(Array.isArray(result.console.warnings)).toBe(true);

  const runDir = join(projectRoot, ".autonomous-qa", "artifacts", result.runId);
  expect(existsSync(join(runDir, "open-projects.png"))).toBe(true);
  expect(existsSync(join(runDir, "trace.zip"))).toBe(false);
  expect(readdirSync(runDir).filter((name) => name.endsWith(".zip"))).toEqual([]);
  expect(readRun(projectRoot, result.runId).artifacts.trace).toBeUndefined();
  assertSecretsAbsent(readFileSync(join(runDir, "result.json"), "utf8"), cookieValues);
}

/**
 * Read-only checks do not archive a project, so both workers share one server.
 * Each context still keeps its own DOM and storage.
 */
async function assertParallelWorkers(archiveUrl: string): Promise<void> {
  const release = deferred<void>();
  const bothReady = deferred<void>();
  let reached = 0;
  const items = [{ marker: "worker-a" }, { marker: "worker-b" }] as const;

  const pending = runPool({
    concurrency: 2,
    items: [...items],
    authStrategy: "shared",
    storageStates: [],
    run: async ({ item, page }) => {
      try {
        await page.goto(archiveUrl);
        await runAssertion(page, ALPHA_VISIBLE, ACTION_TIMEOUT_MS);
        await page.evaluate((marker) => {
          localStorage.setItem("worker", marker);
          document.documentElement.dataset.worker = marker;
          const node = document.createElement("p");
          node.id = "worker-marker";
          node.textContent = marker;
          document.body.appendChild(node);
        }, item.marker);
      } finally {
        reached += 1;
        if (reached === items.length) {
          bothReady.resolve();
        }
      }
      await bothReady.promise;
      const openContexts = page.context().browser()?.contexts().length ?? 0;
      await release.promise;
      const snapshot = await page.evaluate(() => ({
        worker: localStorage.getItem("worker"),
        dataset: document.documentElement.dataset.worker ?? "",
        markers: Array.from(document.querySelectorAll("#worker-marker")).map(
          (node) => node.textContent,
        ),
      }));
      return { openContexts, ...snapshot };
    },
  });

  try {
    await Promise.race([bothReady.promise, pending]);
    release.resolve();
    const outcome = await pending;
    expect(outcome.errors, "a parallel context failed").toEqual([]);
    expect(outcome.results).toHaveLength(2);
    for (const result of outcome.results) {
      expect(result.error, `parallel context ${String(result.index)} failed`).toBeUndefined();
      expect(result.value).toBeDefined();
    }
    expect(outcome.results.map((result) => result.value)).toEqual([
      {
        worker: "worker-a",
        dataset: "worker-a",
        markers: ["worker-a"],
        openContexts: 2,
      },
      {
        worker: "worker-b",
        dataset: "worker-b",
        markers: ["worker-b"],
        openContexts: 2,
      },
    ]);
  } finally {
    release.resolve();
  }
}

function failedAuthFlow(appUrl: string) {
  return parseFlowSpec({
    version: 1,
    id: "auth.signed-in",
    name: "Open the signed-in archive",
    objective: "A saved session opens the project list.",
    state: "validated",
    authProfile: PROFILE,
    inputs: {},
    steps: [
      {
        id: "open-app",
        intent: "Open the signed-in project list",
        action: "goto",
        value: appUrl,
      },
    ],
    assertions: [
      {
        id: "projects-archived",
        type: "text",
        locator: { type: "role", role: "heading", name: "Projects" },
        text: "No active projects.",
      },
    ],
    evidence: {
      screenshots: [{ after: "open-app" }],
      trace: TRACE_ON_FAILURE,
    },
  });
}

function passingArchiveFlow(archiveUrl: string) {
  return parseFlowSpec({
    version: 1,
    id: "archive.visible",
    name: "See the active project",
    objective: "Alpha stays on the active list.",
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
    assertions: [ALPHA_VISIBLE],
    evidence: {
      screenshots: [{ after: "open-projects" }],
      trace: TRACE_ON_FAILURE,
    },
  });
}

function projectConfig(baseUrl: string): ProjectConfig {
  return {
    version: 1,
    project: { id: PROJECT_ID },
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
      workers: 2,
      timeoutMs: ACTION_TIMEOUT_MS,
    },
    evidence: {
      screenshots: "checkpoints",
      network: true,
      console: true,
      trace: TRACE_ON_FAILURE,
      maxResponseBodyBytes: 262_144,
    },
    security: {
      redactHeaders: ["authorization", "cookie", "set-cookie"],
      destructiveActionsAllowed: false,
      maxRunDurationMs: 600_000,
    },
    auth: { workerProfiles: [] },
  };
}

function cookieHeaderValues(result: RunResult): string[] {
  const records = [...result.network.responses, ...result.network.failedRequests];
  const values: string[] = [];
  for (const record of records) {
    for (const [name, value] of Object.entries(record.headers)) {
      const header = name.toLowerCase();
      if (header === "cookie" || header === "set-cookie") {
        values.push(value);
      }
    }
  }
  return values;
}

function storageCookieValues(storageStatePath: string): string[] {
  const parsed: unknown = JSON.parse(readFileSync(storageStatePath, "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("cookies" in parsed)) {
    return [];
  }
  const cookies = parsed.cookies;
  if (!Array.isArray(cookies)) {
    return [];
  }
  const values: string[] = [];
  for (const cookie of cookies) {
    if (
      typeof cookie === "object" &&
      cookie !== null &&
      "value" in cookie &&
      typeof cookie.value === "string" &&
      cookie.value.length > 0
    ) {
      values.push(cookie.value);
    }
  }
  return values;
}

function assertSecretsAbsent(serialized: string, cookieValues: readonly string[]): void {
  expect(serialized.includes(PASSWORD), "result.json contains the auth password").toBe(
    false,
  );
  for (const value of cookieValues) {
    expect(serialized.includes(value), "result.json contains an auth cookie value").toBe(
      false,
    );
  }
}

function traceFiles(projectRoot: string): string[] {
  const artifacts = join(projectRoot, ".autonomous-qa", "artifacts");
  if (!existsSync(artifacts)) {
    return [];
  }
  const found: string[] = [];
  for (const entry of readdirSync(artifacts, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const trace = join(artifacts, entry.name, "trace.zip");
    if (existsSync(trace)) {
      found.push(trace);
    }
  }
  return found;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return {
    promise,
    resolve: (value) => {
      if (resolve === undefined) {
        throw new Error("Deferred resolve is unavailable");
      }
      resolve(value);
    },
  };
}

async function expectBrowsersClosed(before: readonly number[]): Promise<void> {
  await expect.poll(() => extraPids(before), { timeout: 15_000 }).toEqual([]);
}

function browserPids(): number[] {
  let output = "";
  try {
    output = execFileSync("ps", ["-A", "-o", "pid=,command="], {
      encoding: "utf8",
    });
  } catch {
    return [];
  }

  const pids: number[] = [];
  for (const line of output.split("\n")) {
    if (!line.includes("ms-playwright")) {
      continue;
    }
    const pidText = line.trim().split(/\s+/, 1)[0];
    if (pidText === undefined) {
      continue;
    }
    const pid = Number(pidText);
    if (Number.isInteger(pid)) {
      pids.push(pid);
    }
  }
  return pids;
}

function extraPids(before: readonly number[]): number[] {
  const known = new Set(before);
  return browserPids().filter((pid) => !known.has(pid));
}
