import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

const HOME_ENV = "AUTONOMOUS_QA_HOME";
const PRIVATE_DIR_MODE = 0o700;

const LAYOUT_DIRECTORY_NAMES = [
  "auth",
  "cache",
  "browsers",
  "logs",
  "projects",
] as const;

export function homeDir(): string {
  const configured = process.env[HOME_ENV];
  if (configured !== undefined && configured.length > 0) {
    return resolve(configured);
  }
  return join(homedir(), ".autonomous-qa");
}

export function authDir(projectId: string): string {
  assertSafeProjectId(projectId);
  return join(homeDir(), "auth", projectId);
}

export function logsDir(): string {
  return join(homeDir(), "logs");
}

export function cacheDir(): string {
  return join(homeDir(), "cache");
}

export function browsersDir(): string {
  return join(homeDir(), "browsers");
}

export function projectsDir(): string {
  return join(homeDir(), "projects");
}

export function ensureHomeLayout(): void {
  ensurePrivateDir(homeDir());
  for (const name of LAYOUT_DIRECTORY_NAMES) {
    ensurePrivateDir(join(homeDir(), name));
  }
}

function assertSafeProjectId(projectId: string): void {
  if (
    projectId.includes("/") ||
    projectId.includes("\\") ||
    projectId.includes("..")
  ) {
    throw new Error(`Invalid project id: ${projectId}`);
  }
}

function ensurePrivateDir(path: string): void {
  const resolved = assertUnderHome(path);
  mkdirSync(resolved, { recursive: true, mode: PRIVATE_DIR_MODE });
  chmodSync(resolved, PRIVATE_DIR_MODE);
}

function assertUnderHome(path: string): string {
  const home = resolve(homeDir());
  const resolved = resolve(path);
  if (resolved !== home && !resolved.startsWith(`${home}${sep}`)) {
    throw new Error(`Refusing to create directory outside home: ${resolved}`);
  }
  return resolved;
}
