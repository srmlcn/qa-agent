import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { userEnvPath } from "./paths.js";

const PRIVATE_FILE_MODE = 0o600;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Loads `~/.autonomous-qa/env` into `process.env` for names that are still unset.
 * Empty values are skipped. The file contents are never logged.
 * A symlink or a file that group or other can read is left unloaded.
 */
export function loadUserEnv(): void {
  const source = readPrivateEnv(userEnvPath());
  if (source === undefined) {
    return;
  }
  for (const assignment of parseEnvAssignments(source)) {
    if (process.env[assignment.name] !== undefined) {
      continue;
    }
    process.env[assignment.name] = assignment.value;
  }
}

/** Creates a mode-0600 env file. Fails if the path already exists or is a symlink. */
export function writePrivateEnvFile(filePath: string, contents: string): void {
  refuseExisting(filePath);
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, contents, {
    encoding: "utf8",
    mode: PRIVATE_FILE_MODE,
    flag: "wx",
  });
  chmodSync(filePath, PRIVATE_FILE_MODE);
}

export function parseEnvAssignments(
  source: string,
): readonly { name: string; value: string }[] {
  const assignments: { name: string; value: string }[] = [];
  for (const line of source.split(/\r?\n/)) {
    const assignment = parseEnvLine(line);
    if (assignment !== undefined) {
      assignments.push(assignment);
    }
  }
  return assignments;
}

function readPrivateEnv(filePath: string): string | undefined {
  let info;
  try {
    info = lstatSync(filePath);
  } catch (error: unknown) {
    if (isEnoent(error)) {
      return undefined;
    }
    throw error;
  }
  if (!isPrivateRegularFile(info)) {
    console.error(`Refusing to load env file at ${filePath}`);
    return undefined;
  }
  return readFileSync(filePath, "utf8");
}

function refuseExisting(filePath: string): void {
  try {
    const info = lstatSync(filePath);
    if (info.isSymbolicLink()) {
      throw new Error(`Refusing to follow a symlink: ${filePath}`);
    }
    throw new Error(`Env file already exists: ${filePath}`);
  } catch (error: unknown) {
    if (isEnoent(error)) {
      return;
    }
    throw error;
  }
}

function isPrivateRegularFile(info: { isSymbolicLink(): boolean; isFile(): boolean; mode: number }): boolean {
  if (info.isSymbolicLink() || !info.isFile()) {
    return false;
  }
  if (process.platform === "win32") {
    return true;
  }
  return (info.mode & 0o077) === 0;
}

function parseEnvLine(line: string): { name: string; value: string } | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) {
    return undefined;
  }
  const separator = trimmed.indexOf("=");
  if (separator <= 0) {
    return undefined;
  }
  const name = trimmed.slice(0, separator);
  if (!ENV_NAME.test(name)) {
    return undefined;
  }
  let value = trimmed.slice(separator + 1);
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1);
  }
  if (value.length === 0) {
    return undefined;
  }
  return { name, value };
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
