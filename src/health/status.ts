import { accessSync, constants, existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "playwright";
import { loadProjectConfig } from "../config/load-project.js";
import { QaError } from "../errors/qa-error.js";
import { version } from "../index.js";
import { homeDir } from "../runtime/paths.js";

const MIN_NODE_MAJOR = 22;
const PRIVATE_DIR_MODE = 0o700;

export type HealthReport = {
  packageVersion: string;
  nodeOk: boolean;
  configOk: boolean;
  browserOk: boolean;
  llmOk: boolean;
  homeOk: boolean;
  problems: string[];
};

/**
 * Runtime health for one project root.
 * Reports the API key variable name and never the value.
 * Browser health uses the Chromium executable path and does not launch it.
 */
export function collectHealth(projectRoot: string): HealthReport {
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

  const home = checkHome();
  if (!home.ok) {
    problems.push(home.problem);
  }

  return {
    packageVersion: version,
    nodeOk,
    configOk: loaded.ok,
    browserOk,
    llmOk,
    homeOk: home.ok,
    problems,
  };
}

type LoadedConfig =
  | { ok: true; apiKeyEnv: string }
  | { ok: false; problem: string };

type HomeCheck = { ok: true } | { ok: false; problem: string };

function loadConfig(projectRoot: string): LoadedConfig {
  try {
    const config = loadProjectConfig(projectRoot);
    return { ok: true, apiKeyEnv: config.llm.apiKeyEnv };
  } catch (error: unknown) {
    if (error instanceof QaError) {
      return { ok: false, problem: error.message };
    }
    return { ok: false, problem: "project config failed to load" };
  }
}

/** True when the named env var is a non-empty string. The value is not returned. */
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

/**
 * The auth directory is `homeDir()/auth`. Its parent is private when that
 * directory is mode 0700, or when it is missing and can be created.
 */
function checkHome(): HomeCheck {
  const home = homeDir();
  try {
    const stats = statSync(home);
    if (stats.isDirectory() && (stats.mode & 0o777) === PRIVATE_DIR_MODE) {
      return { ok: true };
    }
    return {
      ok: false,
      problem: `Home directory ${home} must be a directory with mode 0700`,
    };
  } catch (error: unknown) {
    if (isEnoent(error)) {
      if (directoryIsCreatable(home)) {
        return { ok: true };
      }
      return {
        ok: false,
        problem: `Home directory ${home} cannot be created`,
      };
    }
    return {
      ok: false,
      problem: `Home directory ${home} is not accessible`,
    };
  }
}

function directoryIsCreatable(path: string): boolean {
  try {
    const stats = statSync(path);
    if (!stats.isDirectory()) {
      return false;
    }
    accessSync(path, constants.W_OK | constants.X_OK);
    return true;
  } catch (error: unknown) {
    if (!isEnoent(error)) {
      return false;
    }
  }

  const parent = dirname(path);
  if (parent === path) {
    return false;
  }
  return directoryIsCreatable(parent);
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
