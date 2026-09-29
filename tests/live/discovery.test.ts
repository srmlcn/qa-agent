import { expect, test } from "vitest";
import type { ProjectConfig } from "../../src/config/schema.js";
import { start } from "../../fixtures/archive-app/server.js";
import { createProvider } from "../../src/stagehand/provider.js";
import { discover } from "../../src/stagehand/session.js";

const LIVE_FLAG = "AUTONOMOUS_QA_LIVE";
const LIVE_TIMEOUT_MS = 300_000;

const objective =
  "Archive the Alpha project so it disappears from the active list.";

const config: ProjectConfig = {
  version: 1,
  project: { id: "archive-app" },
  application: {
    baseUrl: "http://127.0.0.1",
    allowedHosts: ["127.0.0.1"],
    productionAllowed: false,
  },
  llm: {
    provider: "openai",
    model: "gpt-4o-mini",
    apiKeyEnv: "OPENAI_API_KEY",
    timeoutMs: 60_000,
  },
  stagehand: {
    enabled: true,
    maxSteps: 15,
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
    redactHeaders: ["authorization", "cookie", "set-cookie"],
    destructiveActionsAllowed: false,
    maxRunDurationMs: 600_000,
  },
  auth: {
    workerProfiles: [],
  },
};

test(
  "discovers the archive fixture with the real provider",
  async ({ skip }) => {
    if (!liveFlagIsSet() || !apiKeyIsSet(config.llm.apiKeyEnv)) {
      skip();
    }

    const app = await start(0);
    try {
      const trajectory = await discover({
        objective,
        startUrl: app.url,
        config,
        provider: createProvider(config.llm),
        maxSteps: config.stagehand.maxSteps,
      });
      expect(trajectory.actions.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  },
  LIVE_TIMEOUT_MS,
);

function liveFlagIsSet(): boolean {
  return process.env[LIVE_FLAG] === "1";
}

function apiKeyIsSet(envName: string): boolean {
  const value = process.env[envName];
  return typeof value === "string" && value.length > 0;
}
