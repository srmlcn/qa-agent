import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
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
    throw new QaError({
      code: "POLICY_BLOCKED",
      message: "Refusing an artifact path that contains the cookie jar",
    });
  }
  return resolved;
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
