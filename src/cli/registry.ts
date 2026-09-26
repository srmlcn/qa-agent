import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Command } from "./types.js";

const moduleExtension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";

export function commandsDirectory(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "commands");
}

function isCommand(value: unknown): value is Command {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.summary === "string" &&
    typeof candidate.run === "function"
  );
}

function isCommandModule(filename: string): boolean {
  if (filename.endsWith(".d.ts")) {
    return false;
  }

  return filename.endsWith(moduleExtension);
}

export async function loadCommands(
  directory: string = commandsDirectory(),
): Promise<Command[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const filenames = entries
    .filter((entry) => entry.isFile() && isCommandModule(entry.name))
    .map((entry) => entry.name)
    .sort();

  const commands: Command[] = [];
  for (const filename of filenames) {
    const moduleUrl = pathToFileURL(join(directory, filename)).href;
    const loaded = (await import(moduleUrl)) as { command?: unknown };
    if (isCommand(loaded.command)) {
      commands.push(loaded.command);
    }
  }

  commands.sort((left, right) => {
    if (left.name < right.name) {
      return -1;
    }
    if (left.name > right.name) {
      return 1;
    }
    return 0;
  });
  return commands;
}
