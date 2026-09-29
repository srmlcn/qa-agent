import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { PROJECT_ID_PATTERN } from "../../config/schema.js";
import type { Command } from "../types.js";

const PROJECT_ID_MAX_LENGTH = 63;
const FALLBACK_PROJECT_ID = "project";

const GITIGNORE_ENTRIES = [
  ".autonomous-qa/artifacts/",
  ".autonomous-qa/runtime/",
  "playwright-report/",
  "test-results/",
] as const;

/** Spec section 6. Printed to stdout and merged by --install-mcp. */
const CURSOR_MCP_JSON = `{
  "mcpServers": {
    "autonomous-qa": {
      "type": "stdio",
      "command": "autonomous-qa",
      "args": ["mcp"]
    }
  }
}`;

const KEPT_MCP_SERVER_MESSAGE = "kept existing autonomous-qa MCP server";

export const command: Command = {
  name: "init",
  summary: "create project config and flows directory",
  async run(argv: string[]): Promise<number> {
    const projectRoot = process.cwd();
    await createFlowsDirectory(projectRoot);
    await createProjectConfig(projectRoot);
    await ensureGitignore(projectRoot);
    if (argv.includes("--install-mcp")) {
      await installMcpConfig(projectRoot);
    }
    console.log(CURSOR_MCP_JSON);
    return 0;
  },
};

async function createFlowsDirectory(projectRoot: string): Promise<void> {
  await mkdir(join(projectRoot, ".autonomous-qa", "flows"), { recursive: true });
}

async function createProjectConfig(projectRoot: string): Promise<void> {
  const configPath = join(projectRoot, ".autonomous-qa", "config.yml");
  if (await readOptionalFile(configPath) !== undefined) {
    return;
  }

  const projectId = projectIdFromDirectoryName(basename(projectRoot));
  await writeFile(configPath, renderProjectConfig(projectId), "utf8");
}

/**
 * Directory names are sanitized to the project id schema
 * `/^[a-z0-9][a-z0-9-]{0,62}$/`.
 */
function projectIdFromDirectoryName(directoryName: string): string {
  const hyphenated = directoryName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const trimmed = hyphenated.replace(/^-+/, "").replace(/-+$/, "");
  const truncated = trimmed.slice(0, PROJECT_ID_MAX_LENGTH).replace(/-+$/, "");
  if (PROJECT_ID_PATTERN.test(truncated)) {
    return truncated;
  }
  return FALLBACK_PROJECT_ID;
}

function renderProjectConfig(projectId: string): string {
  return `version: 1

project:
  id: ${projectId}

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
}

async function ensureGitignore(projectRoot: string): Promise<void> {
  const gitignorePath = join(projectRoot, ".gitignore");
  const existing = (await readOptionalFile(gitignorePath)) ?? "";
  const next = withGitignoreEntries(existing);
  if (next !== existing) {
    await writeFile(gitignorePath, next, "utf8");
  }
}

function withGitignoreEntries(existing: string): string {
  const missing = GITIGNORE_ENTRIES.filter((entry) => !hasGitignoreEntry(existing, entry));
  if (missing.length === 0) {
    return existing;
  }

  const block = `${missing.join("\n")}\n`;
  if (existing.length === 0) {
    return block;
  }
  if (existing.endsWith("\n")) {
    return existing + block;
  }
  return `${existing}\n${block}`;
}

function hasGitignoreEntry(existing: string, entry: string): boolean {
  return existing.split(/\r?\n/).some((line) => line.trim() === entry);
}

async function installMcpConfig(projectRoot: string): Promise<void> {
  const mcpPath = join(projectRoot, ".cursor", "mcp.json");
  const existing = await readOptionalFile(mcpPath);
  if (existing === undefined) {
    await mkdir(dirname(mcpPath), { recursive: true });
    await writeFile(mcpPath, `${CURSOR_MCP_JSON}\n`, "utf8");
    return;
  }

  const document = requireRecord(
    parseJson(existing),
    "Invalid .cursor/mcp.json: expected an object",
  );
  const serversValue = document.mcpServers;
  if (serversValue === undefined) {
    document.mcpServers = {
      "autonomous-qa": autonomousQaServer(),
    };
  } else {
    const servers = requireRecord(
      serversValue,
      "Invalid .cursor/mcp.json: mcpServers must be an object",
    );
    if (Object.hasOwn(servers, "autonomous-qa")) {
      console.error(KEPT_MCP_SERVER_MESSAGE);
      return;
    }
    servers["autonomous-qa"] = autonomousQaServer();
  }

  await mkdir(dirname(mcpPath), { recursive: true });
  await writeFile(mcpPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

function autonomousQaServer(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(CURSOR_MCP_JSON);
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
    throw new Error("Invalid MCP template");
  }
  const server = parsed.mcpServers["autonomous-qa"];
  if (!isRecord(server)) {
    throw new Error("Invalid MCP template");
  }
  return structuredClone(server);
}

function parseJson(source: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new Error("Invalid .cursor/mcp.json: expected JSON");
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

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error: unknown) {
    if (isEnoent(error)) {
      return undefined;
    }
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
