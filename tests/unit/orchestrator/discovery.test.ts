import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { saveProfile } from "../../../src/auth/store.js";
import type { ProjectConfig } from "../../../src/config/schema.js";
import { QaError } from "../../../src/errors/qa-error.js";
import { transition } from "../../../src/flows/state.js";
import { validateFlow } from "../../../src/flows/validator.js";
import { discoverFlow } from "../../../src/orchestrator/discovery.js";
import { startBrowser } from "../../../src/playwright/runtime.js";
import * as hosts from "../../../src/security/hosts.js";
import type { LlmProvider } from "../../../src/stagehand/provider.js";
import { discover } from "../../../src/stagehand/session.js";
import type { DiscoveryTrajectory } from "../../../src/stagehand/trajectory.js";

vi.mock("../../../src/stagehand/session.js", () => ({
  discover: vi.fn(),
}));

vi.mock("../../../src/playwright/runtime.js", () => ({
  startBrowser: vi.fn(),
}));

vi.mock("../../../src/flows/validator.js", () => ({
  validateFlow: vi.fn(),
}));

const START_URL = "http://127.0.0.1:9/start";
const OTHER_URL = "http://127.0.0.1:9/other";
const FLOW_ID = "page.save";
const realAssertUrlAllowed = hosts.assertUrlAllowed;

const provider: LlmProvider = {
  provider: "openai-compatible",
  model: "test-model",
  baseUrl: "https://llm.example/v1",
  headers: {},
  timeoutMs: 1_000,
  maxRetries: 0,
  apiKeyEnv: "QA_AGENT_REPLAY_START_URL_KEY",
};

const roots: string[] = [];
let projectRoot = "";
let events: string[] = [];
let pageGoto: ReturnType<typeof vi.fn>;
let page: { goto: ReturnType<typeof vi.fn> };

beforeEach(() => {
  events = [];
  projectRoot = mkdtempSync(join(tmpdir(), "aqa-replay-start-"));
  roots.push(projectRoot);
  pageGoto = vi.fn(async (url: string) => {
    events.push(`goto:${url}`);
    return null;
  });
  page = { goto: pageGoto };
  vi.mocked(discover).mockReset();
  vi.mocked(startBrowser).mockReset();
  vi.mocked(validateFlow).mockReset();
  vi.mocked(startBrowser).mockResolvedValue({
    page,
    close: async () => undefined,
  } as Awaited<ReturnType<typeof startBrowser>>);
  vi.mocked(validateFlow).mockImplementation(async (input) => {
    events.push("validate");
    return { ok: true, flow: transition(input.flow, "validate") };
  });
  vi.spyOn(hosts, "assertUrlAllowed").mockImplementation((url, config) => {
    events.push(`allow:${url}`);
    realAssertUrlAllowed(url, config);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a successful trajectory is saved as validated without replaying clicks", async () => {
  vi.mocked(discover).mockResolvedValue(clickTrajectory());

  const discovered = await discoverFlow(input(START_URL));

  expect(events).toEqual([`allow:${START_URL}`]);
  expect(startBrowser).not.toHaveBeenCalled();
  expect(validateFlow).not.toHaveBeenCalled();
  expect(pageGoto).not.toHaveBeenCalled();
  expect(discovered.flow.state).toBe("validated");
  expect(discovered.result.status).toBe("passed");
  expect(discovered.flow.steps[0]).toMatchObject({ action: "click" });
});

test("an omitted startUrl is the base URL and does not replay", async () => {
  vi.mocked(discover).mockResolvedValue(clickTrajectory());

  const discovered = await discoverFlow({
    ...input(START_URL),
    startUrl: undefined,
  });

  expect(vi.mocked(discover).mock.calls[0]?.[0]).toMatchObject({
    startUrl: START_URL,
  });
  expect(startBrowser).not.toHaveBeenCalled();
  expect(validateFlow).not.toHaveBeenCalled();
  expect(pageGoto).not.toHaveBeenCalled();
  expect(discovered.flow.state).toBe("validated");
});

test("a relative compiled goto is allowlisted against the base URL", async () => {
  vi.mocked(discover).mockResolvedValue(gotoTrajectory("/other"));

  const discovered = await discoverFlow(input(START_URL));

  expect(events).toEqual([`allow:${START_URL}`, `allow:${OTHER_URL}`]);
  expect(startBrowser).not.toHaveBeenCalled();
  expect(validateFlow).not.toHaveBeenCalled();
  expect(discovered.flow.state).toBe("validated");
  expect(discovered.flow.steps[0]).toMatchObject({
    action: "goto",
    value: "/other",
  });
});

test("an unallowlisted compiled goto never launches a browser", async () => {
  vi.mocked(discover).mockResolvedValue(clickThenGoto("//evil.test/secret"));

  const pending = discoverFlow(input(START_URL));

  await expect(pending).rejects.toBeInstanceOf(QaError);
  await expect(pending).rejects.toMatchObject({ code: "POLICY_BLOCKED" });
  expect(discover).toHaveBeenCalledTimes(1);
  expect(startBrowser).not.toHaveBeenCalled();
  expect(pageGoto).not.toHaveBeenCalled();
  expect(validateFlow).not.toHaveBeenCalled();
  expect(events).toEqual([
    `allow:${START_URL}`,
    "allow:http://evil.test/secret",
  ]);
});

test("authProfile storage state is passed to discovery and not replayed", async () => {
  const previousHome = process.env.AUTONOMOUS_QA_HOME;
  const home = mkdtempSync(join(tmpdir(), "aqa-discover-auth-"));
  process.env.AUTONOMOUS_QA_HOME = home;
  try {
    const saved = saveProfile(
      "demo-app",
      "owner",
      {
        cookies: [
          {
            name: "session",
            value: "profile-marker",
            domain: "127.0.0.1",
            path: "/",
            expires: -1,
            httpOnly: true,
            secure: false,
            sameSite: "Lax",
          },
        ],
        origins: [],
      },
      { projectRoot },
    );
    vi.mocked(discover).mockResolvedValue(clickTrajectory());

    await discoverFlow({
      ...input(START_URL),
      authProfile: "owner",
    });

    expect(vi.mocked(discover).mock.calls[0]?.[0]).toMatchObject({
      storageState: saved.path,
    });
    expect(startBrowser).not.toHaveBeenCalled();
    expect(validateFlow).not.toHaveBeenCalled();
  } finally {
    if (previousHome === undefined) {
      delete process.env.AUTONOMOUS_QA_HOME;
    } else {
      process.env.AUTONOMOUS_QA_HOME = previousHome;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("a disallowed start URL never starts discovery", async () => {
  vi.mocked(discover).mockResolvedValue(clickTrajectory());

  const pending = discoverFlow(input("https://evil.test/secret"));

  await expect(pending).rejects.toBeInstanceOf(QaError);
  await expect(pending).rejects.toMatchObject({ code: "POLICY_BLOCKED" });
  expect(discover).not.toHaveBeenCalled();
  expect(startBrowser).not.toHaveBeenCalled();
  expect(pageGoto).not.toHaveBeenCalled();
  expect(validateFlow).not.toHaveBeenCalled();
});

function input(startUrl: string) {
  return {
    id: FLOW_ID,
    name: "Save the page",
    objective: "Click Save",
    startUrl,
    projectRoot,
    config: projectConfig(START_URL),
    provider,
    client: { run: vi.fn() },
  };
}

function clickTrajectory(): DiscoveryTrajectory {
  return trajectory([
    {
      index: 0,
      kind: "click",
      method: "click",
      action: "Click Save",
      instruction: "Click Save",
      selector: 'role=button[name="Save"]',
      urlBefore: START_URL,
      urlAfter: START_URL,
      arguments: [],
    },
  ]);
}

function gotoTrajectory(url: string): DiscoveryTrajectory {
  return trajectory([
    {
      index: 0,
      kind: "goto",
      method: "goto",
      action: "Open the page",
      instruction: "Open the page",
      selector: "",
      urlBefore: "about:blank",
      urlAfter: url,
      arguments: { url },
    },
    {
      index: 1,
      kind: "click",
      method: "click",
      action: "Click Save",
      instruction: "Click Save",
      selector: 'role=button[name="Save"]',
      urlBefore: url,
      urlAfter: url,
      arguments: [],
    },
  ]);
}

function clickThenGoto(url: string): DiscoveryTrajectory {
  const click = clickTrajectory();
  return trajectory([
    ...click.actions,
    {
      index: 1,
      kind: "goto",
      method: "goto",
      action: "Open the next page",
      instruction: "Open the next page",
      selector: "",
      urlBefore: START_URL,
      urlAfter: url,
      arguments: { url },
    },
  ]);
}

function trajectory(
  actions: DiscoveryTrajectory["actions"],
): DiscoveryTrajectory {
  return {
    success: true,
    startedAt: "2026-09-28T00:00:00.000Z",
    endedAt: "2026-09-28T00:00:01.000Z",
    actions,
  };
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
      apiKeyEnv: "QA_AGENT_REPLAY_START_URL_KEY",
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
      timeoutMs: 3_000,
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
