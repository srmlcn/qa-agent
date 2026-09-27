import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { loadProjectConfig } from "../../../src/config/load-project.js";
import { QaError } from "../../../src/errors/qa-error.js";

const SAMPLE_PROJECT_ID = "demo-app";

const SECTION_7_SAMPLE = `
version: 1

project:
  id: ${SAMPLE_PROJECT_ID}

application:
  baseUrl: http://localhost:3000
  allowedHosts:
    - localhost
  productionAllowed: false

llm:
  provider: openai-compatible
  model: company-ui-agent
  baseUrl: https://llm.company.internal/v1
  apiKeyEnv: COMPANY_LLM_API_KEY
  timeoutMs: 60000

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

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the section 7 sample parses once project.id is added", () => {
  const config = loadProjectConfig(writeProjectConfig(SECTION_7_SAMPLE));

  expect(config).toEqual({
    version: 1,
    project: { id: SAMPLE_PROJECT_ID },
    application: {
      baseUrl: "http://localhost:3000",
      allowedHosts: ["localhost"],
      productionAllowed: false,
    },
    llm: {
      provider: "openai-compatible",
      model: "company-ui-agent",
      baseUrl: "https://llm.company.internal/v1",
      apiKeyEnv: "COMPANY_LLM_API_KEY",
      timeoutMs: 60000,
    },
    stagehand: {
      enabled: true,
      maxSteps: 30,
      recoveryEnabled: true,
    },
    playwright: {
      browser: "chromium",
      headless: true,
      workers: 4,
      timeoutMs: 30000,
    },
    evidence: {
      screenshots: "checkpoints",
      network: true,
      console: true,
      trace: "on-failure",
      maxResponseBodyBytes: 262144,
    },
    security: {
      redactHeaders: ["authorization", "cookie", "set-cookie"],
      destructiveActionsAllowed: false,
      maxRunDurationMs: 600000,
    },
    auth: {
      workerProfiles: [],
    },
  });
});

test("an unknown browser value fails as POLICY_BLOCKED and names the field", () => {
  const yaml = SECTION_7_SAMPLE.replace("browser: chromium", "browser: firefox");
  const error = expectPolicyBlocked(() =>
    loadProjectConfig(writeProjectConfig(yaml)),
  );

  expect(error.message).toContain("playwright.browser");
  expect(error.message).not.toContain("firefox");
});

test("productionAllowed defaults to false when omitted", () => {
  const yaml = SECTION_7_SAMPLE.replace("  productionAllowed: false\n", "");
  const config = loadProjectConfig(writeProjectConfig(yaml));

  expect(config.application.productionAllowed).toBe(false);
});

test("explicit productionAllowed true is kept", () => {
  const yaml = SECTION_7_SAMPLE.replace(
    "productionAllowed: false",
    "productionAllowed: true",
  );
  const config = loadProjectConfig(writeProjectConfig(yaml));

  expect(config.application.productionAllowed).toBe(true);
});

test("omitted defaults fill browser, headless, maxSteps, body limit, redaction, and worker profiles", () => {
  const yaml = `
version: 1
project:
  id: demo-app
application:
  baseUrl: http://localhost:3000
  allowedHosts:
    - localhost
llm:
  provider: openai
  model: configured-model
  apiKeyEnv: OPENAI_API_KEY
  timeoutMs: 60000
stagehand:
  enabled: true
  recoveryEnabled: true
playwright:
  workers: 4
  timeoutMs: 30000
evidence:
  screenshots: checkpoints
  network: true
  console: true
  trace: on-failure
`;
  const config = loadProjectConfig(writeProjectConfig(yaml));

  expect(config.application.productionAllowed).toBe(false);
  expect(config.playwright.browser).toBe("chromium");
  expect(config.playwright.headless).toBe(true);
  expect(config.stagehand.maxSteps).toBe(30);
  expect(config.evidence.maxResponseBodyBytes).toBe(262144);
  expect(config.security).toEqual({
    destructiveActionsAllowed: false,
    maxRunDurationMs: 600000,
    redactHeaders: ["authorization", "cookie", "set-cookie"],
  });
  expect(config.auth.workerProfiles).toEqual([]);
  expect(config.llm).toEqual({
    provider: "openai",
    model: "configured-model",
    apiKeyEnv: "OPENAI_API_KEY",
    timeoutMs: 60000,
  });
});

test("the loaded object stores apiKeyEnv and not the environment value", () => {
  const secret = "llm-key-9f3c2a-do-not-store";
  const previousCompany = process.env.COMPANY_LLM_API_KEY;
  const previousOpenAi = process.env.OPENAI_API_KEY;
  process.env.COMPANY_LLM_API_KEY = secret;
  process.env.OPENAI_API_KEY = secret;

  try {
    const config = loadProjectConfig(writeProjectConfig(SECTION_7_SAMPLE));
    const serialized = JSON.stringify(config);

    expect(config.llm.apiKeyEnv).toBe("COMPANY_LLM_API_KEY");
    expect(serialized).not.toContain(secret);
    expect(config.llm).not.toHaveProperty("apiKey");
    expect(config).not.toHaveProperty("apiKey");
  } finally {
    restoreEnv("COMPANY_LLM_API_KEY", previousCompany);
    restoreEnv("OPENAI_API_KEY", previousOpenAi);
  }
});

test("a missing file returns POLICY_BLOCKED and names the file", () => {
  const root = createProjectRoot();
  const error = expectPolicyBlocked(() => loadProjectConfig(root));

  expect(error.message).toContain(".autonomous-qa/config.yml");
  expect(error.message).toContain("Missing");
});

test("a schema violation names the file and the field", () => {
  const yaml = SECTION_7_SAMPLE.replace("id: demo-app", "id: Not A Project");
  const error = expectPolicyBlocked(() =>
    loadProjectConfig(writeProjectConfig(yaml)),
  );

  expect(error.message).toContain(".autonomous-qa/config.yml");
  expect(error.message).toContain("project.id");
});

test("an unknown provider fails as POLICY_BLOCKED", () => {
  const yaml = SECTION_7_SAMPLE.replace(
    "provider: openai-compatible",
    "provider: anthropic",
  );
  const error = expectPolicyBlocked(() =>
    loadProjectConfig(writeProjectConfig(yaml)),
  );

  expect(error.message).toContain("llm.provider");
});

test("an apiKey field is rejected and the value is not echoed", () => {
  const secret = "pasted-key-should-not-leak";
  const yaml = SECTION_7_SAMPLE.replace(
    "apiKeyEnv: COMPANY_LLM_API_KEY",
    `apiKeyEnv: COMPANY_LLM_API_KEY\n  apiKey: ${secret}`,
  );
  const error = expectPolicyBlocked(() =>
    loadProjectConfig(writeProjectConfig(yaml)),
  );

  expect(error.message).toContain("llm.apiKey");
  expect(error.message).not.toContain(secret);
  expect(JSON.stringify(error.toJSON())).not.toContain(secret);
});

test("explicit worker profiles are kept", () => {
  const yaml = `${SECTION_7_SAMPLE}
auth:
  workerProfiles:
    - worker-a
    - worker-b
`;
  const config = loadProjectConfig(writeProjectConfig(yaml));

  expect(config.auth.workerProfiles).toEqual(["worker-a", "worker-b"]);
});

function writeProjectConfig(yaml: string): string {
  const root = createProjectRoot();
  const directory = join(root, ".autonomous-qa");
  mkdirSync(directory);
  writeFileSync(join(directory, "config.yml"), yaml, "utf8");
  return root;
}

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "qa-project-config-"));
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
