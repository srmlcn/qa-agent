import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { loadEffectiveConfig } from "../../../src/config/effective.js";
import { projectConfigPath } from "../../../src/config/load-project.js";
import { QaError } from "../../../src/errors/qa-error.js";
import { homeDir } from "../../../src/runtime/paths.js";

const PROJECT_MODEL = "project-model";
const USER_MODEL = "user-model";

const FULL_PROJECT = `
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
  model: ${PROJECT_MODEL}
  baseUrl: https://llm.company.internal/v1
  apiKeyEnv: COMPANY_LLM_API_KEY
  timeoutMs: 60000
  headers:
    X-Project: project

stagehand:
  enabled: true
  maxSteps: 30
  recoveryEnabled: true

playwright:
  browser: chromium
  headless: true
  workers: 4
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
    - cookie
    - set-cookie
  destructiveActionsAllowed: false
`;

const USER_LLM = {
  provider: "openai",
  model: USER_MODEL,
  baseUrl: "https://user.example/v1",
  apiKeyEnv: "USER_LLM_API_KEY",
  timeoutMs: 1000,
  headers: { "X-User": "user" },
};

const homes: string[] = [];
const roots: string[] = [];
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.AUTONOMOUS_QA_HOME;
  const home = mkdtempSync(join(tmpdir(), "autonomous-qa-home-"));
  homes.push(home);
  process.env.AUTONOMOUS_QA_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.AUTONOMOUS_QA_HOME;
  } else {
    process.env.AUTONOMOUS_QA_HOME = previousHome;
  }
  for (const path of homes.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
  for (const path of roots.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

test("user llm fields override project llm fields", () => {
  writeUserConfig({ llm: USER_LLM });
  const result = loadEffectiveConfig(writeProjectConfig(FULL_PROJECT));

  expect(result.config.llm).toEqual({
    provider: "openai",
    model: USER_MODEL,
    baseUrl: "https://user.example/v1",
    apiKeyEnv: "USER_LLM_API_KEY",
    timeoutMs: 1000,
    headers: { "X-User": "user" },
  });
  expect(result.config.application.baseUrl).toBe("http://localhost:3000");
  expect(result.config.auth.workerProfiles).toEqual([]);
  expect(result.warnings).toEqual([]);
});

test("an omitted project model falls back to the user model", () => {
  writeUserConfig({
    llm: {
      provider: "openai",
      model: USER_MODEL,
    },
  });
  const yaml = FULL_PROJECT.replace(`  model: ${PROJECT_MODEL}\n`, "");
  const result = loadEffectiveConfig(writeProjectConfig(yaml));

  expect(result.config.llm.model).toBe(USER_MODEL);
  expect(result.config.llm.provider).toBe("openai");
  expect(result.config.llm.apiKeyEnv).toBe("COMPANY_LLM_API_KEY");
});

test("user productionAllowed true does not change a project false", () => {
  const secret = "user-safety-secret-should-not-apply";
  writeUserConfig({
    application: {
      baseUrl: "https://user.example",
      productionAllowed: true,
      allowedHosts: ["evil.example"],
    },
    security: {
      destructiveActionsAllowed: true,
      note: secret,
    },
    llm: USER_LLM,
  });
  const result = loadEffectiveConfig(writeProjectConfig(FULL_PROJECT));

  expect(result.config.application.productionAllowed).toBe(false);
  expect(result.config.application.allowedHosts).toEqual(["localhost"]);
  expect(result.config.application.baseUrl).toBe("http://localhost:3000");
  expect(result.config.security.destructiveActionsAllowed).toBe(false);
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.stringify(result)).not.toContain("evil.example");
});

test("a warning entry names the ignored field", () => {
  writeUserConfig({
    application: {
      productionAllowed: true,
      allowedHosts: ["evil.example"],
    },
    security: {
      destructiveActionsAllowed: true,
    },
  });
  const result = loadEffectiveConfig(writeProjectConfig(FULL_PROJECT));

  expect(result.warnings).toEqual([
    "Ignored user config field application.allowedHosts",
    "Ignored user config field application.productionAllowed",
    "Ignored user config field security",
  ]);
});

test("an explicit baseUrl override beats the project baseUrl", () => {
  writeUserConfig({
    llm: USER_LLM,
    application: { baseUrl: "https://user.example" },
  });
  const result = loadEffectiveConfig(writeProjectConfig(FULL_PROJECT), {
    application: { baseUrl: "http://127.0.0.1:3999" },
  });

  expect(result.config.application.baseUrl).toBe("http://127.0.0.1:3999");
  expect(result.config.application.productionAllowed).toBe(false);
  expect(result.config.llm.model).toBe(USER_MODEL);
});

test("an omitted project header map falls back to the user headers", () => {
  writeUserConfig({
    llm: {
      headers: { "X-User": "user" },
    },
  });
  const yaml = FULL_PROJECT.replace("  headers:\n    X-Project: project\n", "");
  const result = loadEffectiveConfig(writeProjectConfig(yaml));

  expect(result.config.llm.headers).toEqual({ "X-User": "user" });
  expect(result.config.llm.model).toBe(PROJECT_MODEL);
});

test("a missing user config still loads the project", () => {
  const result = loadEffectiveConfig(writeProjectConfig(FULL_PROJECT));

  expect(homeDir()).toBe(process.env.AUTONOMOUS_QA_HOME);
  expect(result.config.llm.model).toBe(PROJECT_MODEL);
  expect(result.warnings).toEqual([]);
});

test("the effective config does not contain an API key value", () => {
  const secret = "user-config-key-9f3c2a-do-not-load";
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = secret;
  writeUserConfig({
    llm: {
      model: USER_MODEL,
      apiKey: secret,
      apiKeyEnv: "OPENAI_API_KEY",
    },
    apiKey: secret,
  });

  try {
    const result = loadEffectiveConfig(writeProjectConfig(FULL_PROJECT));
    const serialized = JSON.stringify(result);

    expect(result.config.llm.apiKeyEnv).toBe("OPENAI_API_KEY");
    expect(result.config.llm).not.toHaveProperty("apiKey");
    expect(serialized).not.toContain(secret);
    expect(result.warnings).toEqual([
      "Ignored user config field apiKey",
      "Ignored user config field llm.apiKey",
    ]);
  } finally {
    restoreEnv("OPENAI_API_KEY", previous);
  }
});

test("an unknown user provider fails as POLICY_BLOCKED and does not echo the value", () => {
  const secret = "anthropic-secret-vendor";
  writeUserConfig({ llm: { provider: secret } });
  const error = expectPolicyBlocked(() =>
    loadEffectiveConfig(writeProjectConfig(FULL_PROJECT)),
  );

  expect(error.message).toContain("llm.provider");
  expect(error.message).toContain("config.json");
  expect(error.message).not.toContain(secret);
  expect(JSON.stringify(error.toJSON())).not.toContain(secret);
});

test("a merged project error names the project file", () => {
  writeUserConfig({ llm: { timeoutMs: 1500 } });
  const yaml = FULL_PROJECT.replace(`  model: ${PROJECT_MODEL}\n`, "").replace(
    "  timeoutMs: 60000\n",
    "",
  );
  const root = writeProjectConfig(yaml);
  const error = expectPolicyBlocked(() => loadEffectiveConfig(root));

  expect(error.message).toContain(projectConfigPath(root));
  expect(error.message).toContain("llm.model");
  expect(error.message).not.toContain("qa-effective-");
});

test("a project file without llm uses a complete user llm", () => {
  writeUserConfig({ llm: USER_LLM });
  const yaml = `
version: 1
project:
  id: demo-app
application:
  baseUrl: http://localhost:3000
  allowedHosts:
    - localhost
  productionAllowed: false
stagehand:
  enabled: true
  maxSteps: 30
  recoveryEnabled: true
playwright:
  browser: chromium
  headless: true
  workers: 4
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
    - cookie
    - set-cookie
  destructiveActionsAllowed: false
`;
  const result = loadEffectiveConfig(writeProjectConfig(yaml));

  expect(result.config.llm).toEqual({
    provider: "openai",
    model: USER_MODEL,
    baseUrl: "https://user.example/v1",
    apiKeyEnv: "USER_LLM_API_KEY",
    timeoutMs: 1000,
    headers: { "X-User": "user" },
  });
  expect(result.config.project.id).toBe("demo-app");
  expect(result.config.application.allowedHosts).toEqual(["localhost"]);
});

test("a missing project config is POLICY_BLOCKED", () => {
  writeUserConfig({ llm: { model: USER_MODEL } });
  const root = createProjectRoot();
  const error = expectPolicyBlocked(() => loadEffectiveConfig(root));

  expect(error.message).toContain(".autonomous-qa/config.yml");
  expect(error.message).toContain("Missing");
});

function writeUserConfig(value: unknown): void {
  writeFileSync(join(homeDir(), "config.json"), JSON.stringify(value), "utf8");
}

function writeProjectConfig(yaml: string): string {
  const root = createProjectRoot();
  const directory = join(root, ".autonomous-qa");
  mkdirSync(directory);
  writeFileSync(join(directory, "config.yml"), yaml, "utf8");
  return root;
}

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "qa-config-project-"));
  roots.push(root);
  return root;
}

function expectPolicyBlocked(run: () => unknown): QaError {
  try {
    run();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(QaError);
    if (!(error instanceof QaError)) {
      throw error;
    }
    expect(error.code).toBe("POLICY_BLOCKED");
    expect(error.recoveryAppropriate).toBe(false);
    return error;
  }
  throw new Error("expected POLICY_BLOCKED");
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = previous;
}
