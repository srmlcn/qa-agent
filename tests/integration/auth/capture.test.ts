import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { captureProfile, finish } from "../../../src/auth/capture.js";
import { readProfile } from "../../../src/auth/store.js";
import type { ProjectConfig } from "../../../src/config/schema.js";
import { QaError } from "../../../src/errors/qa-error.js";
import { authDir } from "../../../src/runtime/paths.js";
import { startBrowser } from "../../../src/playwright/runtime.js";

const COOKIE_NAME = "session";
const COOKIE_VALUE = "capture-secret-cookie-value";
const LAUNCH_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 60_000;

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.AUTONOMOUS_QA_HOME;
  home = mkdtempSync(join(tmpdir(), "autonomous-qa-capture-"));
  process.env.AUTONOMOUS_QA_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.AUTONOMOUS_QA_HOME;
  } else {
    process.env.AUTONOMOUS_QA_HOME = previousHome;
  }
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

test(
  "finish saves the cookie name and keeps the value out of the result and logs",
  async () => {
    const stdout = vi.spyOn(process.stdout, "write");
    const stderr = vi.spyOn(process.stderr, "write");
    const log = vi.spyOn(console, "log");
    const info = vi.spyOn(console, "info");
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");

    const ready = join(authDir("billing"), "admin.ready");
    mkdirSync(dirname(ready), { recursive: true });
    writeFileSync(ready, "");

    const session = await startBrowser({
      headless: true,
      timeoutMs: LAUNCH_TIMEOUT_MS,
    });
    try {
      await session.context.addCookies([
        {
          name: COOKIE_NAME,
          value: COOKIE_VALUE,
          url: "https://example.test/",
        },
      ]);

      const result = await finish(session.context, {
        projectId: "billing",
        profile: "admin",
      });

      const logged = [
        ...stdout.mock.calls,
        ...stderr.mock.calls,
        ...log.mock.calls,
        ...info.mock.calls,
        ...warn.mock.calls,
        ...error.mock.calls,
      ]
        .map((call) => call.map(String).join(" "))
        .join("\n");

      expect(result).toEqual({ profile: "admin", projectId: "billing" });
      expect(JSON.stringify(result)).not.toContain(COOKIE_VALUE);
      expect(logged).not.toContain(COOKIE_VALUE);
      expect(logged).toContain("captured auth profile admin for project billing");
    } finally {
      await session.close();
    }

    const saved = readProfile("billing", "admin");
    const cookie = saved.cookies.find((entry) => entry.name === COOKIE_NAME);
    expect(cookie?.name).toBe(COOKIE_NAME);
    expect(cookie?.value).toBe(COOKIE_VALUE);
    expect(existsReady("billing", "admin")).toBe(false);
  },
  TEST_TIMEOUT_MS,
);

test(
  "abort writes no profile file",
  async () => {
    const controller = new AbortController();
    const before = browserPids();
    const pending = captureProfile({
      projectId: "billing",
      profile: "admin",
      startUrl: "about:blank",
      signal: controller.signal,
    });

    await expect
      .poll(() => extraPids(before).length, { timeout: 20_000 })
      .toBeGreaterThan(0);
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(QaError);
    await expect(pending).rejects.toMatchObject({ code: "RUN_CANCELLED" });
    expect(profileExists("billing", "admin")).toBe(false);
    await expect.poll(() => extraPids(before), { timeout: 10_000 }).toEqual([]);
  },
  TEST_TIMEOUT_MS,
);

test("a disallowed startUrl throws POLICY_BLOCKED before launch", async () => {
  const before = browserPids();
  const pending = captureProfile({
    projectId: "billing",
    profile: "admin",
    startUrl: "https://evil.example/login",
    config: projectConfig({
      allowedHosts: ["localhost"],
      productionAllowed: false,
    }),
  });

  await expect(pending).rejects.toBeInstanceOf(QaError);
  await expect(pending).rejects.toMatchObject({
    code: "POLICY_BLOCKED",
    recoveryAppropriate: false,
  });
  expect(extraPids(before)).toEqual([]);
  expect(profileExists("billing", "admin")).toBe(false);
});

test(
  "a stdin line done completes capture",
  async () => {
    const pending = captureProfile({
      projectId: "billing",
      profile: "worker",
      startUrl: "about:blank",
    });
    const emitDone = setInterval(() => {
      process.stdin.emit("data", Buffer.from("done\n"));
    }, 50);

    try {
      const result = await pending;
      expect(result).toEqual({ profile: "worker", projectId: "billing" });
      expect(JSON.stringify(result)).not.toContain(COOKIE_VALUE);
      expect(profileExists("billing", "worker")).toBe(true);
    } finally {
      clearInterval(emitDone);
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "a ready file completes capture and is removed",
  async () => {
    const ready = join(authDir("billing"), "admin.ready");
    mkdirSync(dirname(ready), { recursive: true });
    writeFileSync(ready, "");
    const before = browserPids();

    const result = await captureProfile({
      projectId: "billing",
      profile: "admin",
      startUrl: "about:blank",
    });

    expect(result).toEqual({ profile: "admin", projectId: "billing" });
    expect(JSON.stringify(result)).not.toContain(COOKIE_VALUE);
    expect(existsReady("billing", "admin")).toBe(false);
    expect(readProfile("billing", "admin").cookies).toEqual([]);
    await expect.poll(() => extraPids(before), { timeout: 10_000 }).toEqual([]);
  },
  TEST_TIMEOUT_MS,
);

function existsReady(projectId: string, profile: string): boolean {
  return existsSync(join(authDir(projectId), `${profile}.ready`));
}

function profileExists(projectId: string, profile: string): boolean {
  return existsSync(join(authDir(projectId), `${profile}.json`));
}

function projectConfig(application: {
  allowedHosts: string[];
  productionAllowed: boolean;
}): ProjectConfig {
  return {
    version: 1,
    project: { id: "billing" },
    application: {
      baseUrl: "http://localhost:3000",
      allowedHosts: application.allowedHosts,
      productionAllowed: application.productionAllowed,
    },
    llm: {
      provider: "openai",
      model: "test-model",
      apiKeyEnv: "OPENAI_API_KEY",
      timeoutMs: 60000,
    },
    stagehand: {
      enabled: false,
      maxSteps: 30,
      recoveryEnabled: false,
    },
    playwright: {
      browser: "chromium",
      headless: true,
      workers: 1,
      timeoutMs: 30000,
    },
    evidence: {
      screenshots: "checkpoints",
      network: false,
      console: false,
      trace: "off",
      maxResponseBodyBytes: 1024,
    },
    security: {
      redactHeaders: ["authorization"],
      destructiveActionsAllowed: false,
      maxRunDurationMs: 600000,
    },
    auth: {
      workerProfiles: [],
    },
  };
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
