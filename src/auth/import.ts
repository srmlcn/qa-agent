import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { ProjectConfig } from "../config/schema.js";
import { QaError } from "../errors/qa-error.js";
import type { Locator, Step } from "../flows/schema.js";
import { runAction } from "../playwright/actions.js";
import { startBrowser } from "../playwright/runtime.js";
import { assertUrlAllowed } from "../security/hosts.js";
import { saveProfile, type StorageState } from "./store.js";

const DEFAULT_ACTION_TIMEOUT_MS = 30_000;
const FLOWS_SEGMENTS = [".autonomous-qa", "flows"] as const;

/** Profile identity only. Storage state and passwords are never included. */
export type ImportedProfile = {
  profile: string;
  projectId: string;
};

export type ImportStorageStateOptions = {
  projectId: string;
  profile: string;
  /** Existing Playwright storage-state JSON. This file is not deleted. */
  filePath: string;
};

export type ScriptedLoginOptions = {
  projectId: string;
  profile: string;
  loginUrl: string;
  usernameEnv: string;
  passwordEnv: string;
  usernameLocator: Locator;
  passwordLocator: Locator;
  submitLocator: Locator;
  /** When present, `loginUrl` is checked with the host allowlist before launch. */
  config?: ProjectConfig;
};

/**
 * Copies a Playwright storage-state file the caller already has into an auth profile.
 * The source path must be outside the project flows directory. The source file is kept.
 */
export function importStorageState(
  options: ImportStorageStateOptions,
): ImportedProfile {
  assertOutsideProjectFlows(options.filePath);
  const storageState = readStorageState(options.filePath);
  saveProfile(options.projectId, options.profile, storageState);
  return { profile: options.profile, projectId: options.projectId };
}

/**
 * Signs in with environment credentials and stores the resulting browser session.
 * The password is not written to the flow repository, logs, or the return value.
 */
export async function scriptedLogin(
  options: ScriptedLoginOptions,
): Promise<ImportedProfile> {
  if (options.config !== undefined) {
    assertUrlAllowed(options.loginUrl, options.config);
  }

  const username = requiredEnv(options.usernameEnv);
  const password = requiredEnv(options.passwordEnv);
  const timeoutMs = options.config?.playwright.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;

  const session = await startBrowser({
    headless: true,
    timeoutMs,
  });
  try {
    await runAction(session.page, gotoStep(options.loginUrl), timeoutMs);
    await runAction(
      session.page,
      fillStep(
        "fill-username",
        "Fill the username",
        options.usernameLocator,
        username,
      ),
      timeoutMs,
    );
    await runAction(
      session.page,
      fillStep(
        "fill-password",
        "Fill the password",
        options.passwordLocator,
        password,
      ),
      timeoutMs,
    );
    await runAction(session.page, clickStep(options.submitLocator), timeoutMs);
    const storageState = await session.context.storageState();
    saveProfile(options.projectId, options.profile, storageState);
    return { profile: options.profile, projectId: options.projectId };
  } finally {
    await session.close();
  }
}

function gotoStep(url: string): Step {
  return {
    id: "open-login",
    intent: "Open the login page",
    action: "goto",
    value: url,
  };
}

function fillStep(
  id: string,
  intent: string,
  locator: Locator,
  value: string,
): Step {
  return {
    id,
    intent,
    action: "fill",
    locator,
    value,
  };
}

function clickStep(locator: Locator): Step {
  return {
    id: "submit-login",
    intent: "Submit the login form",
    action: "click",
    locator,
  };
}

/**
 * Reads a named environment variable.
 * The error names the variable and never includes its value.
 */
function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new QaError({
      code: "AUTH_MISSING",
      message: `Environment variable ${name} is not set`,
    });
  }
  return value;
}

function readStorageState(filePath: string): StorageState {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      throw new QaError({
        code: "AUTH_MISSING",
        message: "Storage state file is missing",
      });
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = parseJson(text);
  } catch {
    throw unreadableStorageState();
  }
  if (!hasStorageStateArrays(parsed)) {
    throw unreadableStorageState();
  }
  // saveProfile checks cookie and origin entries. Callers must not print it.
  return parsed;
}

function assertOutsideProjectFlows(filePath: string): void {
  const flowsDirectory = resolve(process.cwd(), ...FLOWS_SEGMENTS);
  const blocked = new Set<string>([flowsDirectory]);
  if (existsSync(flowsDirectory)) {
    blocked.add(realpathSync(flowsDirectory));
  }

  for (const candidate of pathVariants(filePath)) {
    for (const root of blocked) {
      if (isInsidePath(root, candidate)) {
        throw new QaError({
          code: "POLICY_BLOCKED",
          message:
            "Refusing to import storage state from the project flows directory",
        });
      }
    }
  }
}

function pathVariants(filePath: string): string[] {
  const resolved = resolve(filePath);
  const variants = new Set<string>([resolved]);
  if (existsSync(resolved)) {
    variants.add(realpathSync(resolved));
  }
  return [...variants];
}

function isInsidePath(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

function hasStorageStateArrays(value: unknown): value is StorageState {
  if (!isRecord(value)) {
    return false;
  }
  return Array.isArray(value.cookies) && Array.isArray(value.origins);
}

function unreadableStorageState(): QaError {
  return new QaError({
    code: "AUTH_MISSING",
    message: "storage state is unreadable",
  });
}

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
