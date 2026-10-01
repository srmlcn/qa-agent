import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { main } from "../../../src/cli/main.js";
import { loadCommands } from "../../../src/cli/registry.js";
import { EXPECTED_EVIDENCE_CAPTURE } from "../../../src/config/evidence-defaults.js";
import { loadEffectiveConfig } from "../../../src/config/effective.js";
import { loadProjectConfig } from "../../../src/config/load-project.js";
import { userConfigPath } from "../../../src/config/load-user.js";

const GITIGNORE_ENTRIES = [
  ".autonomous-qa/artifacts/",
  ".autonomous-qa/runtime/",
  "playwright-report/",
  "test-results/",
] as const;

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("first run creates config and flows directory", async () => {
  const root = await createProject("widget-factory");
  const result = await runInit(root);

  expect(result.code).toBe(0);
  expect((await stat(join(root, ".autonomous-qa", "flows"))).isDirectory()).toBe(true);
  expect(JSON.parse(result.logs.join("\n"))).toEqual({
    mcpServers: {
      "autonomous-qa": {
        type: "stdio",
        command: "autonomous-qa",
        args: ["mcp"],
      },
    },
  });

  const configPath = join(root, ".autonomous-qa", "config.yml");
  const yaml = await readFile(configPath, "utf8");
  expect(yaml).toContain("recoveryEnabled: true");
  expect(yaml).toContain("workers: 4");
  expect(yaml).toContain("timeoutMs: 60000");
  expect(loadProjectConfig(root)).toEqual({
    version: 1,
    project: { id: "widget-factory" },
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
      debugTools: false,
    },
    playwright: {
      browser: "chromium",
      headless: true,
      workers: 4,
      timeoutMs: 60000,
    },
    evidence: {
      screenshots: "checkpoints",
      network: true,
      console: true,
      trace: "on-failure",
      maxResponseBodyBytes: 262144,
      ...EXPECTED_EVIDENCE_CAPTURE,
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

  const gitignore = await readFile(join(root, ".gitignore"), "utf8");
  expect(gitignore).toBe(`${GITIGNORE_ENTRIES.join("\n")}\n`);
  expect(gitignore).not.toContain(".autonomous-qa/flows/");
  expect(gitignore).not.toContain(".autonomous-qa/config.yml");
});

test("second run keeps project.id and does not duplicate gitignore lines", async () => {
  const root = await createProject("widget-factory");
  await writeFile(join(root, ".gitignore"), "dist/\n# keep\n", "utf8");

  expect((await runInit(root)).code).toBe(0);

  const configPath = join(root, ".autonomous-qa", "config.yml");
  const edited = (await readFile(configPath, "utf8")).replace(
    "id: widget-factory",
    "id: renamed-app",
  );
  await writeFile(configPath, edited, "utf8");
  await rm(join(root, ".autonomous-qa", "flows"), { recursive: true });
  const gitignoreAfterFirst = await readFile(join(root, ".gitignore"), "utf8");

  expect((await runInit(root)).code).toBe(0);

  expect(await readFile(configPath, "utf8")).toBe(edited);
  expect(loadProjectConfig(root).project.id).toBe("renamed-app");
  expect((await stat(join(root, ".autonomous-qa", "flows"))).isDirectory()).toBe(true);

  const gitignore = await readFile(join(root, ".gitignore"), "utf8");
  expect(gitignore).toBe(gitignoreAfterFirst);
  expect(gitignore.startsWith("dist/\n# keep\n")).toBe(true);
  for (const entry of GITIGNORE_ENTRIES) {
    expect(countLine(gitignore, entry)).toBe(1);
  }
  expect(gitignore).not.toContain(".autonomous-qa/flows/");
  expect(gitignore).not.toContain(".autonomous-qa/config.yml");
});

test("project.id is sanitized from the directory name", async () => {
  const spaced = await createProject("My Widget");
  expect((await runInit(spaced)).code).toBe(0);
  expect(loadProjectConfig(spaced).project.id).toBe("my-widget");

  const longRoot = await createProject("A".repeat(80));
  expect((await runInit(longRoot)).code).toBe(0);
  expect(loadProjectConfig(longRoot).project.id).toBe("a".repeat(63));

  const symbols = await createProject("@@@");
  expect((await runInit(symbols)).code).toBe(0);
  expect(loadProjectConfig(symbols).project.id).toBe("project");
});

test("--install-mcp keeps an unrelated server entry", async () => {
  const root = await createProject("widget-factory");
  const mcpPath = join(root, ".cursor", "mcp.json");
  await mkdir(join(root, ".cursor"));
  const original = {
    mcpServers: {
      github: {
        command: "github-mcp",
        args: ["serve"],
        env: { TOKEN: "keep-me" },
      },
    },
    extra: true,
  };
  await writeFile(mcpPath, JSON.stringify(original), "utf8");

  const result = await runInit(root, ["--install-mcp"]);

  expect(result.code).toBe(0);
  expect(result.errors).toEqual([]);
  const merged = JSON.parse(await readFile(mcpPath, "utf8")) as {
    extra: boolean;
    mcpServers: Record<string, unknown>;
  };
  expect(merged.extra).toBe(true);
  expect(merged.mcpServers.github).toEqual(original.mcpServers.github);
  expect(merged.mcpServers["autonomous-qa"]).toEqual({
    type: "stdio",
    command: "autonomous-qa",
    args: ["mcp"],
  });
});

test("--install-mcp leaves an existing autonomous-qa server unchanged", async () => {
  const root = await createProject("widget-factory");
  const mcpPath = join(root, ".cursor", "mcp.json");
  await mkdir(join(root, ".cursor"));
  const original = `${JSON.stringify(
    {
      mcpServers: {
        github: { command: "github-mcp" },
        "autonomous-qa": { command: "custom-qa", args: ["stay"] },
      },
    },
    null,
    2,
  )}\n`;
  await writeFile(mcpPath, original, "utf8");

  const result = await runInit(root, ["--install-mcp"]);

  expect(result.code).toBe(0);
  expect(result.errors).toEqual(["kept existing autonomous-qa MCP server"]);
  expect(await readFile(mcpPath, "utf8")).toBe(original);
});

test("init omits llm when the user config is already complete", async () => {
  const root = await createProject("widget-factory");
  const home = await mkdtemp(join(tmpdir(), "qa-init-home-"));
  roots.push(home);
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(home, { recursive: true });
  await writeFile(
    userConfigPathFor(home),
    JSON.stringify({
      llm: {
        provider: "openai",
        model: "user-model",
        apiKeyEnv: "USER_LLM_API_KEY",
        timeoutMs: 1500,
      },
    }),
  );

  const result = await runInit(root, [], home);
  const yaml = await readFile(join(root, ".autonomous-qa", "config.yml"), "utf8");

  expect(result.code).toBe(0);
  expect(yaml).not.toMatch(/^llm:/m);
  const previousHome = process.env.AUTONOMOUS_QA_HOME;
  process.env.AUTONOMOUS_QA_HOME = home;
  try {
    expect(loadEffectiveConfig(root).config.llm).toMatchObject({
      provider: "openai",
      model: "user-model",
      apiKeyEnv: "USER_LLM_API_KEY",
      timeoutMs: 1500,
    });
  } finally {
    if (previousHome === undefined) {
      delete process.env.AUTONOMOUS_QA_HOME;
    } else {
      process.env.AUTONOMOUS_QA_HOME = previousHome;
    }
  }
});

test("init appears in help via autoload", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});

  try {
    const commands = await loadCommands();
    expect(commands.map((item) => item.name)).toEqual([
      "auth",
      "doctor",
      "help",
      "init",
      "install",
      "mcp",
    ]);
    expect(await main([])).toBe(0);
    expect(await main(["help"])).toBe(0);
    expect(log).toHaveBeenCalledWith("init  create project config and flows directory");
  } finally {
    log.mockRestore();
  }
});

function userConfigPathFor(home: string): string {
  const previous = process.env.AUTONOMOUS_QA_HOME;
  process.env.AUTONOMOUS_QA_HOME = home;
  try {
    return userConfigPath();
  } finally {
    if (previous === undefined) {
      delete process.env.AUTONOMOUS_QA_HOME;
    } else {
      process.env.AUTONOMOUS_QA_HOME = previous;
    }
  }
}

async function runInit(
  root: string,
  argv: string[] = [],
  home: string = "",
): Promise<{ code: number; logs: string[]; errors: string[] }> {
  const previous = process.cwd();
  const previousHome = process.env.AUTONOMOUS_QA_HOME;
  const isolatedHome = home.length > 0 ? home : await mkdtemp(join(tmpdir(), "qa-init-home-"));
  if (home.length === 0) {
    roots.push(isolatedHome);
  }
  process.env.AUTONOMOUS_QA_HOME = isolatedHome;
  process.chdir(root);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});

  try {
    const code = await main(["init", ...argv]);
    return {
      code,
      logs: log.mock.calls.map((call) => call.map((part) => String(part)).join(" ")),
      errors: error.mock.calls.map((call) => call.map((part) => String(part)).join(" ")),
    };
  } finally {
    log.mockRestore();
    error.mockRestore();
    process.chdir(previous);
    if (previousHome === undefined) {
      delete process.env.AUTONOMOUS_QA_HOME;
    } else {
      process.env.AUTONOMOUS_QA_HOME = previousHome;
    }
  }
}

async function createProject(directoryName: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "qa-init-"));
  roots.push(parent);
  const root = join(parent, directoryName);
  await mkdir(root);
  return root;
}

function countLine(source: string, entry: string): number {
  return source.split(/\r?\n/).filter((line) => line.trim() === entry).length;
}
