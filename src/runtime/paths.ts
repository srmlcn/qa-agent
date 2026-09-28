import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";
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
    projectId.length === 0 ||
    projectId === "." ||
    projectId.includes("/") ||
    projectId.includes("\\") ||
    projectId.includes("..")
  ) {
    throw new Error(`Invalid project id: ${projectId}`);
  }
}

function ensurePrivateDir(path: string): void {
  const resolved = assertUnderHome(path);
  refuseSymlink(resolved);
  mkdirSync(resolved, { recursive: true, mode: PRIVATE_DIR_MODE });
  const realHome = realpathSync(resolve(homeDir()));
  const real = realpathSync(resolved);
  if (real !== realHome && !real.startsWith(`${realHome}${sep}`)) {
    throw new Error(`Refusing to create directory outside home: ${real}`);
  }
  chmodPrivateDir(resolved);
}

function chmodPrivateDir(path: string): void {
  // fchmodSync is not implemented on Windows, and O_NOFOLLOW is not enforced there.
  if (process.platform === "win32") {
    chmodPrivateDirWindows(path);
    return;
  }
  chmodPrivateDirPosix(path);
}

function chmodPrivateDirPosix(path: string): void {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fchmodSync(fd, PRIVATE_DIR_MODE);
  } finally {
    closeSync(fd);
  }
}

function chmodPrivateDirWindows(path: string): void {
  const realHome = realpathSync(resolve(homeDir()));
  const real = realpathSync(path);
  if (real !== realHome && !real.startsWith(`${realHome}${sep}`)) {
    return;
  }
  if (lstatSync(path).isSymbolicLink()) {
    return;
  }
  chmodSync(path, PRIVATE_DIR_MODE);
}

function refuseSymlink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`Refusing to follow a symlink: ${path}`);
    }
  } catch (error) {
    if (isEnoent(error)) {
      return;
    }
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function assertUnderHome(path: string): string {
  const home = resolve(homeDir());
  const resolved = resolve(path);
  if (resolved !== home && !resolved.startsWith(`${home}${sep}`)) {
    throw new Error(`Refusing to create directory outside home: ${resolved}`);
  }
  return resolved;
}
