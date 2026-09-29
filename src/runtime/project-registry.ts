import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { ensureHomeLayout, projectRegistryPath } from "./paths.js";

const PRIVATE_FILE_MODE = 0o600;

/** Appends a repo path for a project id. A repeated path is left as-is. */
export function recordProjectRoot(projectId: string, projectRoot: string): void {
  const registry = readRegistry();
  const resolved = resolve(projectRoot);
  const paths = registry[projectId] ?? [];
  if (paths.includes(resolved)) {
    return;
  }
  registry[projectId] = [...paths, resolved];
  writeRegistry(registry);
}

/** Paths already recorded for this id, excluding the current repo. */
export function otherProjectPaths(
  projectId: string,
  projectRoot: string,
): readonly string[] {
  const resolved = resolve(projectRoot);
  return (readRegistry()[projectId] ?? []).filter((path) => path !== resolved);
}

function readRegistry(): Record<string, string[]> {
  const filePath = projectRegistryPath();
  let info;
  try {
    info = lstatSync(filePath);
  } catch (error: unknown) {
    if (isEnoent(error)) {
      return {};
    }
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Refusing to read project registry at ${filePath}`);
  }
  return parseRegistry(readFileSync(filePath, "utf8"), filePath);
}

function parseRegistry(source: string, filePath: string): Record<string, string[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    throw new Error(`Invalid project registry at ${filePath}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Invalid project registry at ${filePath}`);
  }
  const registry: Record<string, string[]> = {};
  for (const [id, value] of Object.entries(parsed)) {
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      throw new Error(`Invalid project registry at ${filePath}`);
    }
    registry[id] = value;
  }
  return registry;
}

function writeRegistry(registry: Record<string, string[]>): void {
  ensureHomeLayout();
  const filePath = projectRegistryPath();
  refuseSymlink(filePath);
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, `${JSON.stringify(registry, null, 2)}\n`, {
    encoding: "utf8",
    mode: PRIVATE_FILE_MODE,
  });
  chmodSync(filePath, PRIVATE_FILE_MODE);
}

function refuseSymlink(filePath: string): void {
  try {
    if (lstatSync(filePath).isSymbolicLink()) {
      throw new Error(`Refusing to follow a symlink: ${filePath}`);
    }
  } catch (error: unknown) {
    if (isEnoent(error)) {
      return;
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
