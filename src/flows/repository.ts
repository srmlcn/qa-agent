import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { QaError } from "../errors/qa-error.js";
import { homeDir } from "../runtime/paths.js";
import { resolveStateLocation } from "../runtime/state-root.js";
import { flowSpecSchema, type FlowSpec } from "./schema.js";
import { parseFlow, stringifyFlow } from "./serialize.js";

/** Metadata returned by {@link list}. Step bodies are not included. */
export type FlowSummary = {
  id: string;
  name: string;
  state: FlowSpec["state"];
  authProfile?: string;
};

/**
 * Lists saved flows for a project.
 * Each item is metadata only: `id`, `name`, `state`, and `authProfile`.
 */
export function list(projectRoot: string): FlowSummary[] {
  const directory = resolveFlowsDirectory(projectRoot);
  if (!existsSync(directory)) {
    return [];
  }
  assertRealFlowsDirectory(projectRoot, directory);

  const summaries = new Map<string, { summary: FlowSummary; legacy: boolean }>();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".yml")) {
      continue;
    }
    const filePath = join(directory, entry.name);
    if (basename(filePath) !== entry.name) {
      continue;
    }
    const flow = parseFlow(readFileSync(filePath, "utf8"), "yaml");
    const legacy = isLegacyFlowFile(flow.id, entry.name);
    if (encodedFileName(flow.id) !== entry.name && !legacy) {
      continue;
    }
    const current = summaries.get(flow.id);
    if (current !== undefined && !current.legacy) {
      continue;
    }
    summaries.set(flow.id, { summary: toSummary(flow), legacy });
  }
  return [...summaries.values()]
    .map((entry) => entry.summary)
    .sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Reads one saved flow.
 * A missing file throws {@link QaError} `FLOW_VALIDATION_FAILED`.
 */
export function read(projectRoot: string, id: string): FlowSpec {
  assertFlowId(id);
  const filePath = flowFilePath(projectRoot, id);
  const flow = parseFlow(readSavedFlowText(projectRoot, id, filePath), "yaml");
  if (flow.id !== id) {
    throw flowValidationFailed(`Flow id mismatch: ${id}`, id);
  }
  return flow;
}

/**
 * Writes a flow as YAML under the project state directory.
 * A repo that already has `.autonomous-qa` keeps flows there.
 * Otherwise flows go to `~/.autonomous-qa/projects/<project-id>/flows`.
 * The serializer in `serialize.ts` produces the file contents.
 */
export function save(projectRoot: string, flow: FlowSpec): void {
  const yaml = stringifyFlow(flow, "yaml");
  const directory = ensureFlowsDirectory(projectRoot);
  const filePath = flowFilePath(projectRoot, flow.id);
  if (dirname(filePath) !== directory) {
    throw flowValidationFailed(`Invalid flow id: ${flow.id}`, flow.id);
  }
  writeAtomically(directory, filePath, yaml);
  removeReplacedLegacyFile(projectRoot, flow.id, filePath);
}

function toSummary(flow: FlowSpec): FlowSummary {
  const summary: FlowSummary = {
    id: flow.id,
    name: flow.name,
    state: flow.state,
  };
  if (flow.authProfile !== undefined) {
    summary.authProfile = flow.authProfile;
  }
  return summary;
}

function flowFilePath(projectRoot: string, id: string): string {
  return containedFlowFile(projectRoot, id, encodedFileName(id));
}

function legacyFlowFilePath(projectRoot: string, id: string): string {
  return containedFlowFile(projectRoot, id, legacyFileName(id));
}

function containedFlowFile(
  projectRoot: string,
  id: string,
  filename: string,
): string {
  const directory = resolveFlowsDirectory(projectRoot);
  const filePath = join(directory, filename);
  if (
    basename(filePath) !== filename ||
    dirname(filePath) !== directory ||
    !isInside(directory, filePath)
  ) {
    throw flowValidationFailed(`Invalid flow id: ${id}`, id);
  }
  assertNotUnderAuth(filePath);
  return filePath;
}

function encodedFileName(id: string): string {
  assertFlowId(id);
  // `project.archive` is stored as `project--archive.yml`.
  // Escape `-` to `_` before dots become `--`. `_` is outside the flow-id
  // alphabet, so `a.b.c` and `a.b--c` cannot share `a--b--c.yml`.
  return singleSegmentFileName(id, id.replaceAll("-", "_").replaceAll(".", "--"));
}

function legacyFileName(id: string): string {
  assertFlowId(id);
  // Releases before hyphen escaping stored `a.b-c` as `a--b-c.yml`.
  return singleSegmentFileName(id, id.replaceAll(".", "--"));
}

function singleSegmentFileName(id: string, stem: string): string {
  const filename = `${stem}.yml`;
  if (!isSinglePathSegment(filename)) {
    throw flowValidationFailed(`Invalid flow id: ${id}`, id);
  }
  return filename;
}

function isLegacyFlowFile(id: string, filename: string): boolean {
  return legacyFileName(id) === filename && encodedFileName(id) !== filename;
}

function assertFlowId(id: string): void {
  if (!flowSpecSchema.shape.id.safeParse(id).success) {
    throw flowValidationFailed(`Invalid flow id: ${id}`);
  }
}

function isSinglePathSegment(filename: string): boolean {
  return (
    filename.length > 0 &&
    filename !== "." &&
    filename !== ".." &&
    basename(filename) === filename &&
    !filename.includes("/") &&
    !filename.includes("\\") &&
    !filename.includes("\0")
  );
}

function resolveFlowsDirectory(projectRoot: string): string {
  const project = resolve(projectRoot);
  assertProjectAllowsFlows(project);
  const location = resolveStateLocation(project);
  const directory = resolve(location.root, "flows");
  if (!isInside(location.root, directory)) {
    throw flowValidationFailed("Invalid flows directory");
  }
  assertExistingFlowAncestors(location.containment, directory);
  assertNotUnderAuth(directory);
  return directory;
}

function ensureFlowsDirectory(projectRoot: string): string {
  const directory = resolveFlowsDirectory(projectRoot);
  try {
    mkdirSync(directory, { recursive: true });
  } catch (error) {
    if (error instanceof QaError) {
      throw error;
    }
    throw flowValidationFailed("Unable to create the flows directory");
  }
  assertRealFlowsDirectory(projectRoot, directory);
  return directory;
}

function assertProjectAllowsFlows(root: string): void {
  assertNotUnderAuth(root);
  if (existsSync(root)) {
    assertNotUnderAuth(realpathSync(root));
  }
}

function assertExistingFlowAncestors(containment: string, directory: string): void {
  const root = resolve(containment);
  const realRoot = existsSync(root) ? realpathSync(root) : root;
  let current = directory;
  while (isInside(root, current)) {
    if (entryExists(current)) {
      let realCandidate: string;
      try {
        realCandidate = realpathSync(current);
      } catch {
        throw flowValidationFailed("Flows directory escapes the project");
      }
      if (!isInside(realRoot, realCandidate)) {
        throw flowValidationFailed("Flows directory escapes the project");
      }
      assertNotUnderAuth(realCandidate);
    }
    if (current === root) {
      break;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
}

function assertRealFlowsDirectory(projectRoot: string, directory: string): void {
  const root = resolveStateLocation(projectRoot).containment;
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(directory);
  } catch (error) {
    if (isEnoent(error)) {
      throw flowValidationFailed("Flows directory is missing");
    }
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw flowValidationFailed("Flows path is not a directory");
  }
  const realDirectory = realpathSync(directory);
  const realRoot = existsSync(root) ? realpathSync(root) : root;
  if (!isInside(realRoot, realDirectory)) {
    throw flowValidationFailed("Flows directory escapes the project");
  }
  assertNotUnderAuth(realDirectory);
}

function readSavedFlowText(
  projectRoot: string,
  id: string,
  filePath: string,
): string {
  if (isRegularFile(filePath)) {
    return readFlowText(filePath, id);
  }
  const legacyPath = legacyFlowFilePath(projectRoot, id);
  if (legacyPath !== filePath && isRegularFile(legacyPath)) {
    return readFlowText(legacyPath, id);
  }
  return readFlowText(filePath, id);
}

function removeReplacedLegacyFile(
  projectRoot: string,
  id: string,
  canonicalPath: string,
): void {
  const legacyPath = legacyFlowFilePath(projectRoot, id);
  if (legacyPath === canonicalPath || !isRegularFile(legacyPath)) {
    return;
  }
  const existing = parseFlow(readFileSync(legacyPath, "utf8"), "yaml");
  if (existing.id !== id) {
    return;
  }
  unlinkSync(legacyPath);
}

function isRegularFile(filePath: string): boolean {
  try {
    const info = lstatSync(filePath);
    return !info.isSymbolicLink() && info.isFile();
  } catch (error) {
    if (isEnoent(error)) {
      return false;
    }
    throw error;
  }
}

function readFlowText(filePath: string, id: string): string {
  try {
    const info = lstatSync(filePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw missingFlow(id);
    }
    return readFileSync(filePath, "utf8");
  } catch (error) {
    if (error instanceof QaError) {
      throw error;
    }
    if (isEnoent(error)) {
      throw missingFlow(id);
    }
    throw error;
  }
}

function writeAtomically(
  directory: string,
  filePath: string,
  contents: string,
): void {
  const tempPath = join(
    directory,
    `.${basename(filePath)}.${randomBytes(16).toString("hex")}.tmp`,
  );
  if (dirname(tempPath) !== directory || !isInside(directory, tempPath)) {
    throw flowValidationFailed("Invalid flow temp path");
  }
  assertNotUnderAuth(tempPath);
  try {
    writeFileSync(tempPath, contents, { encoding: "utf8", flag: "wx" });
    renameSync(tempPath, filePath);
  } catch (error) {
    removeTemp(tempPath);
    throw error;
  }
}

function removeTemp(tempPath: string): void {
  try {
    unlinkSync(tempPath);
  } catch (error) {
    if (!isEnoent(error)) {
      throw error;
    }
  }
}

function assertNotUnderAuth(target: string): void {
  const candidates = new Set<string>([resolve(target)]);
  if (existsSync(target)) {
    candidates.add(realpathSync(target));
  }
  for (const authRoot of authRoots()) {
    const roots = new Set<string>([resolve(authRoot)]);
    if (existsSync(authRoot)) {
      roots.add(realpathSync(authRoot));
    }
    for (const candidate of candidates) {
      for (const root of roots) {
        if (isInside(root, candidate)) {
          throw flowValidationFailed(
            "Refusing to access flows under the auth directory",
          );
        }
      }
    }
  }
}

function authRoots(): string[] {
  return [join(homedir(), ".autonomous-qa", "auth"), join(homeDir(), "auth")];
}

function missingFlow(id: string): QaError {
  return flowValidationFailed(`Flow not found: ${id}`, id);
}

function flowValidationFailed(message: string, flowId?: string): QaError {
  return new QaError({
    code: "FLOW_VALIDATION_FAILED",
    message,
    ...(flowId === undefined ? {} : { flowId }),
  });
}

function isInside(parent: string, child: string): boolean {
  const root = resolve(parent);
  const target = resolve(child);
  return target === root || target.startsWith(`${root}${sep}`);
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isEnoent(error)) {
      return false;
    }
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
