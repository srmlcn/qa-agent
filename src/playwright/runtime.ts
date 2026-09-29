import { existsSync } from "node:fs";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type LaunchOptions,
  type Page,
} from "playwright";
import { QaError } from "../errors/qa-error.js";
import { browsersDir } from "../runtime/paths.js";

const SUPPORTED_BROWSER = "chromium";
/**
 * Playwright's graceful close waits on the browser process and its temp
 * directories. That wait can outlive the step that already finished. Kill
 * the process group and let the caller continue.
 */
const CLOSE_DEADLINE_MS = 5_000;
const CLOSE_KILL_GRACE_MS = 1_000;

export type StartBrowserOptions = {
  /** Defaults to Chromium. Any other name is rejected. */
  browser?: string;
  /** Defaults to true. */
  headless?: boolean;
  /** Launch timeout and the default page timeout, in milliseconds. */
  timeoutMs?: number;
  /** Aborts an in-flight launch and closes the browser. */
  signal?: AbortSignal;
  /**
   * Playwright storage-state file path.
   * Forwarded to the context as-is. This module does not resolve auth profiles.
   */
  storageState?: string;
  recordVideo?: {
    dir: string;
    size: { width: number; height: number };
  };
};

export type BrowserSession = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
};

/**
 * Launches Chromium, opens one context and one page, and returns an idempotent
 * `close`. `close` also runs when `signal` aborts and when startup fails.
 */
export async function startBrowser(
  options: StartBrowserOptions = {},
): Promise<BrowserSession> {
  const browserName = options.browser ?? SUPPORTED_BROWSER;
  if (browserName !== SUPPORTED_BROWSER) {
    throw new QaError({
      code: "POLICY_BLOCKED",
      message: `Browser "${browserName}" is blocked. v0.1 supports Chromium only.`,
    });
  }

  const signal = options.signal;
  if (signal?.aborted) {
    throw cancelled();
  }

  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let closeRequested = false;
  let closePromise: Promise<void> | undefined;

  const close = (): Promise<void> => {
    closeRequested = true;
    signal?.removeEventListener("abort", onAbort);
    if (closePromise !== undefined) {
      return closePromise;
    }
    // Abort can win before launch assigns the browser. Keep the request and
    // tear down once the handle exists so the process cannot leak.
    if (browser === undefined) {
      return Promise.resolve();
    }
    const currentBrowser = browser;
    const currentContext = context;
    const currentPage = page;
    browser = undefined;
    context = undefined;
    page = undefined;
    closePromise = teardown(currentPage, currentContext, currentBrowser);
    return closePromise;
  };

  const onAbort = (): void => {
    void close().catch(() => {
      // The listener must not create an unhandled rejection.
      // Callers that await close() still observe a teardown failure.
    });
  };

  signal?.addEventListener("abort", onAbort);

  try {
    const launched = await launchChromium(options);
    browser = launched;
    if (closeRequested || signal?.aborted) {
      await close();
      throw cancelled();
    }

    context = await launched.newContext(contextOptions(options));
    applyTimeout(context, options.timeoutMs);
    if (closeRequested || signal?.aborted) {
      await close();
      throw cancelled();
    }

    page = await context.newPage();
    if (closeRequested || signal?.aborted) {
      await close();
      throw cancelled();
    }

    return { browser, context, page, close };
  } catch (error) {
    await close();
    if (signal?.aborted) {
      throw cancelled();
    }
    throw error;
  }
}

async function launchChromium(options: StartBrowserOptions): Promise<Browser> {
  const launchOptions: LaunchOptions = {
    headless: options.headless ?? true,
  };
  const executablePath = installedChromiumExecutable();
  if (executablePath !== undefined) {
    launchOptions.executablePath = executablePath;
  }
  if (options.timeoutMs !== undefined) {
    launchOptions.timeout = options.timeoutMs;
  }

  try {
    return await chromium.launch(launchOptions);
  } catch (error) {
    if (isMissingExecutable(error)) {
      throw new QaError({
        code: "BROWSER_CRASHED",
        message:
          "Playwright Chromium is not installed. Install it with `npx playwright install chromium`.",
      });
    }
    throw error;
  }
}

/**
 * Chromium from `PLAYWRIGHT_BROWSERS_PATH` when that variable is set.
 * Otherwise Chromium already installed under the home browsers directory.
 * Undefined means that directory has no browser, so launch can use Playwright's cache.
 */
export function installedChromiumExecutable(): string | undefined {
  const configured = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const directory =
    configured !== undefined && configured.length > 0 ? configured : browsersDir();
  return executableUnder(directory);
}

function executableUnder(directory: string): string | undefined {
  const previous = process.env.PLAYWRIGHT_BROWSERS_PATH;
  process.env.PLAYWRIGHT_BROWSERS_PATH = directory;
  try {
    const executable = chromium.executablePath();
    return existsSync(executable) ? executable : undefined;
  } catch {
    return undefined;
  } finally {
    if (previous === undefined) {
      delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    } else {
      process.env.PLAYWRIGHT_BROWSERS_PATH = previous;
    }
  }
}

function contextOptions(options: StartBrowserOptions): BrowserContextOptions {
  const contextOptions: BrowserContextOptions = {};
  if (options.storageState !== undefined) {
    contextOptions.storageState = options.storageState;
  }
  if (options.recordVideo !== undefined) {
    contextOptions.recordVideo = options.recordVideo;
  }
  return contextOptions;
}

function applyTimeout(
  context: BrowserContext,
  timeoutMs: number | undefined,
): void {
  if (timeoutMs === undefined) {
    return;
  }
  context.setDefaultTimeout(timeoutMs);
  context.setDefaultNavigationTimeout(timeoutMs);
}

async function teardown(
  page: Page | undefined,
  context: BrowserContext | undefined,
  browser: Browser | undefined,
): Promise<void> {
  const pending = closeTargets(page, context, browser);
  void pending.catch(() => {
    // A deadline winner leaves this running. A later rejection is ignored.
  });
  const finished = await finishedWithin(pending, CLOSE_DEADLINE_MS);
  if (!finished) {
    killBrowserProcess(browser);
    await finishedWithin(pending, CLOSE_KILL_GRACE_MS);
  }
  if (isConnected(browser)) {
    throw new QaError({
      code: "BROWSER_CRASHED",
      message: "Failed to close Chromium.",
    });
  }
}

async function closeTargets(
  page: Page | undefined,
  context: BrowserContext | undefined,
  browser: Browser | undefined,
): Promise<void> {
  await bestEffortClose(page);
  await bestEffortClose(context);
  await bestEffortClose(browser);
}

function finishedWithin(work: Promise<void>, deadlineMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      finish(false);
    }, deadlineMs);
    work.then(
      () => {
        finish(true);
      },
      () => {
        finish(true);
      },
    );
  });
}

type SpawnedProcess = {
  pid?: number;
  kill: (signal: NodeJS.Signals) => boolean;
};

/**
 * Playwright 1.63 removed `Browser.process()`. The in-process connection still
 * exposes the launched child on the server browser.
 */
type BrowserInternals = Browser & {
  _connection?: {
    toImpl?: (object: Browser) => {
      options?: {
        browserProcess?: {
          process?: SpawnedProcess;
        };
      };
    } | null;
  };
};

function killBrowserProcess(browser: Browser | undefined): void {
  if (browser === undefined) {
    return;
  }
  const child = spawnedProcess(browser);
  const pid = child?.pid;
  if (child === undefined || pid === undefined || pid <= 1) {
    return;
  }
  try {
    if (process.platform === "win32") {
      child.kill("SIGKILL");
      return;
    }
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process already exited.
    }
  }
}

function spawnedProcess(browser: Browser): SpawnedProcess | undefined {
  try {
    const internals = browser as BrowserInternals;
    return internals._connection?.toImpl?.(browser)?.options?.browserProcess
      ?.process;
  } catch {
    return undefined;
  }
}

function isConnected(browser: Browser | undefined): boolean {
  if (browser === undefined) {
    return false;
  }
  try {
    return browser.isConnected();
  } catch {
    return false;
  }
}

async function bestEffortClose(
  target: { close: () => Promise<unknown> } | undefined,
): Promise<void> {
  if (target === undefined) {
    return;
  }
  try {
    await target.close();
  } catch {
    // Abort can close the target before this call runs.
  }
}

function isMissingExecutable(error: unknown): boolean {
  return errorMessage(error).includes("Executable doesn't exist");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "";
}

function cancelled(): QaError {
  return new QaError({
    code: "RUN_CANCELLED",
    message: "Chromium launch was aborted.",
  });
}
