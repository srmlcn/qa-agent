#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadUserEnv } from "../runtime/user-env.js";
import { loadCommands } from "./registry.js";
import type { Command } from "./types.js";

function printCommands(commands: readonly Command[]): void {
  for (const command of commands) {
    console.log(`${command.name}  ${command.summary}`);
  }
}

export async function main(argv: string[]): Promise<number> {
  loadUserEnv();
  const commands = await loadCommands();
  const [name] = argv;

  if (name === undefined || name === "help") {
    printCommands(commands);
    return 0;
  }

  const command = commands.find((candidate) => candidate.name === name);
  if (!command) {
    console.error(`unknown command: ${name}`);
    return 1;
  }

  return command.run(argv.slice(1));
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }

  try {
    return import.meta.url === pathToFileURL(realpathSync(resolve(entry))).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exitCode = 1;
    });
}
