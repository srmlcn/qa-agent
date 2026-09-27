import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { z } from "zod";
import { loadProjectConfig } from "../../config/load-project.js";
import { QaError } from "../../errors/qa-error.js";
import { version } from "../../index.js";
import type { McpTool } from "../load-tools.js";

const MIN_NODE_MAJOR = 22;

export type StatusReport = {
  packageVersion: string;
  nodeOk: boolean;
  configOk: boolean;
  browserOk: boolean;
  llmOk: boolean;
  problems: string[];
};

const schema = z.object({
  projectRoot: z.string().min(1).optional(),
});

/**
 * Reports runtime health for one project root.
 * The API key value is never read into the report.
 */
export function reportStatus(projectRoot: string): StatusReport {
  const problems: string[] = [];
  const nodeOk = nodeMajor() >= MIN_NODE_MAJOR;
  if (!nodeOk) {
    problems.push(`Node.js ${process.versions.node} is below ${MIN_NODE_MAJOR}`);
  }

  const browserOk = chromiumExecutableExists();
  if (!browserOk) {
    problems.push("Chromium is not installed");
  }

  const loaded = loadConfig(projectRoot);
  if (!loaded.ok) {
    problems.push(loaded.problem);
  }

  const llmOk = loaded.ok ? envVarIsSet(loaded.apiKeyEnv) : false;
  if (loaded.ok && !llmOk) {
    problems.push(
      `LLM API key environment variable ${loaded.apiKeyEnv} is unset`,
    );
  }

  return {
    packageVersion: version,
    nodeOk,
    configOk: loaded.ok,
    browserOk,
    llmOk,
    problems,
  };
}

export const tool = {
  name: "qa.status",
  description:
    "Report package, Node, config, browser, and LLM health. Does not print secrets or launch a browser.",
  schema,
  async handler(args: unknown): Promise<StatusReport> {
    const input = schema.parse(args);
    return reportStatus(input.projectRoot ?? process.cwd());
  },
} satisfies McpTool;

type LoadedConfig =
  | { ok: true; apiKeyEnv: string }
  | { ok: false; problem: string };

function loadConfig(projectRoot: string): LoadedConfig {
  try {
    const config = loadProjectConfig(projectRoot);
    return { ok: true, apiKeyEnv: config.llm.apiKeyEnv };
  } catch (error) {
    if (error instanceof QaError) {
      return { ok: false, problem: error.message };
    }
    return { ok: false, problem: "project config failed to load" };
  }
}

/** True when the named env var is set to a non-empty string. The value is not returned. */
function envVarIsSet(name: string): boolean {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0;
}

function nodeMajor(): number {
  const major = Number(process.versions.node.split(".")[0]);
  return Number.isInteger(major) ? major : 0;
}

/** Uses the Playwright executable path only. Does not launch Chromium. */
function chromiumExecutableExists(): boolean {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}
