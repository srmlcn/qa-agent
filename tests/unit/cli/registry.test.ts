import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { main } from "../../../src/cli/main.js";
import { commandsDirectory, loadCommands } from "../../../src/cli/registry.js";

test("discovers help from the real commands directory", async () => {
  const commands = await loadCommands(commandsDirectory());

  expect(commands.map((command) => command.name)).toEqual(["help", "mcp"]);
  expect(commands[0]?.summary).toBe("list available commands");
  expect(commands[1]?.summary).toBe("serve MCP tools over stdio");
});

test("unknown command path exits 1", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const log = vi.spyOn(console, "log").mockImplementation(() => {});

  try {
    const code = await main(["missing"]);

    expect(code).toBe(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith("unknown command: missing");
    expect(log).not.toHaveBeenCalled();
  } finally {
    error.mockRestore();
    log.mockRestore();
  }
});

test("help prints command names and exits 0", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});

  try {
    expect(await main([])).toBe(0);
    expect(await main(["help"])).toBe(0);
    expect(log).toHaveBeenCalledWith("help  list available commands");
  } finally {
    log.mockRestore();
  }
});

test("loads a command file written into a temp directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qa-commands-"));

  try {
    await writeFile(
      join(directory, "ignore.d.ts"),
      'export const command = { name: "ignored", summary: "skip", async run() { return 0; } };\n',
    );
    await writeFile(join(directory, "plain.ts"), "export const value = 1;\n");
    await writeFile(
      join(directory, "fixture.ts"),
      [
        "export const command = {",
        '  name: "fixture",',
        '  summary: "temporary fixture",',
        "  async run() {",
        "    return 0;",
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    const commands = await loadCommands(directory);

    expect(commands.map((command) => command.name)).toEqual(["fixture"]);
    expect(commands[0]?.summary).toBe("temporary fixture");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
