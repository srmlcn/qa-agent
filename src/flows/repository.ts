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
import { flowSpecSchema, type FlowSpec } from "./schema.js";
import { parseFlow, stringifyFlow } from "./serialize.js";

/** Metadata returned by {@link list}. Step bodies are not included. */
export type FlowSummary = {
  id: string;
  name: string;
  state: FlowSpec["state"];
  authProfile?: string;
};

const FLOWS_SEGMENTS = [".autonomous-qa", "flows"] as const;

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

  const summaries: FlowSummary[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".yml")) {
      continue;
    }
    const filePath = join(directory, entry.name);
    if (basename(filePath) !== entry.name) {
      continue;
    }
    const flow = parseFlow(readFileSync(filePath, "utf8"), "yaml");
    if (encodedFileName(flow.id) !== entry.name) {
      continue;
    }
    summaries.push(toSummary(flow));
  }
  summaries.sort((left, right) => left.id.localeCompare(right.id));
  return summaries;
}

/**
 * Reads one saved flow.
 * A missing file throws {@link QaError} `FLOW_VALIDATION_FAILED`.
 */
export function read(projectRoot: string, id: string): FlowSpec {
  assertFlowId(id);
  const filePath = flowFilePath(projectRoot, id);
  const flow = parseFlow(readFlowText(filePath, id), "yaml");
  if (flow.id !== id) {
    throw flowValidationFailed(`Flow id mismatch: ${id}`, id);
  }
  return flow;
}

/**
 * Writes a flow as YAML under `<projectRoot>/.autonomous-qa/flows`.
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
  const directory = resolveFlowsDirectory(projectRoot);
  const filename = encodedFileName(id);
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
  const filename = `${id.replaceAll("-", "_").replaceAll(".", "--")}.yml`;
  if (!isSinglePathSegment(filename)) {
    throw flowValidationFailed(`Invalid flow id: ${id}`, id);
  }
  return filename;
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
  const root = resolve(projectRoot);
  const directory = resolve(root, ...FLOWS_SEGMENTS);
  if (!isInside(root, directory)) {
    throw flowValidationFailed("Invalid flows directory");
  }
  assertProjectAllowsFlows(root);
  assertExistingFlowAncestors(root, directory);
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

function assertExistingFlowAncestors(root: string, directory: string): void {
  const realRoot = existsSync(root) ? realpathSync(root) : root;
  const parent = join(root, FLOWS_SEGMENTS[0]);
  for (const candidate of [parent, directory]) {
    if (!existsSync(candidate)) {
      continue;
    }
    const realCandidate = realpathSync(candidate);
    if (!isInside(realRoot, realCandidate)) {
      throw flowValidationFailed("Flows directory escapes the project");
    }
    assertNotUnderAuth(realCandidate);
  }
}

function assertRealFlowsDirectory(projectRoot: string, directory: string): void {
  const root = resolve(projectRoot);
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

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
