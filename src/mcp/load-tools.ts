import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ZodTypeAny } from "zod";

const moduleExtension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";

export type McpTool = {
  name: string;
  description: string;
  schema: ZodTypeAny;
  handler(args: unknown): Promise<unknown> | unknown;
};

export function toolsDirectory(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "tools");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isZodSchema(value: unknown): value is ZodTypeAny {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.parse === "function" && typeof value.safeParse === "function";
}

function isTool(value: unknown): value is McpTool {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    isZodSchema(value.schema) &&
    typeof value.handler === "function"
  );
}

function isToolModule(filename: string): boolean {
  if (filename.endsWith(".d.ts")) {
    return false;
  }
  return filename.endsWith(moduleExtension);
}

export async function loadTools(
  directory: string = toolsDirectory(),
): Promise<McpTool[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const filenames = entries
    .filter((entry) => entry.isFile() && isToolModule(entry.name))
    .map((entry) => entry.name)
    .sort();

  const tools: McpTool[] = [];
  for (const filename of filenames) {
    const moduleUrl = pathToFileURL(join(directory, filename)).href;
    const loaded = (await import(moduleUrl)) as { tool?: unknown };
    if (isTool(loaded.tool)) {
      tools.push(loaded.tool);
    }
  }

  tools.sort((left, right) => {
    if (left.name < right.name) {
      return -1;
    }
    if (left.name > right.name) {
      return 1;
    }
    return 0;
  });
  return tools;
}
