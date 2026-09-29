import { execSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadEffectiveConfig } from "../config/effective.js";
import { QaError } from "../errors/qa-error.js";
import { version } from "../index.js";
import { installedChromiumExecutable } from "../playwright/runtime.js";
import { otherProjectPaths } from "../runtime/project-registry.js";
import { appDir, homeDir, userMcpPath } from "../runtime/paths.js";

const MIN_NODE_MAJOR = 22;
const PRIVATE_DIR_MODE = 0o700;

export type HealthReport = {
  packageVersion: string;
  nodeOk: boolean;
  configOk: boolean;
  browserOk: boolean;
  llmOk: boolean;
  homeOk: boolean;
  appOk: boolean;
  userMcpOk: boolean;
  projectMcpOverride: boolean;
  userInstallOk: boolean;
  ffmpegAvailable: boolean;
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

  const appOk = appInstalled();
  if (!appOk) {
    problems.push(`Installed app is missing at ${join(appDir(), "dist", "cli", "main.js")}`);
  }

  const userMcpOk = userMcpInstalled();
  if (!userMcpOk) {
    problems.push(`User MCP server is missing at ${userMcpPath()}`);
  }

  const projectMcpOverride = projectOverridesUserServer(projectRoot);
  if (projectMcpOverride) {
    problems.push("Project .cursor/mcp.json overrides the user autonomous-qa server");
  }

  const loaded = loadConfig(projectRoot);
  if (!loaded.ok) {
    problems.push(loaded.problem);
  } else {
    pushProjectIdCollisions(loaded.projectId, projectRoot, problems);
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

  const ffmpegAvailable = ffmpegExecutableExists();

  const userInstallOk = nodeOk && home.ok && browserOk && appOk && userMcpOk;

  return {
    packageVersion: version,
    nodeOk,
    configOk: loaded.ok,
    browserOk,
    llmOk,
    homeOk: home.ok,
    appOk,
    userMcpOk,
    projectMcpOverride,
    userInstallOk,
    ffmpegAvailable,
    problems,
  };
}

function ffmpegExecutableExists(): boolean {
  try {
    execSync("ffmpeg -version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

type LoadedConfig =
  | { ok: true; apiKeyEnv: string; projectId: string }
  | { ok: false; problem: string };

type HomeCheck = { ok: true } | { ok: false; problem: string };

function loadConfig(projectRoot: string): LoadedConfig {
  try {
    const config = loadEffectiveConfig(projectRoot).config;
    return {
      ok: true,
      apiKeyEnv: config.llm.apiKeyEnv,
      projectId: config.project.id,
    };
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

/** Uses the home browsers directory, or `PLAYWRIGHT_BROWSERS_PATH` when set. */
function chromiumExecutableExists(): boolean {
  return installedChromiumExecutable() !== undefined;
}

function appInstalled(): boolean {
  return existsSync(join(appDir(), "dist", "cli", "main.js"));
}

function userMcpInstalled(): boolean {
  const filePath = userMcpPath();
  if (!existsSync(filePath)) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
      return false;
    }
    const server = parsed.mcpServers["autonomous-qa"];
    return isRecord(server) && typeof server.command === "string" && server.command.length > 0;
  } catch {
    return false;
  }
}

function projectOverridesUserServer(projectRoot: string): boolean {
  const filePath = join(projectRoot, ".cursor", "mcp.json");
  if (!existsSync(filePath)) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
      return false;
    }
    return Object.hasOwn(parsed.mcpServers, "autonomous-qa");
  } catch {
    return false;
  }
}

function pushProjectIdCollisions(
  projectId: string,
  projectRoot: string,
  problems: string[],
): void {
  try {
    for (const path of otherProjectPaths(projectId, projectRoot)) {
      problems.push(`Project id ${projectId} is also used at ${path}`);
    }
  } catch {
    problems.push("Project registry could not be read");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
