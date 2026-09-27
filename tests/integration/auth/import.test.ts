import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { importStorageState, scriptedLogin } from "../../../src/auth/import.js";
import { readProfile } from "../../../src/auth/store.js";
import type { ProjectConfig } from "../../../src/config/schema.js";
import { QaError } from "../../../src/errors/qa-error.js";
import type { Locator } from "../../../src/flows/schema.js";
import type { StartBrowserOptions } from "../../../src/playwright/runtime.js";
import * as browserRuntime from "../../../src/playwright/runtime.js";
import { authDir } from "../../../src/runtime/paths.js";

const PASSWORD = "scripted-login-password";
const SESSION_COOKIE = "session-ok";
const USERNAME_ENV = "QA_IMPORT_USERNAME";
const PASSWORD_ENV = "QA_IMPORT_PASSWORD";
const LAUNCH_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 60_000;

const LOGIN_FORM_HTML = `<!DOCTYPE html>
<html>
  <body>
    <form id="login">
      <label>
        Username
        <input id="username" name="username" />
      </label>
      <label>
        Password
        <input id="password" name="password" type="password" />
      </label>
      <button id="submit" type="button">Sign in</button>
    </form>
    <script>
      document.querySelector("#submit").addEventListener("click", () => {
        const username = document.querySelector("#username").value;
        const password = document.querySelector("#password").value;
        if (username.length > 0 && password.length > 0) {
          document.cookie = "session=session-ok; path=/; SameSite=Lax";
        }
      });
    </script>
  </body>
</html>`;

const USERNAME_LOCATOR: Locator = { type: "css", selector: "#username" };
const PASSWORD_LOCATOR: Locator = { type: "css", selector: "#password" };
const SUBMIT_LOCATOR: Locator = { type: "css", selector: "#submit" };

const realStartBrowser = browserRuntime.startBrowser;

let home: string;
let previousHome: string | undefined;
let scratch: string;

beforeEach(() => {
  previousHome = process.env.AUTONOMOUS_QA_HOME;
  home = mkdtempSync(join(tmpdir(), "autonomous-qa-import-home-"));
  scratch = mkdtempSync(join(tmpdir(), "autonomous-qa-import-src-"));
  process.env.AUTONOMOUS_QA_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.AUTONOMOUS_QA_HOME;
  } else {
    process.env.AUTONOMOUS_QA_HOME = previousHome;
  }
  delete process.env[USERNAME_ENV];
  delete process.env[PASSWORD_ENV];
  rmSync(home, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
  vi.restoreAllMocks();
});

test("importing a storage-state file creates a profile with mode 0600", () => {
  const source = join(scratch, "storage-state.json");
  const document = sampleState();
  writeFileSync(source, `${JSON.stringify(document, null, 2)}\n`);

  const result = importStorageState({
    projectId: "billing",
    profile: "admin",
    filePath: source,
  });

  const savedPath = join(authDir("billing"), "admin.json");
  expect(result).toEqual({ profile: "admin", projectId: "billing" });
  expect(Object.keys(result).sort()).toEqual(["profile", "projectId"]);
  expect(fileMode(savedPath)).toBe(0o600);
  expect(existsSync(source)).toBe(true);
  expect(readFileSync(source, "utf8")).toBe(
    `${JSON.stringify(document, null, 2)}\n`,
  );
  expect(readProfile("billing", "admin")).toEqual(document);
});

test("malformed JSON throws AUTH_MISSING", () => {
  const source = join(scratch, "storage-state.json");
  writeFileSync(source, "{not json");

  try {
    importStorageState({
      projectId: "billing",
      profile: "admin",
      filePath: source,
    });
    expect.fail("expected AUTH_MISSING");
  } catch (error) {
    expect(error).toBeInstanceOf(QaError);
    if (error instanceof QaError) {
      expect(error.code).toBe("AUTH_MISSING");
      expect(error.message).toBe("storage state is unreadable");
    }
  }

  expect(existsSync(source)).toBe(true);
  expect(profileExists("billing", "admin")).toBe(false);
});

test("a missing storage-state file throws AUTH_MISSING", () => {
  const source = join(scratch, "missing.json");

  try {
    importStorageState({
      projectId: "billing",
      profile: "admin",
      filePath: source,
    });
    expect.fail("expected AUTH_MISSING");
  } catch (error) {
    expect(error).toBeInstanceOf(QaError);
    if (error instanceof QaError) {
      expect(error.code).toBe("AUTH_MISSING");
      expect(error.message).not.toBe("storage state is unreadable");
    }
  }

  expect(profileExists("billing", "admin")).toBe(false);
});

test("a source file inside the project flows directory is refused", () => {
  const project = mkdtempSync(join(tmpdir(), "autonomous-qa-import-project-"));
  const flows = join(project, ".autonomous-qa", "flows");
  mkdirSync(flows, { recursive: true });
  const source = join(flows, "admin.json");
  writeFileSync(source, `${JSON.stringify(sampleState())}\n`);
  const previousCwd = process.cwd();

  try {
    process.chdir(project);
    try {
      importStorageState({
        projectId: "billing",
        profile: "admin",
        filePath: source,
      });
      expect.fail("expected POLICY_BLOCKED");
    } catch (error) {
      expect(error).toBeInstanceOf(QaError);
      if (error instanceof QaError) {
        expect(error.code).toBe("POLICY_BLOCKED");
      }
    }
    expect(existsSync(source)).toBe(true);
    expect(profileExists("billing", "admin")).toBe(false);
  } finally {
    process.chdir(previousCwd);
    rmSync(project, { recursive: true, force: true });
  }
});

test(
  "scripted login stores the session cookie and writes no flow file",
  async () => {
    const stderr = vi.spyOn(process.stderr, "write");
    const stdout = vi.spyOn(process.stdout, "write");
    const flowsDirectory = join(process.cwd(), ".autonomous-qa", "flows");
    const flowsBefore = listFiles(flowsDirectory);
    const previousDebug = process.env.DEBUG;
    delete process.env.DEBUG;
    process.env[USERNAME_ENV] = "ada";
    process.env[PASSWORD_ENV] = PASSWORD;

    vi.spyOn(browserRuntime, "startBrowser").mockImplementation(
      async (options?: StartBrowserOptions) => {
        expect(options?.headless).toBe(true);
        const session = await realStartBrowser(options);
        await session.page.route(
          (url) => url.hostname === "localhost",
          async (route) => {
            await route.fulfill({
              status: 200,
              contentType: "text/html",
              body: LOGIN_FORM_HTML,
            });
          },
        );
        return session;
      },
    );

    try {
      const result = await scriptedLogin({
        projectId: "billing",
        profile: "worker",
        loginUrl: "http://localhost/login",
        usernameEnv: USERNAME_ENV,
        passwordEnv: PASSWORD_ENV,
        usernameLocator: USERNAME_LOCATOR,
        passwordLocator: PASSWORD_LOCATOR,
        submitLocator: SUBMIT_LOCATOR,
        config: projectConfig({
          allowedHosts: ["localhost"],
          productionAllowed: false,
        }),
      });

      const logged = [...stderr.mock.calls, ...stdout.mock.calls]
        .map((call) => call.map((chunk) => chunkText(chunk)).join(" "))
        .join("\n");
      const saved = readProfile("billing", "worker");
      const cookie = saved.cookies.find((entry) => entry.name === "session");

      expect(result).toEqual({ profile: "worker", projectId: "billing" });
      expect(Object.keys(result).sort()).toEqual(["profile", "projectId"]);
      expect(JSON.stringify(result)).not.toContain(PASSWORD);
      expect(cookie?.value).toBe(SESSION_COOKIE);
      expect(JSON.stringify(saved)).not.toContain(PASSWORD);
      expect(readFileSync(join(authDir("billing"), "worker.json"), "utf8")).not.toContain(
        PASSWORD,
      );
      expect(logged).not.toContain(PASSWORD);
      expect(listFiles(flowsDirectory)).toEqual(flowsBefore);
      expect(listFiles(home).some((file) => file.endsWith(".yml"))).toBe(false);
    } finally {
      restoreEnv("DEBUG", previousDebug);
    }
  },
  TEST_TIMEOUT_MS,
);

test("a missing credential throws AUTH_MISSING without printing the value", async () => {
  const stderr = vi.spyOn(process.stderr, "write");
  const before = browserPids();
  process.env[PASSWORD_ENV] = PASSWORD;
  delete process.env[USERNAME_ENV];

  try {
    await scriptedLogin({
      projectId: "billing",
      profile: "worker",
      loginUrl: "http://localhost/login",
      usernameEnv: USERNAME_ENV,
      passwordEnv: PASSWORD_ENV,
      usernameLocator: USERNAME_LOCATOR,
      passwordLocator: PASSWORD_LOCATOR,
      submitLocator: SUBMIT_LOCATOR,
    });
    expect.fail("expected AUTH_MISSING");
  } catch (error) {
    expect(error).toBeInstanceOf(QaError);
    if (error instanceof QaError) {
      expect(error.code).toBe("AUTH_MISSING");
      expect(error.message).not.toContain(PASSWORD);
      expect(JSON.stringify(error.toJSON())).not.toContain(PASSWORD);
    }
  }

  const logged = stderr.mock.calls
    .map((call) => call.map((chunk) => chunkText(chunk)).join(" "))
    .join("\n");
  expect(logged).not.toContain(PASSWORD);
  expect(extraPids(before)).toEqual([]);
  expect(profileExists("billing", "worker")).toBe(false);
});

test("a disallowed loginUrl throws POLICY_BLOCKED before launch", async () => {
  const before = browserPids();
  process.env[USERNAME_ENV] = "ada";
  process.env[PASSWORD_ENV] = PASSWORD;

  const pending = scriptedLogin({
    projectId: "billing",
    profile: "worker",
    loginUrl: "https://evil.example/login",
    usernameEnv: USERNAME_ENV,
    passwordEnv: PASSWORD_ENV,
    usernameLocator: USERNAME_LOCATOR,
    passwordLocator: PASSWORD_LOCATOR,
    submitLocator: SUBMIT_LOCATOR,
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
  expect(profileExists("billing", "worker")).toBe(false);
});

function sampleState() {
  return {
    cookies: [
      {
        name: "session",
        value: "imported-cookie-value",
        domain: "example.test",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: "Lax" as const,
      },
    ],
    origins: [
      {
        origin: "https://example.test",
        localStorage: [{ name: "theme", value: "light" }],
      },
    ],
  };
}

function fileMode(path: string): number {
  return statSync(path).mode & 0o777;
}

function profileExists(projectId: string, profile: string): boolean {
  return existsSync(join(authDir(projectId), `${profile}.json`));
}

function listFiles(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      files.push(full);
    }
  };
  walk(directory);
  files.sort();
  return files;
}

function chunkText(chunk: unknown): string {
  if (typeof chunk === "string") {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk).toString("utf8");
  }
  return String(chunk);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
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
