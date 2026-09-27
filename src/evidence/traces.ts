import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BrowserContext } from "playwright";
import type { ProjectConfig } from "../config/schema.js";
import { assertArtifactPath } from "./screenshots.js";

const TRACE_ZIP = "trace.zip";
const TRACE_NAME_PREFIX = "qa-";

/** v0.1 config evidence.trace. Only `on-failure` keeps a zip, and only after a failure. */
export type TraceMode = ProjectConfig["evidence"]["trace"];

export type StopTraceOptions = {
  failed: boolean;
  dest: string;
  /** Defaults to `on-failure`, the v0.1 config requirement. */
  mode?: TraceMode;
};

const inProgressNames = new WeakMap<BrowserContext, string>();

/**
 * Starts a Playwright trace when the run begins.
 * The in-progress trace is removed by {@link stopTrace}.
 */
export async function startTrace(context: BrowserContext): Promise<void> {
  const name = `${TRACE_NAME_PREFIX}${randomBytes(8).toString("hex")}`;
  inProgressNames.set(context, name);
  try {
    await context.tracing.start({
      name,
      screenshots: true,
      snapshots: true,
    });
  } catch (error) {
    inProgressNames.delete(context);
    throw error;
  }
}

/**
 * Saves `trace.zip` only when the run failed and config trace mode is
 * `on-failure`. A passed run, or trace mode `off`, deletes the in-progress
 * trace and leaves no zip. Returns the zip path. Zip bytes stay on disk.
 */
export async function stopTrace(
  context: BrowserContext,
  options: StopTraceOptions,
): Promise<string | undefined> {
  const mode = options.mode ?? "on-failure";
  const save = options.failed === true && mode === "on-failure";
  const name = inProgressNames.get(context);
  inProgressNames.delete(context);

  let saved: string | undefined;
  let failure: unknown;
  if (save) {
    try {
      saved = prepareZipPath(options.dest);
    } catch (error) {
      failure = error;
    }
  }

  let result: string | undefined;
  try {
    if (saved === undefined) {
      await context.tracing.stop();
      removeRegularFile(join(options.dest, TRACE_ZIP));
    } else {
      await context.tracing.stop({ path: saved });
      result = saved;
    }
  } catch (error) {
    if (failure === undefined) {
      failure = error;
    }
  } finally {
    if (name !== undefined) {
      deleteInProgressTrace(name);
    }
    if (failure !== undefined) {
      removeRegularFile(join(options.dest, TRACE_ZIP));
    }
  }
  if (failure !== undefined) {
    throw failure;
  }
  return result;
}

function prepareZipPath(dest: string): string {
  const filePath = assertArtifactPath(join(dest, TRACE_ZIP));
  mkdirSync(dirname(filePath), { recursive: true });
  return filePath;
}

/**
 * Playwright discards a trace that is stopped without a path, but it leaves
 * the `.trace` and `.network` files in the browser artifacts directory until
 * the browser exits. A passed run removes those files itself.
 */
function deleteInProgressTrace(name: string): void {
  const root = tmpdir();
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith("playwright-artifacts-")) {
      continue;
    }
    removeNamedTraceFiles(join(root, entry), name);
  }
  removeRegularFile(join(root, `${name}.stacks`));
}

function removeNamedTraceFiles(directory: string, name: string): void {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!isInProgressTraceFile(entry, name)) {
      continue;
    }
    removeRegularFile(join(directory, entry));
  }
}

function isInProgressTraceFile(entry: string, name: string): boolean {
  if (
    entry === `${name}.trace` ||
    entry === `${name}.network` ||
    entry === `${name}.stacks`
  ) {
    return true;
  }
  if (!entry.startsWith(`${name}-`)) {
    return false;
  }
  return (
    entry.endsWith(".trace") ||
    entry.endsWith(".network") ||
    entry.endsWith(".stacks")
  );
}

function removeRegularFile(filePath: string): void {
  let info;
  try {
    info = lstatSync(filePath);
  } catch (error) {
    if (isEnoent(error)) {
      return;
    }
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    return;
  }
  rmSync(filePath);
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
