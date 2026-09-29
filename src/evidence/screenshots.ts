import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { Page } from "playwright";
import type { ProjectConfig } from "../config/schema.js";
import { QaError } from "../errors/qa-error.js";
import type { FlowSpec, Locator } from "../flows/schema.js";
import {
  ensureMouseTracking,
  injectCursorOverlay,
  removeCursorOverlay,
  resolveCursorAnchor,
} from "../playwright/cursor.js";
import { homeDir } from "../runtime/paths.js";

export type ScreenshotCaptureContext = {
  projectEvidence?: ProjectConfig["evidence"];
  stepAction?: string;
  stepLocator?: Locator;
  isFailure?: boolean;
};

export function resolveScreenshotPlan(
  evidence: ProjectConfig["evidence"],
): ProjectConfig["evidence"]["screenshotOptions"] {
  return evidence.screenshotOptions;
}

export type ShouldShowCursorInput = {
  cursor: ProjectConfig["evidence"]["cursor"];
  stepAction?: string;
  stepLocator?: Locator;
  isFailure?: boolean;
  showCursorOverride?: boolean;
};

export function shouldShowCursor(input: ShouldShowCursorInput): boolean {
  if (input.showCursorOverride === true) {
    return true;
  }
  if (input.showCursorOverride === false) {
    return false;
  }
  if (input.cursor.mode === "never") {
    return false;
  }
  if (input.cursor.mode === "always") {
    return true;
  }
  if (input.isFailure === true && input.cursor.showOnFailure) {
    return true;
  }
  const action = input.stepAction;
  if (
    action !== undefined &&
    input.cursor.showOnActions.includes(
      action as ProjectConfig["evidence"]["cursor"]["showOnActions"][number],
    )
  ) {
    return true;
  }
  if (
    action === "waitFor" &&
    input.stepLocator !== undefined &&
    input.cursor.showOnLocatorWait
  ) {
    return true;
  }
  if (
    input.cursor.showOnLowSemanticLocator &&
    isLowSemanticLocator(input.stepLocator)
  ) {
    return true;
  }
  return false;
}

function isLowSemanticLocator(locator?: Locator): boolean {
  return locator?.type === "css" || locator?.type === "xpath";
}

/** Step ids used as filenames. Anything else is rejected. */
const STEP_ID_PATTERN = /^[a-z0-9-]+$/;

const COOKIE_JAR_NAMES = new Set([
  "cookies.json",
  "cookie-jar.json",
  "cookiejar.json",
]);

/**
 * Writes `<stepId>.png` when `stepId` is listed in the flow's
 * `evidence.screenshots`. Returns that path. An unlisted step writes nothing.
 * Image bytes stay on disk.
 */
export async function screenshotAfter(
  page: Page,
  stepId: string,
  destDir: string,
  evidence: FlowSpec["evidence"],
  capture?: ScreenshotCaptureContext,
): Promise<string | undefined> {
  if (!isListed(evidence, stepId)) {
    return undefined;
  }
  assertStepFileName(stepId);
  const filePath = assertArtifactPath(join(destDir, `${stepId}.png`));
  mkdirSync(dirname(filePath), { recursive: true });

  const projectEvidence = capture?.projectEvidence;
  const screenshotOptions =
    projectEvidence === undefined
      ? undefined
      : resolveScreenshotPlan(projectEvidence);
  if (screenshotOptions !== undefined) {
    await settlePageForScreenshot(page, screenshotOptions);
  }

  const showCursor =
    projectEvidence === undefined
      ? false
      : shouldShowCursor({
          cursor: projectEvidence.cursor,
          stepAction: capture?.stepAction,
          stepLocator: capture?.stepLocator,
          isFailure: capture?.isFailure,
          showCursorOverride: showCursorOverride(evidence, stepId),
        });

  let captured = false;
  try {
    if (showCursor) {
      await ensureMouseTracking(page);
      const anchor = await resolveCursorAnchor(page, capture?.stepLocator);
      if (anchor !== undefined) {
        await injectCursorOverlay(page, anchor);
      }
    }
    const bytes = await page.screenshot({
      type: "png",
      ...(screenshotOptions === undefined
        ? {}
        : {
            animations: screenshotOptions.animations,
            caret: screenshotOptions.caret,
            fullPage: screenshotOptions.fullPage,
          }),
    });
    writeScreenshotBytes(filePath, bytes);
    captured = true;
    return filePath;
  } finally {
    if (showCursor) {
      await removeCursorOverlay(page).catch(() => {
        // Screenshot result must not depend on overlay cleanup.
      });
    }
    if (!captured) {
      removeCreatedFile(filePath);
    }
  }
}

async function settlePageForScreenshot(
  page: Page,
  options: ProjectConfig["evidence"]["screenshotOptions"],
): Promise<void> {
  try {
    await page.waitForLoadState("load", { timeout: options.loadTimeoutMs });
  } catch {
    // Continue when load does not finish in time.
  }
  if (options.waitForLoadState === "networkidle") {
    try {
      await page.waitForLoadState("networkidle", {
        timeout: options.networkIdleTimeoutMs,
      });
    } catch {
      // SPA polling may never reach networkidle.
    }
  } else if (options.waitForLoadState === "domcontentloaded") {
    try {
      await page.waitForLoadState("domcontentloaded", {
        timeout: options.loadTimeoutMs,
      });
    } catch {
      // Best effort.
    }
  } else if (options.waitForLoadState === "load") {
    try {
      await page.waitForLoadState("load", { timeout: options.loadTimeoutMs });
    } catch {
      // Best effort.
    }
  }
  if (options.settleDelayMs > 0) {
    await page.waitForTimeout(options.settleDelayMs);
  }
}

function showCursorOverride(
  evidence: FlowSpec["evidence"],
  stepId: string,
): boolean | undefined {
  const shots = evidence?.screenshots;
  if (shots === undefined) {
    return undefined;
  }
  const entry = shots.find((shot) => shot.after === stepId);
  return entry?.showCursor;
}

/**
 * Writes `bytes` at `filePath` without following a symlink.
 * POSIX opens with O_CREAT|O_EXCL|O_NOFOLLOW. Windows does not enforce
 * O_NOFOLLOW, so the destination and its nearest existing ancestor are
 * lstat'd immediately before the open. After the write, the real path must
 * still sit inside the artifact directory and outside the auth home.
 */
function writeScreenshotBytes(filePath: string, bytes: Buffer): void {
  const resolved = resolve(filePath);
  const fd = openScreenshotExclusive(resolved);
  try {
    if (isSymbolicLink(resolved) || !fstatSync(fd).isFile()) {
      throw artifactBlocked("Refusing a symlinked artifact path");
    }
    writeAll(fd, bytes);
  } catch (error) {
    closeScreenshot(fd);
    removeCreatedFile(resolved);
    throw error;
  }
  closeScreenshot(fd);
  try {
    assertRealArtifactLocation(resolved);
  } catch (error) {
    removeCreatedFile(resolved);
    throw error;
  }
}

function openScreenshotExclusive(resolved: string): number {
  refuseSymlinkBeforeWrite(resolved);
  try {
    return openSync(resolved, exclusiveNoFollowFlags());
  } catch (error) {
    if (isFollowedSymlink(error, resolved)) {
      throw artifactBlocked("Refusing a symlinked artifact path");
    }
    throw error;
  }
}

function exclusiveNoFollowFlags(): number {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  return constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow;
}

/**
 * O_NOFOLLOW is not enforced on Windows. Refuse a symlink at the destination
 * or its nearest existing ancestor, and do not open anything except a
 * missing path or a regular file.
 */
function refuseSymlinkBeforeWrite(resolved: string): void {
  if (pathExists(resolved)) {
    const stat = lstatSync(resolved);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw artifactBlocked("Refusing a symlinked artifact path");
    }
  }
  const ancestor = nearestExistingAncestor(
    pathExists(resolved) ? dirname(resolved) : resolved,
  );
  if (isSymbolicLink(ancestor)) {
    throw artifactBlocked("Refusing a symlinked artifact path");
  }
}

function isFollowedSymlink(error: unknown, resolved: string): boolean {
  if (isErrno(error, "ELOOP")) {
    return true;
  }
  return isErrno(error, "EEXIST") && isSymbolicLink(resolved);
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) {
      throw new Error("Screenshot write made no progress");
    }
    offset += written;
  }
}

function closeScreenshot(fd: number): void {
  try {
    closeSync(fd);
  } catch (error) {
    if (!isErrno(error, "EBADF")) {
      throw error;
    }
  }
}

function removeCreatedFile(filePath: string): void {
  try {
    if (lstatSync(filePath).isSymbolicLink()) {
      return;
    }
    unlinkSync(filePath);
  } catch (error) {
    if (isEnoent(error)) {
      return;
    }
    throw error;
  }
}

function isListed(evidence: FlowSpec["evidence"], stepId: string): boolean {
  const screenshots = evidence?.screenshots;
  if (screenshots === undefined) {
    return false;
  }
  return screenshots.some((shot) => shot.after === stepId);
}

function assertStepFileName(stepId: string): void {
  if (!STEP_ID_PATTERN.test(stepId)) {
    throw new QaError({
      code: "POLICY_BLOCKED",
      message: "Screenshot filenames must match [a-z0-9-].",
    });
  }
}

export function assertArtifactPath(filePath: string): string {
  const resolved = resolve(filePath);
  if (containsCookieJar(resolved)) {
    throw artifactBlocked(
      "Refusing an artifact path that contains the cookie jar",
    );
  }
  assertRealArtifactLocation(resolved);
  return resolved;
}

/**
 * `resolve` does not follow a symlink. The nearest existing ancestor is
 * realpathed so the write stays outside the auth home and inside the artifact
 * directory. A symlink at the destination itself is refused.
 */
function assertRealArtifactLocation(resolved: string): void {
  if (isSymbolicLink(resolved)) {
    throw artifactBlocked("Refusing a symlinked artifact path");
  }

  const ancestor = nearestExistingAncestor(resolved);
  const realAncestor = realPathOf(ancestor);
  const realDestination = joinReal(ancestor, realAncestor, resolved);
  const intended = intendedArtifactDirectory(resolved, ancestor);

  if (
    !isInside(intended, realAncestor) ||
    !isInside(intended, realDestination)
  ) {
    throw artifactBlocked(
      "Refusing an artifact path outside the artifact directory",
    );
  }
  if (
    containsCookieJar(realAncestor) ||
    containsCookieJar(realDestination) ||
    isUnderRealAuth(realAncestor) ||
    isUnderRealAuth(realDestination)
  ) {
    throw artifactBlocked(
      "Refusing an artifact path that contains the cookie jar",
    );
  }
}

function intendedArtifactDirectory(resolved: string, ancestor: string): string {
  const directory = dirname(resolved);
  if (pathExists(directory)) {
    return directory;
  }
  return ancestor;
}

function nearestExistingAncestor(filePath: string): string {
  let current = filePath;
  while (!pathExists(current)) {
    const parent = dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
  return current;
}

function joinReal(
  ancestor: string,
  realAncestor: string,
  resolved: string,
): string {
  const suffix = relative(ancestor, resolved);
  if (suffixEscapes(suffix)) {
    throw artifactBlocked(
      "Refusing an artifact path outside the artifact directory",
    );
  }
  if (suffix.length === 0) {
    return realAncestor;
  }
  return resolve(realAncestor, suffix);
}

function suffixEscapes(suffix: string): boolean {
  return (
    suffix.startsWith("..") ||
    suffix.split(sep).includes("..") ||
    suffix.startsWith(sep)
  );
}

function realPathOf(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch (error) {
    if (isEnoent(error)) {
      throw artifactBlocked(
        "Refusing an artifact path outside the artifact directory",
      );
    }
    throw error;
  }
}

function isSymbolicLink(filePath: string): boolean {
  try {
    return lstatSync(filePath).isSymbolicLink();
  } catch (error) {
    if (isEnoent(error)) {
      return false;
    }
    throw error;
  }
}

function pathExists(filePath: string): boolean {
  try {
    lstatSync(filePath);
    return true;
  } catch (error) {
    if (isEnoent(error)) {
      return false;
    }
    throw error;
  }
}

function isInside(parent: string, child: string): boolean {
  const root = resolve(parent);
  const target = resolve(child);
  return target === root || target.startsWith(`${root}${sep}`);
}

function isUnderRealAuth(filePath: string): boolean {
  const resolved = resolve(filePath);
  for (const root of authRoots()) {
    if (!pathExists(root)) {
      continue;
    }
    let realRoot: string;
    try {
      realRoot = realpathSync(root);
    } catch (error) {
      if (isEnoent(error)) {
        continue;
      }
      throw error;
    }
    if (isInside(realRoot, resolved)) {
      return true;
    }
  }
  return false;
}

function artifactBlocked(message: string): QaError {
  return new QaError({
    code: "POLICY_BLOCKED",
    message,
  });
}

function isEnoent(error: unknown): boolean {
  return isErrno(error, "ENOENT");
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function containsCookieJar(filePath: string): boolean {
  if (hasCookieJarSegment(filePath)) {
    return true;
  }
  for (const root of authRoots()) {
    const authRoot = resolve(root);
    if (filePath === authRoot || filePath.startsWith(`${authRoot}${sep}`)) {
      return true;
    }
  }
  return false;
}

function hasCookieJarSegment(filePath: string): boolean {
  const segments = filePath.split(sep);
  return segments.some((segment) =>
    COOKIE_JAR_NAMES.has(segment.toLowerCase()),
  );
}

function authRoots(): string[] {
  return [join(homedir(), ".autonomous-qa", "auth"), join(homeDir(), "auth")];
}
