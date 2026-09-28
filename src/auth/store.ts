import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { QaError } from "../errors/qa-error.js";
import { authDir, homeDir } from "../runtime/paths.js";

/**
 * Auth profiles live under the home directory, never in the project repository.
 * Profile files are mode 0600. Directories that contain them are mode 0700.
 */

const PROFILE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export type StorageStateCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
};

export type StorageStateOrigin = {
  origin: string;
  localStorage: Array<{
    name: string;
    value: string;
  }>;
};

/** Playwright storage-state JSON kept outside the repository. */
export type StorageState = {
  cookies: StorageStateCookie[];
  origins: StorageStateOrigin[];
};

export type SaveProfileOptions = {
  /** Refuse to write when the profile path resolves inside this project root. */
  projectRoot?: string;
};

/** Callers receive the profile name and path, never the storage-state document. */
export type SavedProfile = {
  profile: string;
  path: string;
};

export function saveProfile(
  projectId: string,
  profile: string,
  storageState: StorageState,
  options: SaveProfileOptions = {},
): SavedProfile {
  const filePath = profileFile(projectId, profile);
  assertStorageState(storageState);
  assertOutsideProject(filePath, options.projectRoot);
  ensurePrivateDirectory(dirname(filePath));
  assertUnderHome(filePath);
  assertOutsideProject(filePath, options.projectRoot);
  assertWritableTarget(filePath);
  writePrivateFile(filePath, `${JSON.stringify(storageState, null, 2)}\n`);
  // Callers must not print the return value of readProfile.
  return { profile, path: filePath };
}

/**
 * Path of a saved profile. Does not read or return the storage-state JSON.
 * Throws AUTH_MISSING when the file is absent.
 */
export function readProfilePath(projectId: string, profile: string): string {
  const filePath = profileFile(projectId, profile);
  requireRegularFile(filePath);
  return filePath;
}

/**
 * Parsed storage state for an in-process browser launcher.
 * Callers must not print the return value of readProfile.
 */
export function readProfile(projectId: string, profile: string): StorageState {
  const text = readProfileFile(profileFile(projectId, profile));
  let parsed: unknown;
  try {
    parsed = parseJson(text);
  } catch {
    throw invalidStorageState();
  }
  assertStorageState(parsed);
  return parsed;
}

/** Profile names only. Cookie values are never read or returned. */
export function listProfiles(projectId: string): string[] {
  const directory = profileDirectory(projectId);
  if (!existsSync(directory)) {
    return [];
  }
  const info = lstatSync(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new QaError({
      code: "POLICY_BLOCKED",
      message: "Refusing to list an auth path that is not a directory",
    });
  }
  assertUnderHome(directory);

  const names: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    const profile = profileNameFromFile(entry.name);
    if (profile !== undefined) {
      names.push(profile);
    }
  }
  names.sort();
  return names;
}

export function deleteProfile(projectId: string, profile: string): void {
  const filePath = profileFile(projectId, profile);
  requireRegularFile(filePath);
  unlinkSync(filePath);
}

function profileDirectory(projectId: string): string {
  assertProjectId(projectId);
  const directory = resolve(authDir(projectId));
  const expected = resolve(homeDir(), "auth", projectId);
  if (directory !== expected) {
    throw new QaError({
      code: "POLICY_BLOCKED",
      message: "Invalid project id",
    });
  }
  assertUnderHome(directory);
  return directory;
}

function profileFile(projectId: string, profile: string): string {
  assertProfileName(profile);
  const directory = profileDirectory(projectId);
  const filePath = resolve(directory, `${profile}.json`);
  if (
    dirname(filePath) !== directory ||
    basename(filePath) !== `${profile}.json`
  ) {
    throw new QaError({
      code: "POLICY_BLOCKED",
      message: "Invalid auth profile path",
    });
  }
  assertUnderHome(filePath);
  return filePath;
}

function assertProjectId(projectId: string): void {
  if (
    projectId.length === 0 ||
    projectId === "." ||
    projectId.includes("/") ||
    projectId.includes("\\") ||
    projectId.includes("..") ||
    projectId.includes("\0")
  ) {
    throw new QaError({
      code: "POLICY_BLOCKED",
      message: "Invalid project id",
    });
  }
}

function assertProfileName(profile: string): void {
  if (!PROFILE_NAME.test(profile)) {
    throw new QaError({
      code: "POLICY_BLOCKED",
      message: "Invalid auth profile name",
    });
  }
}

function assertUnderHome(path: string): void {
  const roots = homeRoots();
  for (const target of pathVariants(path)) {
    const allowed = roots.some((root) => isInsidePath(target, root));
    if (!allowed) {
      throw new QaError({
        code: "POLICY_BLOCKED",
        message: "Refusing to access an auth path outside the home directory",
      });
    }
  }
}

function assertOutsideProject(
  path: string,
  projectRoot: string | undefined,
): void {
  for (const target of pathVariants(path)) {
    for (const root of blockedRoots(projectRoot)) {
      if (isInsidePath(target, root)) {
        throw new QaError({
          code: "POLICY_BLOCKED",
          message: "Refusing to store an auth profile inside the project",
        });
      }
    }
  }
}

function assertWritableTarget(filePath: string): void {
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(filePath);
  } catch (error) {
    if (isNotFound(error)) {
      return;
    }
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new QaError({
      code: "POLICY_BLOCKED",
      message: "Refusing to write an auth profile that is not a regular file",
    });
  }
}

/**
 * Opens the profile once. The descriptor is checked before any byte is read,
 * so a symlink cannot be swapped in between a pathname check and the read.
 */
function readProfileFile(filePath: string): string {
  let fd: number;
  try {
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNotFound(error)) {
      throw missingProfile();
    }
    if (isTooManyLinks(error)) {
      throw notRegularFile();
    }
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw notRegularFile();
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function requireRegularFile(filePath: string): void {
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(filePath);
  } catch (error) {
    if (isNotFound(error)) {
      throw missingProfile();
    }
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw notRegularFile();
  }
  assertUnderHome(filePath);
}

function ensurePrivateDirectory(directory: string): void {
  const home = resolve(homeDir());
  assertUnderHome(directory);
  mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
  chmodSync(home, DIRECTORY_MODE);
  const fromHome = relative(home, resolve(directory));
  if (fromHome === "") {
    return;
  }
  if (fromHome.startsWith("..") || fromHome.split(sep).includes("..")) {
    throw new QaError({
      code: "POLICY_BLOCKED",
      message: "Refusing to create an auth directory outside the home directory",
    });
  }
  let current = home;
  for (const part of fromHome.split(sep)) {
    if (part.length === 0 || part === "." || part === "..") {
      throw new QaError({
        code: "POLICY_BLOCKED",
        message:
          "Refusing to create an auth directory outside the home directory",
      });
    }
    current = join(current, part);
    chmodSync(current, DIRECTORY_MODE);
  }
}

function writePrivateFile(filePath: string, contents: string): void {
  const tempPath = join(
    dirname(filePath),
    `.${randomBytes(16).toString("hex")}.tmp`,
  );
  const fd = openSync(tempPath, "wx", FILE_MODE);
  try {
    chmodSync(tempPath, FILE_MODE);
    writeSync(fd, contents);
  } catch (error) {
    closeSync(fd);
    removeTemp(tempPath);
    throw error;
  }
  closeSync(fd);
  try {
    chmodSync(tempPath, FILE_MODE);
    renameSync(tempPath, filePath);
    chmodSync(filePath, FILE_MODE);
  } catch (error) {
    removeTemp(tempPath);
    throw error;
  }
}

function removeTemp(tempPath: string): void {
  try {
    unlinkSync(tempPath);
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
}

function homeRoots(): string[] {
  const home = resolve(homeDir());
  const roots = new Set<string>([home, logicalRealPath(home)]);
  if (existsSync(home)) {
    roots.add(realpathSync(home));
  }
  return [...roots];
}

function blockedRoots(projectRoot: string | undefined): string[] {
  const roots = new Set<string>(expandPath(process.cwd()));
  if (projectRoot !== undefined && projectRoot.length > 0) {
    for (const root of expandPath(projectRoot)) {
      roots.add(root);
    }
  }
  return [...roots];
}

function expandPath(path: string): string[] {
  const resolved = resolve(path);
  const paths = new Set<string>([resolved, logicalRealPath(resolved)]);
  if (existsSync(resolved)) {
    paths.add(realpathSync(resolved));
  }
  return [...paths];
}

function pathVariants(path: string): string[] {
  const resolved = resolve(path);
  return [...new Set([resolved, logicalRealPath(resolved)])];
}

function logicalRealPath(path: string): string {
  const resolved = resolve(path);
  const missing: string[] = [];
  let current = resolved;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    missing.push(basename(current));
    current = parent;
  }
  let real = existsSync(current) ? realpathSync(current) : current;
  for (const part of missing.reverse()) {
    real = join(real, part);
  }
  return real;
}

function isInsidePath(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

function profileNameFromFile(filename: string): string | undefined {
  const extension = ".json";
  if (!filename.endsWith(extension)) {
    return undefined;
  }
  const profile = filename.slice(0, -extension.length);
  if (!PROFILE_NAME.test(profile)) {
    return undefined;
  }
  return profile;
}

function notRegularFile(): QaError {
  return new QaError({
    code: "POLICY_BLOCKED",
    message: "Refusing to use an auth path that is not a regular file",
  });
}

function missingProfile(): QaError {
  return new QaError({
    code: "AUTH_MISSING",
    message: "Auth profile is missing",
  });
}

function invalidStorageState(): QaError {
  return new QaError({
    code: "POLICY_BLOCKED",
    message: "Auth profile is not valid storage state",
  });
}

function assertStorageState(value: unknown): asserts value is StorageState {
  if (!isStorageState(value)) {
    throw invalidStorageState();
  }
}

function isStorageState(value: unknown): value is StorageState {
  if (!isRecord(value)) {
    return false;
  }
  return (
    Array.isArray(value.cookies) &&
    value.cookies.every(isCookie) &&
    Array.isArray(value.origins) &&
    value.origins.every(isOrigin)
  );
}

function isCookie(value: unknown): value is StorageStateCookie {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.name === "string" &&
    typeof value.value === "string" &&
    typeof value.domain === "string" &&
    typeof value.path === "string" &&
    typeof value.expires === "number" &&
    Number.isFinite(value.expires) &&
    typeof value.httpOnly === "boolean" &&
    typeof value.secure === "boolean" &&
    isSameSite(value.sameSite)
  );
}

function isOrigin(value: unknown): value is StorageStateOrigin {
  if (!isRecord(value) || typeof value.origin !== "string") {
    return false;
  }
  return (
    Array.isArray(value.localStorage) &&
    value.localStorage.every(isLocalStorageItem)
  );
}

function isLocalStorageItem(
  value: unknown,
): value is { name: string; value: string } {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.name === "string" && typeof value.value === "string";
}

function isSameSite(value: unknown): value is StorageStateCookie["sameSite"] {
  return value === "Strict" || value === "Lax" || value === "None";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isTooManyLinks(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ELOOP";
}
