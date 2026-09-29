import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { main } from "../../../src/cli/main.js";
import { userEnvPath, userMcpPath, userSkillPath } from "../../../src/runtime/paths.js";

const SECRET = "install-secret-8aa31c-do-not-print";
const homes: string[] = [];
const cursors: string[] = [];
const sources: string[] = [];
let previousHome: string | undefined;
let previousCursor: string | undefined;

beforeEach(() => {
  previousHome = process.env.AUTONOMOUS_QA_HOME;
  previousCursor = process.env.AUTONOMOUS_QA_CURSOR_DIR;
  const home = mkdtempSync(join(tmpdir(), "qa-install-home-"));
  const cursor = mkdtempSync(join(tmpdir(), "qa-install-cursor-"));
  homes.push(home);
  cursors.push(cursor);
  process.env.AUTONOMOUS_QA_HOME = home;
  process.env.AUTONOMOUS_QA_CURSOR_DIR = cursor;
});

afterEach(() => {
  vi.restoreAllMocks();
  restore("AUTONOMOUS_QA_HOME", previousHome);
  restore("AUTONOMOUS_QA_CURSOR_DIR", previousCursor);
  for (const path of homes.splice(0)) {
    chmodSync(path, 0o700);
    rmSync(path, { recursive: true, force: true });
  }
  for (const path of cursors.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
  for (const path of sources.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

test("install writes the app, user MCP server, skill, config, and private env file", async () => {
  const source = await createSource("skill-v1");
  const result = await runInstall(["--source", source, "--skip-browser"]);
  const home = process.env.AUTONOMOUS_QA_HOME ?? "";

  expect(result.code).toBe(0);
  expect(result.errors).toEqual([]);
  expect(readFileSync(join(home, "app", "dist", "cli", "main.js"), "utf8")).toBe("cli\n");
  expect(readFileSync(join(home, "app", "node_modules", "example", "index.js"), "utf8")).toBe(
    "dep\n",
  );
  expect(readFileSync(userSkillPath(), "utf8")).toBe("skill-v1\n");

  const mcp = JSON.parse(readFileSync(userMcpPath(), "utf8")) as {
    mcpServers: { "autonomous-qa": Record<string, unknown> };
  };
  expect(mcp.mcpServers["autonomous-qa"]).toEqual({
    type: "stdio",
    command: process.execPath,
    args: [join(home, "app", "dist", "cli", "main.js"), "mcp"],
    env: {
      AUTONOMOUS_QA_HOME: home,
      PLAYWRIGHT_BROWSERS_PATH: join(home, "browsers"),
    },
    envFile: userEnvPath(),
  });
  expect(mcp.mcpServers["autonomous-qa"]).not.toHaveProperty("cwd");
  expect(result.logs.join("\n")).toBe(readFileSync(userMcpPath(), "utf8").trimEnd());

  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as {
    llm: { apiKeyEnv: string };
  };
  expect(config.llm.apiKeyEnv).toBe("COMPANY_LLM_API_KEY");
  expect(config).not.toHaveProperty("apiKey");
  expect(JSON.stringify(config)).not.toContain(SECRET);
  expect(readFileSync(userEnvPath(), "utf8")).toBe("COMPANY_LLM_API_KEY=\n");
  expect(statSync(userEnvPath()).mode & 0o777).toBe(0o600);
  expect(result.logs.join("\n")).not.toContain(SECRET);
});

test("a second install keeps config, env, and an existing MCP server", async () => {
  const source = await createSource("skill-v1");
  expect((await runInstall(["--source", source, "--skip-browser"])).code).toBe(0);

  const home = process.env.AUTONOMOUS_QA_HOME ?? "";
  const configPath = join(home, "config.json");
  writeFileSync(configPath, `${JSON.stringify({ llm: { apiKeyEnv: "KEEP_ME" }, note: SECRET })}\n`);
  writeFileSync(userEnvPath(), `KEEP_ME=${SECRET}\n`, { mode: 0o600 });
  chmodSync(userEnvPath(), 0o600);
  const mcpPath = userMcpPath();
  const originalMcp = `${JSON.stringify({ mcpServers: { github: { command: "github-mcp" }, "autonomous-qa": { command: "custom-qa" } } }, null, 2)}\n`;
  writeFileSync(mcpPath, originalMcp);
  writeFileSync(join(source, "skills", "autonomous-qa", "SKILL.md"), "skill-v2\n");

  const result = await runInstall(["--source", source, "--skip-browser"]);

  expect(result.code).toBe(0);
  expect(result.errors).toEqual([
    "kept existing autonomous-qa MCP server; rerun with --force to replace it",
  ]);
  expect(readFileSync(mcpPath, "utf8")).toBe(originalMcp);
  expect(readFileSync(userSkillPath(), "utf8")).toBe("skill-v2\n");
  expect(readFileSync(configPath, "utf8")).toContain(SECRET);
  expect(readFileSync(userEnvPath(), "utf8")).toBe(`KEEP_ME=${SECRET}\n`);
  expect(result.logs.join("\n")).not.toContain(SECRET);
  expect(result.errors.join("\n")).not.toContain(SECRET);
});

test("--force replaces the autonomous-qa server and keeps an unrelated server", async () => {
  const source = await createSource("skill-v1");
  const mcpPath = userMcpPath();
  writeFileSync(
    mcpPath,
    JSON.stringify({
      extra: true,
      mcpServers: {
        github: { command: "github-mcp", env: { TOKEN: SECRET } },
        "autonomous-qa": { command: "custom-qa" },
      },
    }),
  );

  const result = await runInstall(["--source", source, "--skip-browser", "--force"]);
  const merged = JSON.parse(readFileSync(mcpPath, "utf8")) as {
    extra: boolean;
    mcpServers: Record<string, { command?: string; env?: { TOKEN?: string } }>;
  };

  expect(result.code).toBe(0);
  expect(merged.extra).toBe(true);
  expect(merged.mcpServers.github?.command).toBe("github-mcp");
  expect(merged.mcpServers.github?.env?.TOKEN).toBe(SECRET);
  expect(merged.mcpServers["autonomous-qa"]?.command).toBe(process.execPath);
  expect(result.logs.join("\n")).not.toContain(SECRET);
  expect(result.errors.join("\n")).not.toContain(SECRET);
});

test("a missing build leaves the previous app in place", async () => {
  const home = process.env.AUTONOMOUS_QA_HOME ?? "";
  const previous = join(home, "app", "dist", "cli", "main.js");
  mkdirSync(join(home, "app", "dist", "cli"), { recursive: true });
  writeFileSync(previous, "previous\n");
  const source = mkdtempSync(join(tmpdir(), "qa-install-source-"));
  sources.push(source);

  const result = await runInstall(["--source", source, "--skip-browser"]);

  expect(result.code).toBe(1);
  expect(readFileSync(previous, "utf8")).toBe("previous\n");
  expect(statSync(join(home, "app")).isDirectory()).toBe(true);
  expect(() => lstatSync(`${join(home, "app")}.staging`)).toThrow();
});

test("install refuses to follow an env symlink and does not print the target", async () => {
  const source = await createSource("skill-v1");
  const outside = mkdtempSync(join(tmpdir(), "qa-install-secret-"));
  sources.push(outside);
  const target = join(outside, "env");
  writeFileSync(target, `COMPANY_LLM_API_KEY=${SECRET}\n`, { mode: 0o600 });
  const home = process.env.AUTONOMOUS_QA_HOME ?? "";
  mkdirSync(home, { recursive: true });
  symlinkSync(target, join(home, "env"));

  const result = await runInstall(["--source", source, "--skip-browser"]);

  expect(result.code).toBe(1);
  expect(result.errors.join("\n")).toContain("Refusing to follow a symlink");
  expect(result.logs.join("\n")).not.toContain(SECRET);
  expect(result.errors.join("\n")).not.toContain(SECRET);
  expect(lstatSync(join(home, "env")).isSymbolicLink()).toBe(true);
});

async function runInstall(
  argv: string[],
): Promise<{ code: number; logs: string[]; errors: string[] }> {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const code = await main(["install", ...argv]);
    return {
      code,
      logs: log.mock.calls.map((call) => call.map((part) => String(part)).join(" ")),
      errors: error.mock.calls.map((call) => call.map((part) => String(part)).join(" ")),
    };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

async function createSource(skill: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "qa-install-source-"));
  sources.push(parent);
  await writeFixture(join(parent, "package.json"), "{}\n");
  await writeFixture(join(parent, "dist", "cli", "main.js"), "cli\n");
  await writeFixture(join(parent, "skills", "autonomous-qa", "SKILL.md"), `${skill}\n`);
  await writeFixture(join(parent, "node_modules", "example", "index.js"), "dep\n");
  return parent;
}

async function writeFixture(path: string, contents: string): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents);
}

function restore(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = previous;
}
