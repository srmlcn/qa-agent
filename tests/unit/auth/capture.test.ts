import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BrowserContext } from "playwright";
import { QaError } from "../../../src/errors/qa-error.js";
import { readProfile, type StorageState } from "../../../src/auth/store.js";
import { authDir } from "../../../src/runtime/paths.js";

const startBrowser = vi.hoisted(() => vi.fn());

vi.mock("../../../src/playwright/runtime.js", () => ({
  startBrowser,
}));

import { captureProfile, finish } from "../../../src/auth/capture.js";

const COOKIE_VALUE = "capture-unit-secret";

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.AUTONOMOUS_QA_HOME;
  home = mkdtempSync(join(tmpdir(), "autonomous-qa-capture-unit-"));
  process.env.AUTONOMOUS_QA_HOME = home;
  startBrowser.mockReset();
});

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.AUTONOMOUS_QA_HOME;
  } else {
    process.env.AUTONOMOUS_QA_HOME = previousHome;
  }
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

test("abort before storageState writes no profile", async () => {
  const controller = new AbortController();
  writeReady("billing", "admin");
  const storageState = vi.fn(async () => savedState());
  installSession({
    goto: () => {
      queueMicrotask(() => {
        queueMicrotask(() => {
          controller.abort();
        });
      });
      return Promise.resolve();
    },
    storageState,
  });

  await expect(capture("admin", controller.signal)).rejects.toMatchObject({
    code: "RUN_CANCELLED",
  });
  expect(storageState).not.toHaveBeenCalled();
  expect(authEntries("billing")).toEqual([]);
});

test("abort during storageState writes no profile", async () => {
  const controller = new AbortController();
  writeReady("billing", "admin");
  let resolveState: (state: StorageState) => void = () => undefined;
  const pendingState = new Promise<StorageState>((resolve) => {
    resolveState = resolve;
  });
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const storageState = vi.fn(() => {
    controller.abort();
    markStarted();
    return pendingState;
  });
  const close = installSession({ storageState });

  const pending = capture("admin", controller.signal);
  await started;
  resolveState(savedState());

  await expect(pending).rejects.toBeInstanceOf(QaError);
  await expect(pending).rejects.toMatchObject({ code: "RUN_CANCELLED" });
  expect(storageState).toHaveBeenCalledTimes(1);
  expect(authEntries("billing")).toEqual([]);
  expect(close).toHaveBeenCalledTimes(1);
});

test("abort immediately after storageState writes no profile", async () => {
  const controller = new AbortController();
  writeReady("billing", "admin");
  installSession({
    storageState: async () => {
      controller.abort();
      return savedState();
    },
  });

  await expect(capture("admin", controller.signal)).rejects.toMatchObject({
    code: "RUN_CANCELLED",
  });
  expect(authEntries("billing")).toEqual([]);
});

test("a rejected storageState after abort writes no profile", async () => {
  const controller = new AbortController();
  writeReady("billing", "admin");
  installSession({
    storageState: async () => {
      controller.abort();
      throw new Error("storage state failed");
    },
  });

  await expect(capture("admin", controller.signal)).rejects.toMatchObject({
    code: "RUN_CANCELLED",
  });
  expect(authEntries("billing")).toEqual([]);
});

test("a completed capture writes the profile", async () => {
  writeReady("billing", "admin");
  const close = installSession({
    storageState: async () => savedState(),
  });

  const result = await captureProfile({
    projectId: "billing",
    profile: "admin",
    startUrl: "about:blank",
  });

  expect(result).toEqual({ profile: "admin", projectId: "billing" });
  expect(JSON.stringify(result)).not.toContain(COOKIE_VALUE);
  expect(readProfile("billing", "admin")).toEqual(savedState());
  expect(existsSync(join(authDir("billing"), "admin.ready"))).toBe(false);
  expect(close).toHaveBeenCalledTimes(1);
});

test("finish drops a profile when the signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  writeReady("billing", "worker");
  const storageState = vi.fn(async () => savedState());

  await expect(
    finish(contextWith(storageState), {
      projectId: "billing",
      profile: "worker",
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ code: "RUN_CANCELLED" });
  expect(storageState).not.toHaveBeenCalled();
  expect(authEntries("billing")).toEqual([]);
});

function capture(profile: string, signal: AbortSignal): Promise<unknown> {
  return captureProfile({
    projectId: "billing",
    profile,
    startUrl: "about:blank",
    signal,
  });
}

function installSession(options: {
  goto?: () => Promise<void>;
  storageState: () => Promise<StorageState>;
}): ReturnType<typeof vi.fn> {
  const close = vi.fn(async () => undefined);
  startBrowser.mockResolvedValue({
    page: {
      goto: options.goto ?? (async () => undefined),
    },
    context: {
      storageState: options.storageState,
    },
    close,
  });
  return close;
}

function contextWith(
  storageState: () => Promise<StorageState>,
): BrowserContext {
  return { storageState } as unknown as BrowserContext;
}

function writeReady(projectId: string, profile: string): void {
  const ready = join(authDir(projectId), `${profile}.ready`);
  mkdirSync(dirname(ready), { recursive: true });
  writeFileSync(ready, "");
}

function authEntries(projectId: string): string[] {
  return readdirSync(authDir(projectId)).sort();
}

function savedState(): StorageState {
  return {
    cookies: [
      {
        name: "session",
        value: COOKIE_VALUE,
        domain: "example.test",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ],
    origins: [],
  };
}
