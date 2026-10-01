import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  PASSWORD,
  USERNAME,
  start,
  type AuthApp,
} from "../../../fixtures/auth-app/server.js";
import { scriptedLogin } from "../../../src/auth/import.js";
import { readProfilePath } from "../../../src/auth/store.js";
import type { ProjectConfig } from "../../../src/config/schema.js";
import type { Locator } from "../../../src/flows/schema.js";
import { QaError } from "../../../src/errors/qa-error.js";
import { discoverFlow } from "../../../src/orchestrator/discovery.js";
import { createFakeClient } from "../../../src/stagehand/fake-client.js";
import type { LlmProvider } from "../../../src/stagehand/provider.js";
import { discover } from "../../../src/stagehand/session.js";

const TEST_TIMEOUT_MS = 180_000;
const LAUNCH_TIMEOUT_MS = 30_000;
const API_KEY_ENV = "QA_AGENT_DISCOVERY_AUTH_KEY";
const API_KEY = "sk-test-discovery-auth";
const USERNAME_ENV = "QA_AUTH_APP_USERNAME";
const PASSWORD_ENV = "QA_AUTH_APP_PASSWORD";
const PROJECT_ID = "auth-fixture";
const PROFILE = "owner";

const USERNAME_LOCATOR: Locator = { type: "label", name: "Username" };
const PASSWORD_LOCATOR: Locator = { type: "label", name: "Password" };
const SUBMIT_LOCATOR: Locator = {
  type: "role",
  role: "button",
  name: "Sign in",
};

test(
  "discovery attaches to the authenticated browser and replay keeps the profile",
  async () => {
    const previousHome = process.env.AUTONOMOUS_QA_HOME;
    const previousKey = process.env[API_KEY_ENV];
    const previousUsername = process.env[USERNAME_ENV];
    const previousPassword = process.env[PASSWORD_ENV];
    const home = mkdtempSync(join(tmpdir(), "aqa-discover-auth-"));
    process.env.AUTONOMOUS_QA_HOME = home;
    process.env[API_KEY_ENV] = API_KEY;
    process.env[USERNAME_ENV] = USERNAME;
    process.env[PASSWORD_ENV] = PASSWORD;

    let app: AuthApp | undefined;
    let llm: { url: string; close: () => Promise<void> } | undefined;
    const prompts: string[] = [];
    let sessionDebugger: SessionDebugger | undefined;
    try {
      app = await start(0);
      const startUrl = `${app.url}/app`;
      llm = await startLlm(async (body) => {
        prompts.push(body);
        sessionDebugger = await findDebuggerServing(startUrl);
      });
      const projectRoot = join(home, "project");
      const config = projectConfig(app.url);
      await scriptedLogin({
        projectId: PROJECT_ID,
        profile: PROFILE,
        loginUrl: app.url,
        usernameEnv: USERNAME_ENV,
        passwordEnv: PASSWORD_ENV,
        usernameLocator: USERNAME_LOCATOR,
        passwordLocator: PASSWORD_LOCATOR,
        submitLocator: SUBMIT_LOCATOR,
        config,
      });
      const storageState = readProfilePath(PROJECT_ID, PROFILE);
      const controller = new AbortController();

      const error = await rejected(
        discover({
          objective: "Read the signed-in projects page",
          startUrl,
          config,
          provider: provider(llm.url),
          maxSteps: 1,
          signal: controller.signal,
          storageState,
        }),
      );

      expect(error.code).toBe("DISCOVERY_FAILED");
      expect(error.message).toContain("Discovery stopped");
      expect(prompts.join("\n")).toContain(startUrl);
      expect(sessionDebugger).toBeDefined();
      if (sessionDebugger === undefined) {
        return;
      }
      expect(await sessionDebuggerGone(sessionDebugger)).toBe(true);

      const discovered = await discoverFlow({
        id: "page.options",
        name: "Open project options",
        objective: "Open the options menu",
        startUrl,
        authProfile: PROFILE,
        projectRoot,
        config,
        provider: provider(llm.url),
        client: createFakeClient([
          {
            method: "click",
            selector: 'role=button[name="Options for Alpha"]',
            description: "Open the options menu",
            arguments: [],
          },
        ]),
      });

      expect(discovered.flow.state).toBe("validated");
      expect(discovered.flow.authProfile).toBe(PROFILE);
      expect(discovered.result.status).toBe("passed");
      expect(await sessionDebuggerGone(sessionDebugger)).toBe(true);
    } finally {
      await llm?.close();
      await app?.close();
      restoreEnv("AUTONOMOUS_QA_HOME", previousHome);
      restoreEnv(API_KEY_ENV, previousKey);
      restoreEnv(USERNAME_ENV, previousUsername);
      restoreEnv(PASSWORD_ENV, previousPassword);
      rmSync(home, { recursive: true, force: true });
    }
  },
  TEST_TIMEOUT_MS,
);

function provider(baseUrl: string): LlmProvider {
  return {
    provider: "openai-compatible",
    model: "company-model",
    baseUrl,
    headers: {},
    timeoutMs: 5_000,
    maxRetries: 0,
    apiKeyEnv: API_KEY_ENV,
  };
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
      model: "company-model",
      baseUrl: "http://127.0.0.1",
      apiKeyEnv: API_KEY_ENV,
      timeoutMs: 5_000,
    },
    stagehand: {
      enabled: true,
      maxSteps: 1,
      recoveryEnabled: false,
      debugTools: false,
    },
    playwright: {
      browser: "chromium",
      headless: true,
      workers: 1,
      timeoutMs: LAUNCH_TIMEOUT_MS,
    },
    evidence: {
      screenshots: "checkpoints",
      network: false,
      console: false,
      trace: "off",
      maxResponseBodyBytes: 1024,
    },
    security: {
      redactHeaders: ["authorization", "cookie", "set-cookie"],
      destructiveActionsAllowed: false,
      maxRunDurationMs: 600_000,
    },
    auth: {
      workerProfiles: [],
    },
  };
}

function startLlm(
  onBody: (body: string) => void | Promise<void>,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      void (async () => {
        try {
          await onBody(Buffer.concat(chunks).toString("utf8"));
        } finally {
          if (!response.writableEnded) {
            response.writeHead(400, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: { message: "unavailable" } }));
          }
        }
      })();
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Could not bind the model fixture."));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}/v1`,
        close: () => closeServer(server),
      });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

type SessionDebugger = {
  pid: number;
  port: string;
  webSocketDebuggerUrl: string;
};

/**
 * The browser this discovery session attached. Identified by the page at
 * `targetUrl`, which is unique to this test's auth fixture.
 */
async function findDebuggerServing(
  targetUrl: string,
): Promise<SessionDebugger | undefined> {
  for (const entry of debuggerProcesses()) {
    try {
      const list = await fetch(`http://127.0.0.1:${entry.port}/json/list`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (!list.ok) {
        continue;
      }
      const targets = (await list.json()) as Array<{ url?: string }>;
      if (!targets.some((target) => target.url === targetUrl)) {
        continue;
      }
      const version = await fetch(`http://127.0.0.1:${entry.port}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (!version.ok) {
        continue;
      }
      const body = (await version.json()) as { webSocketDebuggerUrl?: string };
      if (typeof body.webSocketDebuggerUrl !== "string") {
        continue;
      }
      return {
        pid: entry.pid,
        port: entry.port,
        webSocketDebuggerUrl: body.webSocketDebuggerUrl,
      };
    } catch {
      // A browser from another file can exit while this probe is in flight.
    }
  }
  return undefined;
}

/** This session's process and debugger endpoint are gone. */
async function sessionDebuggerGone(session: SessionDebugger): Promise<boolean> {
  if (processExists(session.pid)) {
    return false;
  }
  try {
    const version = await fetch(`http://127.0.0.1:${session.port}/json/version`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (!version.ok) {
      return true;
    }
    const body = (await version.json()) as { webSocketDebuggerUrl?: string };
    return body.webSocketDebuggerUrl !== session.webSocketDebuggerUrl;
  } catch {
    return true;
  }
}

function debuggerProcesses(): Array<{ pid: number; port: string }> {
  let output = "";
  try {
    output = execFileSync("ps", ["-A", "-o", "pid=,command="], {
      encoding: "utf8",
    });
  } catch {
    return [];
  }
  const found: Array<{ pid: number; port: string }> = [];
  for (const line of output.split("\n")) {
    if (!line.includes("chrome")) {
      continue;
    }
    const match = /--remote-debugging-port=(\d+)/.exec(line);
    const port = match?.[1];
    const pidText = line.trim().split(/\s+/, 1)[0];
    if (port === undefined || pidText === undefined) {
      continue;
    }
    const pid = Number(pidText);
    if (!Number.isInteger(pid)) {
      continue;
    }
    found.push({ pid, port });
  }
  return found;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
    return code === "EPERM";
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function rejected(work: Promise<unknown>): Promise<QaError> {
  try {
    await work;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(QaError);
    if (error instanceof QaError) {
      return error;
    }
  }
  throw new Error("expected a QaError");
}
