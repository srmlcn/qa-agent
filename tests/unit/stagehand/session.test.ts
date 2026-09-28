import { expect, test } from "vitest";
import type { ProjectConfig } from "../../../src/config/schema.js";
import { QaError } from "../../../src/errors/qa-error.js";
import { createFakeClient } from "../../../src/stagehand/fake-client.js";
import type { LlmProvider } from "../../../src/stagehand/provider.js";
import { discover } from "../../../src/stagehand/session.js";

const objective = "Archive the active project";
const startUrl = "http://localhost:3000/projects";
const pageSecret = "page-secret-archive-token";

const provider: LlmProvider = {
  provider: "openai-compatible",
  model: "configured-model",
  baseUrl: "https://llm.example/v1",
  headers: {},
  timeoutMs: 1_000,
  maxRetries: 0,
  apiKeyEnv: "QA_AGENT_DISCOVERY_SESSION_KEY",
};

const oneAction = {
  method: "click",
  selector: "//button[@aria-label='Archive']",
  description: "Archive the project",
  arguments: [pageSecret],
} as const;

test("a one-action fake client returns a trajectory of length 1", async () => {
  const trajectory = await discover({
    objective,
    startUrl,
    config: projectConfig(),
    provider,
    maxSteps: 1,
    client: createFakeClient([oneAction]),
  });

  expect(trajectory.actions).toHaveLength(1);
  expect(trajectory.success).toBe(true);
  expect(trajectory.actions[0]).toMatchObject({
    index: 0,
    method: "click",
    instruction: "Archive the project",
    selector: "//button[@aria-label='Archive']",
    arguments: [pageSecret],
  });
});

test("maxSteps 1 with a script that does not finish throws DISCOVERY_FAILED", async () => {
  const client = createFakeClient([
    oneAction,
    {
      method: "fill",
      selector: "//input[@name='reason']",
      description: pageSecret,
      arguments: [pageSecret],
    },
  ]);

  const error = await rejected(
    discover({
      objective,
      startUrl,
      config: projectConfig(),
      provider,
      maxSteps: 1,
      client,
    }),
  );

  expect(error.code).toBe("DISCOVERY_FAILED");
  expect(error.recoveryAppropriate).toBe(false);
  expect(error.artifacts).toBeUndefined();
  expect(error.message).toContain("2");
  expect(error.message).not.toContain(pageSecret);
  expect(JSON.stringify(error.toJSON())).not.toContain(pageSecret);
  expect(error.toJSON()).not.toHaveProperty("artifacts");
});

test("an empty trajectory throws DISCOVERY_FAILED", async () => {
  const error = await rejected(
    discover({
      objective,
      startUrl,
      config: projectConfig(),
      provider,
      maxSteps: 5,
      client: createFakeClient([]),
    }),
  );

  expect(error.code).toBe("DISCOVERY_FAILED");
  expect(error.message).toContain("0");
  expect(error.artifacts).toBeUndefined();
});

test("abort throws RUN_CANCELLED and the close hook ran", async () => {
  const controller = new AbortController();
  let closed = 0;
  let ran = 0;
  const fake = createFakeClient([oneAction]);
  const client = {
    async run(goal: string) {
      ran += 1;
      controller.abort();
      return fake.run(goal);
    },
    async close() {
      closed += 1;
    },
  };

  const error = await rejected(
    discover({
      objective,
      startUrl,
      config: projectConfig(),
      provider,
      maxSteps: 5,
      signal: controller.signal,
      client,
    }),
  );

  expect(error.code).toBe("RUN_CANCELLED");
  expect(error.recoveryAppropriate).toBe(false);
  expect(closed).toBe(1);
  expect(ran).toBe(1);
});

test("a close failure after a discovery error keeps that error", async () => {
  const closeError = new Error("browser close failed");
  let closed = 0;
  const fake = createFakeClient([]);
  const client = {
    async run(goal: string) {
      return fake.run(goal);
    },
    async close() {
      closed += 1;
      throw closeError;
    },
  };

  const error = await rejected(
    discover({
      objective,
      startUrl,
      config: projectConfig(),
      provider,
      maxSteps: 5,
      client,
    }),
  );

  expect(error.code).toBe("DISCOVERY_FAILED");
  expect(error.cause).toBe(closeError);
  expect(closed).toBe(1);
});

test("a close failure after cancellation keeps RUN_CANCELLED", async () => {
  const controller = new AbortController();
  const closeError = new Error("browser close failed");
  let closed = 0;
  const fake = createFakeClient([oneAction]);
  const client = {
    async run(goal: string) {
      controller.abort();
      return fake.run(goal);
    },
    async close() {
      closed += 1;
      throw closeError;
    },
  };

  const error = await rejected(
    discover({
      objective,
      startUrl,
      config: projectConfig(),
      provider,
      maxSteps: 5,
      signal: controller.signal,
      client,
    }),
  );

  expect(error.code).toBe("RUN_CANCELLED");
  expect(error.cause).toBe(closeError);
  expect(closed).toBe(1);
});

test("a close failure with no earlier error still surfaces", async () => {
  const closeError = new Error("browser close failed");
  const fake = createFakeClient([oneAction]);
  const client = {
    async run(goal: string) {
      return fake.run(goal);
    },
    async close() {
      throw closeError;
    },
  };

  await expect(
    discover({
      objective,
      startUrl,
      config: projectConfig(),
      provider,
      maxSteps: 1,
      client,
    }),
  ).rejects.toBe(closeError);
});

test("a disallowed URL throws POLICY_BLOCKED before the client acts", async () => {
  let ran = 0;
  let closed = 0;
  const fake = createFakeClient([oneAction]);
  const client = {
    async run(goal: string) {
      ran += 1;
      return fake.run(goal);
    },
    async close() {
      closed += 1;
    },
  };

  const error = await rejected(
    discover({
      objective,
      startUrl: "https://evil.example/archive",
      config: projectConfig(),
      provider,
      maxSteps: 5,
      client,
    }),
  );

  expect(error.code).toBe("POLICY_BLOCKED");
  expect(error.recoveryAppropriate).toBe(false);
  expect(ran).toBe(0);
  expect(closed).toBe(0);
});

function projectConfig(): ProjectConfig {
  return {
    version: 1,
    project: { id: "demo-app" },
    application: {
      baseUrl: "http://localhost:3000",
      allowedHosts: ["localhost"],
      productionAllowed: false,
    },
    llm: {
      provider: "openai-compatible",
      model: "configured-model",
      baseUrl: "https://llm.example/v1",
      apiKeyEnv: "QA_AGENT_DISCOVERY_SESSION_KEY",
      timeoutMs: 1_000,
    },
    stagehand: {
      enabled: true,
      maxSteps: 30,
      recoveryEnabled: false,
      debugTools: false,
    },
    playwright: {
      browser: "chromium",
      headless: true,
      workers: 1,
      timeoutMs: 30_000,
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
      maxRunDurationMs: 600_000,
    },
    auth: {
      workerProfiles: [],
    },
  };
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
