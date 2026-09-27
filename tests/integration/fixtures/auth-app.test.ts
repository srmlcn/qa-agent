import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
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
import { startBrowser } from "../../../src/playwright/runtime.js";

const LAUNCH_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 60_000;
const LOGIN_TIMEOUT_MS = 120_000;
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
  "anonymous /app redirects to the login form",
  async () => {
    const app = await start(0);
    const port = Number(new URL(app.url).port);
    try {
      const session = await startBrowser({
        headless: true,
        timeoutMs: LAUNCH_TIMEOUT_MS,
      });
      try {
        await session.page.goto(`${app.url}/app`);
        expect(new URL(session.page.url()).pathname).toBe("/");
        expect(
          await session.page
            .getByRole("button", { name: "Options for Alpha", exact: true })
            .count(),
        ).toBe(0);
        await session.page.getByLabel("Username").waitFor();
        await session.page.getByLabel("Password").waitFor();
        await session.page
          .getByRole("button", { name: "Sign in", exact: true })
          .waitFor();
      } finally {
        await session.close();
      }
    } finally {
      await app.close();
    }

    await expect.poll(() => portIsFree(port), { timeout: 5_000 }).toBe(true);
  },
  TEST_TIMEOUT_MS,
);

test(
  "scripted login reaches /app and the saved profile opens it again",
  async () => {
    const previousHome = process.env.AUTONOMOUS_QA_HOME;
    const previousUsername = process.env[USERNAME_ENV];
    const previousPassword = process.env[PASSWORD_ENV];
    const home = mkdtempSync(join(tmpdir(), "autonomous-qa-auth-app-"));
    process.env.AUTONOMOUS_QA_HOME = home;
    process.env[USERNAME_ENV] = USERNAME;
    process.env[PASSWORD_ENV] = PASSWORD;

    let app: AuthApp | undefined;
    try {
      app = await start(0);
      const port = Number(new URL(app.url).port);
      const imported = await scriptedLogin({
        projectId: PROJECT_ID,
        profile: PROFILE,
        loginUrl: app.url,
        usernameEnv: USERNAME_ENV,
        passwordEnv: PASSWORD_ENV,
        usernameLocator: USERNAME_LOCATOR,
        passwordLocator: PASSWORD_LOCATOR,
        submitLocator: SUBMIT_LOCATOR,
        config: projectConfig(),
      });
      expect(imported).toEqual({ profile: PROFILE, projectId: PROJECT_ID });

      const storageState = readProfilePath(PROJECT_ID, PROFILE);
      const stored = readFileSync(storageState, "utf8");
      expect(stored.includes(PASSWORD)).toBe(false);
      const cookies = cookieNames(stored);
      expect(cookies).toEqual(["qa_session"]);

      const session = await startBrowser({
        headless: true,
        timeoutMs: LAUNCH_TIMEOUT_MS,
        storageState,
      });
      const paths: string[] = [];
      session.page.on("request", (request) => {
        paths.push(new URL(request.url()).pathname);
      });
      try {
        await session.page.goto(`${app.url}/app`);
        expect(new URL(session.page.url()).hostname).toBe("127.0.0.1");
        expect(new URL(session.page.url()).pathname).toBe("/app");
        expect(paths.includes("/login")).toBe(false);
        expect(
          await session.page
            .getByRole("button", { name: "Sign in", exact: true })
            .count(),
        ).toBe(0);

        const options = session.page.getByRole("button", {
          name: "Options for Alpha",
          exact: true,
        });
        await options.waitFor();
        await options.click();
        const archive = session.page.getByRole("menuitem", {
          name: "Archive",
          exact: true,
        });
        await archive.waitFor();
        await archive.click();
        await session.page
          .getByRole("button", { name: "Archive project", exact: true })
          .waitFor();
      } finally {
        await session.close();
      }

      await app.close();
      app = undefined;
      await expect.poll(() => portIsFree(port), { timeout: 5_000 }).toBe(true);
    } finally {
      await app?.close();
      restoreEnv("AUTONOMOUS_QA_HOME", previousHome);
      restoreEnv(USERNAME_ENV, previousUsername);
      restoreEnv(PASSWORD_ENV, previousPassword);
      rmSync(home, { recursive: true, force: true });
    }
  },
  LOGIN_TIMEOUT_MS,
);

test("listens on 127.0.0.1 and close() frees the port", async () => {
  const source = readFileSync(
    new URL("../../../fixtures/auth-app/server.ts", import.meta.url),
    "utf8",
  );
  expect(
    [...source.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((match) => match[1]),
  ).toEqual(["node:http"]);
  expect(source).not.toContain("import(");
  expect(source).not.toContain("0.0.0.0");
  expect(source).not.toMatch(/\bfetch\s*\(/);
  expect(source).not.toContain("http.request");
  expect(source).not.toContain("https.request");
  expect(source.split(PASSWORD).length - 1).toBe(1);

  const testSource = readFileSync(new URL(import.meta.url), "utf8");
  expect(testSource.includes(PASSWORD)).toBe(false);

  const app = await start(0);
  const port = Number(new URL(app.url).port);
  try {
    expect(app.url).toBe(`http://127.0.0.1:${port}`);
    expect(listenAddresses(port)).toEqual(["127.0.0.1"]);
  } finally {
    await app.close();
  }

  await expect.poll(() => portIsFree(port), { timeout: 5_000 }).toBe(true);
  expect(listenAddresses(port)).toEqual([]);
});

function cookieNames(storageState: string): string[] {
  const parsed: unknown = JSON.parse(storageState);
  if (typeof parsed !== "object" || parsed === null || !("cookies" in parsed)) {
    return [];
  }
  const cookies = parsed.cookies;
  if (!Array.isArray(cookies)) {
    return [];
  }
  const names: string[] = [];
  for (const cookie of cookies) {
    if (
      typeof cookie === "object" &&
      cookie !== null &&
      "name" in cookie &&
      typeof cookie.name === "string"
    ) {
      names.push(cookie.name);
    }
  }
  return names;
}

function projectConfig(): ProjectConfig {
  return {
    version: 1,
    project: { id: PROJECT_ID },
    application: {
      baseUrl: "http://127.0.0.1",
      allowedHosts: ["127.0.0.1"],
      productionAllowed: false,
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
      redactHeaders: ["authorization"],
      destructiveActionsAllowed: false,
      maxRunDurationMs: 600000,
    },
    auth: {
      workerProfiles: [],
    },
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => {
      resolve(false);
    });
    probe.listen(port, "127.0.0.1", () => {
      probe.close(() => {
        resolve(true);
      });
    });
  });
}

function listenAddresses(port: number): string[] {
  const portHex = port.toString(16).padStart(4, "0");
  const addresses: string[] = [];
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const table = readFileSync(file, "utf8");
    for (const line of table.split("\n")) {
      const columns = line.trim().split(/\s+/);
      const local = columns[1];
      const state = columns[3];
      if (local === undefined || state !== "0A") {
        continue;
      }
      const separator = local.lastIndexOf(":");
      if (separator === -1) {
        continue;
      }
      if (local.slice(separator + 1).toLowerCase() !== portHex) {
        continue;
      }
      addresses.push(describeAddress(local.slice(0, separator).toLowerCase()));
    }
  }
  return addresses;
}

function describeAddress(hex: string): string {
  if (hex.length !== 8) {
    return hex;
  }
  const bytes = [0, 1, 2, 3].map((index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );
  if (bytes.some((byte) => Number.isNaN(byte))) {
    return hex;
  }
  const [first, second, third, fourth] = bytes;
  return `${fourth}.${third}.${second}.${first}`;
}
