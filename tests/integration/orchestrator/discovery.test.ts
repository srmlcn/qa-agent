import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { saveProfile, type StorageState } from "../../../src/auth/store.js";
import type { ProjectConfig } from "../../../src/config/schema.js";
import { readRun } from "../../../src/evidence/store.js";
import { QaError } from "../../../src/errors/qa-error.js";
import { read } from "../../../src/flows/repository.js";
import type { FlowSpec } from "../../../src/flows/schema.js";
import { discoverFlow } from "../../../src/orchestrator/discovery.js";
import { getRun } from "../../../src/orchestrator/runs.js";
import { createFakeClient, type FakeScript } from "../../../src/stagehand/fake-client.js";
import type { LlmProvider } from "../../../src/stagehand/provider.js";
import type { DiscoverySessionClient } from "../../../src/stagehand/session.js";

const TEST_TIMEOUT_MS = 60_000;
const ACTION_TIMEOUT_MS = 3_000;
const COOKIE_VALUE = "discovery-cookie-secret";
const FLOW_ID = "page.save";

const PAGE_HTML = `<!DOCTYPE html>
<html>
  <body>
    <button type="button" id="save">Save</button>
    <p id="status">Idle</p>
  </body>
</html>`;

const provider: LlmProvider = {
  provider: "openai-compatible",
  model: "test-model",
  baseUrl: "https://llm.example/v1",
  headers: {},
  timeoutMs: 1_000,
  maxRetries: 0,
  apiKeyEnv: "QA_AGENT_DISCOVERY_PIPELINE_KEY",
};

let pageUrl = "";
let closePage: (() => Promise<void>) | undefined;
let projectRoot = "";
let previousHome: string | undefined;
const scratchDirs: string[] = [];

beforeAll(async () => {
  const page = await startPage(PAGE_HTML);
  pageUrl = page.url;
  closePage = page.close;
});

afterAll(async () => {
  await closePage?.();
});

beforeEach(() => {
  previousHome = process.env.AUTONOMOUS_QA_HOME;
  const scratch = mkdtempSync(join(tmpdir(), "aqa-discover-"));
  scratchDirs.push(scratch);
  projectRoot = join(scratch, "project");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(join(scratch, "home"), { recursive: true });
  process.env.AUTONOMOUS_QA_HOME = join(scratch, "home");
});

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.AUTONOMOUS_QA_HOME;
  } else {
    process.env.AUTONOMOUS_QA_HOME = previousHome;
  }
  for (const scratch of scratchDirs.splice(0)) {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test(
  "a fake client and a local page save a validated flow without the cookie",
  async () => {
    saveOwnerProfile();
    const { client, run } = scriptedClient(pageScript(pageUrl, "Save", "Click Save"));

    const discovered = await discoverFlow({
      id: FLOW_ID,
      name: "Save the page",
      objective: "Ignore delete and click Save",
      startUrl: pageUrl,
      authProfile: "owner",
      projectRoot,
      config: projectConfig(pageUrl),
      provider,
      client,
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(discovered.flow.state).toBe("validated");
    expect(discovered.result.status).toBe("passed");
    expect(discovered.result.failure).toBeUndefined();
    const saved = read(projectRoot, FLOW_ID);
    expect(saved).toEqual(discovered.flow);
    expect(saved.state).toBe("validated");
    expect(saved.authProfile).toBe("owner");
    const yaml = readFileSync(flowYamlPath(FLOW_ID), "utf8");
    expect(yaml).not.toContain(COOKIE_VALUE);
    expect(JSON.stringify(saved)).not.toContain(COOKIE_VALUE);
    expect(JSON.stringify(discovered.result)).not.toContain(COOKIE_VALUE);
    expect(getRun(discovered.runId).status).toBe("passed");
    expect(readRun(projectRoot, discovered.runId).status).toBe("passed");
  },
  TEST_TIMEOUT_MS,
);

test(
  "a missed locator leaves the flow draft and fails the run",
  async () => {
    const { client } = scriptedClient(
      pageScript(pageUrl, "Missing", "Click the missing button"),
    );

    const discovered = await discoverFlow({
      id: "page.missing",
      name: "Click a missing control",
      objective: "Click a control that is not on the page",
      startUrl: pageUrl,
      projectRoot,
      config: projectConfig(pageUrl),
      provider,
      client,
    });

    expect(discovered.flow.state).toBe("draft");
    expect(discovered.result.failure).toBeDefined();
    expect(["failed", "error"]).toContain(discovered.result.status);
    expect(["failed", "error"]).toContain(getRun(discovered.runId).status);
    expect(["failed", "error"]).toContain(readRun(projectRoot, discovered.runId).status);
    const saved = read(projectRoot, "page.missing");
    expect(saved.state).toBe("draft");
    expect(saved.state).not.toBe("validated");
  },
  TEST_TIMEOUT_MS,
);

test("a disallowed host does not call the fake client", async () => {
  const { client, run } = scriptedClient(pageScript(pageUrl, "Save", "Click Save"));

  const pending = discoverFlow({
    id: FLOW_ID,
    name: "Save the page",
    objective: "Click Save",
    startUrl: "https://evil.test/secret",
    projectRoot,
    config: projectConfig(pageUrl),
    provider,
    client,
  });

  await expect(pending).rejects.toBeInstanceOf(QaError);
  await expect(pending).rejects.toMatchObject({ code: "POLICY_BLOCKED" });
  expect(run).not.toHaveBeenCalled();
  expect(savedState(FLOW_ID)).toBeUndefined();
});

test("a missing auth profile throws AUTH_MISSING and does not call the client", async () => {
  const { client, run } = scriptedClient(pageScript(pageUrl, "Save", "Click Save"));

  const pending = discoverFlow({
    id: FLOW_ID,
    name: "Save the page",
    objective: "Click Save",
    startUrl: pageUrl,
    authProfile: "missing-owner",
    projectRoot,
    config: projectConfig(pageUrl),
    provider,
    client,
  });

  await expect(pending).rejects.toBeInstanceOf(QaError);
  await expect(pending).rejects.toMatchObject({ code: "AUTH_MISSING" });
  expect(run).not.toHaveBeenCalled();
  expect(savedState(FLOW_ID)).toBeUndefined();
});

test("a destructive compiled step throws POLICY_BLOCKED and does not save validated", async () => {
  const { client, run } = scriptedClient(
    pageScript(pageUrl, "Save", "Archive the record"),
  );

  const pending = discoverFlow({
    id: "page.archive",
    name: "Update the record",
    objective: "Update the record status",
    startUrl: pageUrl,
    projectRoot,
    config: projectConfig(pageUrl),
    provider,
    client,
  });

  await expect(pending).rejects.toBeInstanceOf(QaError);
  await expect(pending).rejects.toMatchObject({ code: "POLICY_BLOCKED" });
  expect(run).toHaveBeenCalledTimes(1);
  expect(savedState("page.archive")).not.toBe("validated");
});

test("discovery does not import the stagehand package", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../../../src/orchestrator/discovery.ts", import.meta.url)),
    "utf8",
  );
  expect(source).not.toContain("@browserbasehq/stagehand");
  expect(source).toContain("discover(");
});

function scriptedClient(script: FakeScript): {
  client: DiscoverySessionClient;
  run: ReturnType<typeof vi.fn>;
} {
  const fake = createFakeClient(script);
  const run = vi.fn((objective: string) => fake.run(objective));
  return { client: { run }, run };
}

function pageScript(url: string, buttonName: string, description: string): FakeScript {
  return [
    {
      method: "goto",
      selector: "",
      description: "Open the start page",
      arguments: { url },
    },
    {
      method: "click",
      selector: `role=button[name="${buttonName}"]`,
      description,
      arguments: [],
    },
  ];
}

function saveOwnerProfile(): void {
  saveProfile("demo-app", "owner", storageState(), { projectRoot });
}

function storageState(): StorageState {
  return {
    cookies: [
      {
        name: "session",
        value: COOKIE_VALUE,
        domain: "127.0.0.1",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: "Lax",
      },
    ],
    origins: [],
  };
}

function savedState(id: string): FlowSpec["state"] | undefined {
  if (!existsSync(flowYamlPath(id))) {
    return undefined;
  }
  return read(projectRoot, id).state;
}

function flowYamlPath(id: string): string {
  return join(
    projectRoot,
    ".autonomous-qa",
    "flows",
    `${id.replaceAll(".", "--")}.yml`,
  );
}

function projectConfig(baseUrl: string): ProjectConfig {
  return {
    version: 1,
    project: { id: "demo-app" },
    application: {
      baseUrl,
      allowedHosts: ["127.0.0.1"],
      productionAllowed: false,
    },
    llm: {
      provider: "openai-compatible",
      model: "test-model",
      baseUrl: "https://llm.example/v1",
      apiKeyEnv: "QA_AGENT_DISCOVERY_PIPELINE_KEY",
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
      workers: 1,
      timeoutMs: ACTION_TIMEOUT_MS,
    },
    evidence: {
      screenshots: "checkpoints",
      network: false,
      console: false,
      trace: "off",
      maxResponseBodyBytes: 4096,
    },
    security: {
      redactHeaders: ["authorization", "cookie", "set-cookie"],
      destructiveActionsAllowed: false,
      maxRunDurationMs: 600_000,
    },
    auth: { workerProfiles: [] },
  };
}

function startPage(html: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(html);
  });
  return new Promise((resolve, reject) => {
    const fail = (error: Error): void => {
      reject(error);
    };
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", fail);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Could not bind the inline page."));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}/`,
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
