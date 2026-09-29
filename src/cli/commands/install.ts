import { spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { cp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  appDir,
  browsersDir,
  ensureHomeLayout,
  homeDir,
  userEnvPath,
  userMcpPath,
  userSkillPath,
} from "../../runtime/paths.js";
import { writePrivateEnvFile } from "../../runtime/user-env.js";
import type { Command } from "../types.js";

const DEFAULT_API_KEY_ENV = "COMPANY_LLM_API_KEY";
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KEPT_MCP_SERVER_MESSAGE =
  "kept existing autonomous-qa MCP server; rerun with --force to replace it";

const DEFAULT_USER_CONFIG = {
  llm: {
    provider: "openai-compatible",
    model: "company-ui-agent",
    baseUrl: "https://llm.company.internal/v1",
    apiKeyEnv: DEFAULT_API_KEY_ENV,
    timeoutMs: 60000,
  },
} as const;

export const command: Command = {
  name: "install",
  summary: "install the runtime for every Cursor workspace",
  async run(argv: string[]): Promise<number> {
    try {
      const sourceRoot = readOption(argv, "--source") ?? packageRoot();
      const nodePath = process.execPath;
      ensureHomeLayout();
      await installApp(sourceRoot);
      const replaced = await installUserMcp(nodePath, argv.includes("--force"));
      await installSkill(sourceRoot);
      const apiKeyEnv = await installUserConfig();
      installEnvFile(apiKeyEnv);
      if (!argv.includes("--skip-browser")) {
        await installChromium();
      }
      if (replaced) {
        console.log(installedServerJson());
      }
      return 0;
    } catch (error: unknown) {
      console.error(error instanceof Error ? error.message : "install failed");
      return 1;
    }
  },
};

function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../../..");
}

function readOption(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a path`);
  }
  return value;
}

async function installApp(sourceRoot: string): Promise<void> {
  const entry = join(sourceRoot, "dist", "cli", "main.js");
  if (!existsSync(entry)) {
    throw new Error(`Missing built CLI at ${entry}`);
  }
  if (!existsSync(join(sourceRoot, "package.json"))) {
    throw new Error(`Missing package.json at ${sourceRoot}`);
  }

  const staging = `${appDir()}.staging`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    await stageApp(sourceRoot, staging);
    await activateApp(staging);
  } catch (error: unknown) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function stageApp(sourceRoot: string, staging: string): Promise<void> {
  await copyEntry(sourceRoot, staging, "dist");
  await copyEntry(sourceRoot, staging, "package.json");
  await copyEntryIfPresent(sourceRoot, staging, "package-lock.json");
  await copyEntryIfPresent(sourceRoot, staging, "skills");
  if (existsSync(join(sourceRoot, "node_modules"))) {
    await copyEntry(sourceRoot, staging, "node_modules");
    return;
  }
  await npmInstallProduction(staging);
}

async function copyEntry(sourceRoot: string, staging: string, name: string): Promise<void> {
  await cp(join(sourceRoot, name), join(staging, name), {
    recursive: true,
    dereference: true,
  });
}

async function copyEntryIfPresent(
  sourceRoot: string,
  staging: string,
  name: string,
): Promise<void> {
  if (!existsSync(join(sourceRoot, name))) {
    return;
  }
  await copyEntry(sourceRoot, staging, name);
}

async function npmInstallProduction(staging: string): Promise<void> {
  const lock = join(staging, "package-lock.json");
  const args = existsSync(lock)
    ? ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"]
    : ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"];
  await spawnCommand("npm", args, staging);
}

/**
 * Moves the staged app into place. A failed rename restores the previous app.
 */
async function activateApp(staging: string): Promise<void> {
  const live = appDir();
  const previous = `${live}.previous`;
  await rm(previous, { recursive: true, force: true });
  let movedLive = false;
  if (existsSync(live)) {
    await rename(live, previous);
    movedLive = true;
  }
  try {
    await rename(staging, live);
  } catch (error: unknown) {
    if (movedLive) {
      await rename(previous, live);
    }
    throw error;
  }
  await rm(previous, { recursive: true, force: true });
}

async function installUserMcp(nodePath: string, force: boolean): Promise<boolean> {
  const mcpPath = userMcpPath();
  const server = userServer(nodePath);
  const existing = readOptionalFile(mcpPath);
  if (existing === undefined) {
    await mkdir(dirname(mcpPath), { recursive: true });
    await writeJson(mcpPath, { mcpServers: { "autonomous-qa": server } });
    return true;
  }

  const document = requireRecord(parseJson(existing), "Invalid ~/.cursor/mcp.json: expected an object");
  const serversValue = document.mcpServers;
  if (serversValue === undefined) {
    document.mcpServers = { "autonomous-qa": server };
  } else {
    const servers = requireRecord(
      serversValue,
      "Invalid ~/.cursor/mcp.json: mcpServers must be an object",
    );
    if (Object.hasOwn(servers, "autonomous-qa") && !force) {
      console.error(KEPT_MCP_SERVER_MESSAGE);
      return false;
    }
    servers["autonomous-qa"] = server;
  }
  await mkdir(dirname(mcpPath), { recursive: true });
  await writeJson(mcpPath, document);
  return true;
}

function installedServerJson(): string {
  const document = parseJson(readFileSync(userMcpPath(), "utf8"));
  const servers = isRecord(document) ? document.mcpServers : undefined;
  const server = isRecord(servers) ? servers["autonomous-qa"] : undefined;
  return JSON.stringify({ mcpServers: { "autonomous-qa": server } }, null, 2);
}

function userServer(nodePath: string): Record<string, unknown> {
  return {
    type: "stdio",
    command: nodePath,
    args: [join(appDir(), "dist", "cli", "main.js"), "mcp"],
    env: {
      AUTONOMOUS_QA_HOME: homeDir(),
      PLAYWRIGHT_BROWSERS_PATH: browsersDir(),
    },
    envFile: userEnvPath(),
  };
}

async function installSkill(sourceRoot: string): Promise<void> {
  const source = join(sourceRoot, "skills", "autonomous-qa", "SKILL.md");
  if (!existsSync(source)) {
    throw new Error(`Missing skill at ${source}`);
  }
  const destination = userSkillPath();
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { dereference: true, force: true });
}

async function installUserConfig(): Promise<string> {
  const configPath = join(homeDir(), "config.json");
  if (!existsSync(configPath)) {
    await writeJson(configPath, DEFAULT_USER_CONFIG);
    return DEFAULT_API_KEY_ENV;
  }
  return apiKeyEnvFromConfig(readFileSync(configPath, "utf8"));
}

function apiKeyEnvFromConfig(source: string): string {
  try {
    const parsed: unknown = JSON.parse(source);
    if (!isRecord(parsed) || !isRecord(parsed.llm)) {
      return DEFAULT_API_KEY_ENV;
    }
    const name = parsed.llm.apiKeyEnv;
    if (typeof name === "string" && ENV_NAME.test(name)) {
      return name;
    }
  } catch {
    return DEFAULT_API_KEY_ENV;
  }
  return DEFAULT_API_KEY_ENV;
}

function installEnvFile(apiKeyEnv: string): void {
  const filePath = userEnvPath();
  if (existsSync(filePath)) {
    if (isSymlink(filePath)) {
      throw new Error(`Refusing to follow a symlink: ${filePath}`);
    }
    return;
  }
  writePrivateEnvFile(filePath, `${apiKeyEnv}=\n`);
}

async function installChromium(): Promise<void> {
  const previous = process.env.PLAYWRIGHT_BROWSERS_PATH;
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersDir();
  try {
    if (existsSync(chromium.executablePath())) {
      return;
    }
    const cli = join(appDir(), "node_modules", "playwright", "cli.js");
    await spawnCommand(process.execPath, [cli, "install", "chromium"], appDir());
  } finally {
    restoreEnv("PLAYWRIGHT_BROWSERS_PATH", previous);
  }
}

function spawnCommand(command: string, args: readonly string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
      env: process.env,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderr.trim();
      reject(new Error(detail.length > 0 ? detail : `${command} exited ${code ?? "unknown"}`));
    });
  });
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readOptionalFile(filePath: string): string | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }
  return readFileSync(filePath, "utf8");
}

function parseJson(source: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new Error("Invalid ~/.cursor/mcp.json: expected JSON");
  }
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(message);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSymlink(filePath: string): boolean {
  try {
    return lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = previous;
}
