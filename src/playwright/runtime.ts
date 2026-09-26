import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type LaunchOptions,
  type Page,
} from "playwright";
import { QaError } from "../errors/qa-error.js";

const SUPPORTED_BROWSER = "chromium";

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

    context = await launched.newContext(contextOptions(options.storageState));
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

function contextOptions(storageState: string | undefined): BrowserContextOptions {
  if (storageState === undefined) {
    return {};
  }
  return { storageState };
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
  await bestEffortClose(page);
  await bestEffortClose(context);
  await bestEffortClose(browser);
  if (browser?.isConnected()) {
    throw new QaError({
      code: "BROWSER_CRASHED",
      message: "Failed to close Chromium.",
    });
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
