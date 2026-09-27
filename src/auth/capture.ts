import { existsSync, rmSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { BrowserContext } from "playwright";
import type { ProjectConfig } from "../config/schema.js";
import { QaError } from "../errors/qa-error.js";
import { startBrowser } from "../playwright/runtime.js";
import { createLogger } from "../runtime/logger.js";
import { authDir } from "../runtime/paths.js";
import { assertUrlAllowed } from "../security/hosts.js";
import { saveProfile } from "./store.js";

const logger = createLogger();
const POLL_INTERVAL_MS = 200;

export type CaptureProfileOptions = {
  projectId: string;
  profile: string;
  startUrl: string;
  /** Aborts launch or the wait and writes no profile. */
  signal?: AbortSignal;
  /** When present, `startUrl` is checked with the host allowlist before launch. */
  config?: ProjectConfig;
};

/** Profile identity only. Cookie values are never included. */
export type CapturedProfile = {
  profile: string;
  projectId: string;
};

/**
 * Opens headed Chromium at `startUrl` and stores storage state after login.
 *
 * Completion is a file `~/.autonomous-qa/auth/<project-id>/<profile>.ready`
 * created by the operator, or a stdin line `done`.
 * Tests call `finish` instead of waiting for either signal.
 */
export async function captureProfile(
  options: CaptureProfileOptions,
): Promise<CapturedProfile> {
  if (options.config !== undefined) {
    assertUrlAllowed(options.startUrl, options.config);
  }
  // Reject a profile path that would escape the auth directory before launch.
  readyFile(options.projectId, options.profile);

  const session = await startBrowser({
    headless: false,
    signal: options.signal,
  });

  try {
    if (options.signal?.aborted) {
      throw cancelled();
    }
    await session.page.goto(options.startUrl, { signal: options.signal });
    await waitForOperator(options);
    if (options.signal?.aborted) {
      throw cancelled();
    }
    return await finish(session.context, {
      projectId: options.projectId,
      profile: options.profile,
    });
  } catch (error) {
    if (options.signal?.aborted) {
      throw cancelled();
    }
    throw error;
  } finally {
    await session.close();
  }
}

/**
 * Saves `context.storageState()` and removes the operator ready file.
 * Tests call this directly so capture does not need a human.
 */
export async function finish(
  context: BrowserContext,
  options: { projectId: string; profile: string },
): Promise<CapturedProfile> {
  const storageState = await context.storageState();
  saveProfile(options.projectId, options.profile, storageState);
  removeReadyFile(options.projectId, options.profile);
  logger.info(
    `captured auth profile ${options.profile} for project ${options.projectId}`,
  );
  return { profile: options.profile, projectId: options.projectId };
}

/**
 * Operator completion is a file `~/.autonomous-qa/auth/<project-id>/<profile>.ready`
 * or a stdin line `done`.
 */
function waitForOperator(options: CaptureProfileOptions): Promise<void> {
  const readyPath = readyFile(options.projectId, options.profile);
  if (options.signal?.aborted) {
    return Promise.reject(cancelled());
  }
  if (existsSync(readyPath)) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let pending = "";
    const wasPaused = process.stdin.isPaused();

    const cleanup = (): void => {
      clearInterval(timer);
      process.stdin.off("data", onStdin);
      options.signal?.removeEventListener("abort", onAbort);
      if (wasPaused) {
        process.stdin.pause();
      }
    };

    const settle = (error?: QaError): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    };

    const onAbort = (): void => {
      settle(cancelled());
    };

    const onStdin = (chunk: string | Uint8Array): void => {
      pending += chunkText(chunk);
      let newlineAt = pending.indexOf("\n");
      while (newlineAt !== -1) {
        const line = pending.slice(0, newlineAt).replace(/\r$/, "");
        pending = pending.slice(newlineAt + 1);
        if (line.trim() === "done") {
          settle();
          return;
        }
        newlineAt = pending.indexOf("\n");
      }
    };

    const timer = setInterval(() => {
      if (options.signal?.aborted) {
        settle(cancelled());
        return;
      }
      if (existsSync(readyPath)) {
        settle();
      }
    }, POLL_INTERVAL_MS);

    process.stdin.on("data", onStdin);
    process.stdin.resume();
    options.signal?.addEventListener("abort", onAbort);
  });
}

function readyFile(projectId: string, profile: string): string {
  const directory = resolve(authDir(projectId));
  const filePath = resolve(directory, `${profile}.ready`);
  if (
    dirname(filePath) !== directory ||
    basename(filePath) !== `${profile}.ready`
  ) {
    throw new QaError({
      code: "POLICY_BLOCKED",
      message: "Invalid auth profile name",
    });
  }
  return filePath;
}

function removeReadyFile(projectId: string, profile: string): void {
  rmSync(readyFile(projectId, profile), { force: true });
}

function chunkText(chunk: string | Uint8Array): string {
  if (typeof chunk === "string") {
    return chunk;
  }
  return Buffer.from(chunk).toString("utf8");
}

function cancelled(): QaError {
  return new QaError({
    code: "RUN_CANCELLED",
    message: "Auth capture was aborted.",
  });
}
