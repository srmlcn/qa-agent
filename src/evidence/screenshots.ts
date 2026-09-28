import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { Page } from "playwright";
import { QaError } from "../errors/qa-error.js";
import type { FlowSpec } from "../flows/schema.js";
import { homeDir } from "../runtime/paths.js";

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
): Promise<string | undefined> {
  if (!isListed(evidence, stepId)) {
    return undefined;
  }
  assertStepFileName(stepId);
  const filePath = assertArtifactPath(join(destDir, `${stepId}.png`));
  mkdirSync(dirname(filePath), { recursive: true });
  await page.screenshot({ path: filePath, type: "png" });
  return filePath;
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
  return error instanceof Error && "code" in error && error.code === "ENOENT";
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
