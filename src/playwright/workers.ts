import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  Page,
} from "playwright";
import { QaError } from "../errors/qa-error.js";
import { classifyPlaywrightError } from "./errors.js";
import { startBrowser, type BrowserSession } from "./runtime.js";

export type AuthStrategy = "shared" | "per-worker";

export type WorkerRunArgs<TItem> = {
  item: TItem;
  index: number;
  /** Slot in the worker queue. Storage state for `per-worker` follows this index. */
  workerIndex: number;
  page: Page;
  context: BrowserContext;
};

export type WorkerItemResult<TItem, TValue> = {
  index: number;
  item: TItem;
  value?: TValue;
  error?: QaError;
};

export type WorkerPoolResult<TItem, TValue> = {
  results: WorkerItemResult<TItem, TValue>[];
  errors: QaError[];
};

export type RunPoolOptions<TItem, TValue> = {
  /** Caller-supplied worker count. This module does not read project config. */
  concurrency: number;
  items: readonly TItem[];
  authStrategy: AuthStrategy;
  /** Playwright storage-state paths. Profiles are not resolved here. */
  storageStates: readonly string[];
  run: (args: WorkerRunArgs<TItem>) => Promise<TValue>;
};

type BrowserSlot = {
  acquire(): Promise<Browser>;
  close(): Promise<void>;
};

/**
 * Runs `items` on isolated Playwright contexts.
 * One Chromium process is launched with `startBrowser`. Each item gets a fresh
 * context from that browser, closed in a `finally`, so a crashed context cannot
 * leak into the next item. If the browser itself disconnects, the next item
 * launches a replacement instead of reusing the dead process.
 * A thrown {@link QaError} is stored on that item's result and does not cancel
 * siblings. The returned `errors` list is those failures in item order.
 */
export async function runPool<TItem, TValue>(
  options: RunPoolOptions<TItem, TValue>,
): Promise<WorkerPoolResult<TItem, TValue>> {
  assertConcurrency(options.concurrency);
  assertAuth(options.authStrategy, options.storageStates);
  if (options.items.length === 0) {
    return { results: [], errors: [] };
  }

  const slot = createBrowserSlot();
  try {
    await slot.acquire();
    return await runQueue(slot, options);
  } finally {
    await slot.close();
  }
}

function assertConcurrency(concurrency: number): void {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("concurrency must be a positive integer");
  }
}

function assertAuth(
  authStrategy: AuthStrategy,
  storageStates: readonly string[],
): void {
  if (authStrategy === "per-worker" && storageStates.length === 0) {
    throw new QaError({
      code: "AUTH_MISSING",
      message: "per-worker auth requires at least one storage state.",
    });
  }
}

async function runQueue<TItem, TValue>(
  slot: BrowserSlot,
  options: RunPoolOptions<TItem, TValue>,
): Promise<WorkerPoolResult<TItem, TValue>> {
  const results: Array<WorkerItemResult<TItem, TValue> | undefined> = new Array(
    options.items.length,
  );
  let nextIndex = 0;
  const workerCount = Math.min(options.concurrency, options.items.length);

  const runWorker = async (workerIndex: number): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= options.items.length) {
        return;
      }
      results[index] = await runOne(slot, options, workerIndex, index);
    }
  };

  // Fixed workers pull from the queue. Promise.all over every item would
  // start the whole list when it is longer than `concurrency`.
  await Promise.all(
    Array.from({ length: workerCount }, (_, workerIndex) =>
      runWorker(workerIndex),
    ),
  );

  return collect(results);
}

async function runOne<TItem, TValue>(
  slot: BrowserSlot,
  options: RunPoolOptions<TItem, TValue>,
  workerIndex: number,
  index: number,
): Promise<WorkerItemResult<TItem, TValue>> {
  const item = options.items[index] as TItem;
  let context: BrowserContext | undefined;
  try {
    const browser = await slot.acquire();
    const storageState = storageStateFor(
      options.authStrategy,
      options.storageStates,
      workerIndex,
    );
    context = await browser.newContext(contextOptions(storageState));
    const page = await context.newPage();
    const value = await options.run({
      item,
      index,
      workerIndex,
      page,
      context,
    });
    return { index, item, value };
  } catch (error) {
    return { index, item, error: asQaError(error) };
  } finally {
    await closeContext(context);
  }
}

function storageStateFor(
  authStrategy: AuthStrategy,
  storageStates: readonly string[],
  workerIndex: number,
): string | undefined {
  if (storageStates.length === 0) {
    return undefined;
  }
  if (authStrategy === "shared") {
    return storageStates[0];
  }
  return storageStates[workerIndex % storageStates.length];
}

function contextOptions(
  storageState: string | undefined,
): BrowserContextOptions {
  if (storageState === undefined) {
    return {};
  }
  return { storageState };
}

function asQaError(error: unknown): QaError {
  if (error instanceof QaError) {
    return error;
  }
  return classifyPlaywrightError(error);
}

async function closeContext(
  context: BrowserContext | undefined,
): Promise<void> {
  if (context === undefined) {
    return;
  }
  try {
    await context.close();
  } catch {
    // A crashed context is already gone. Swallowing this keeps the item
    // result and lets the worker open a fresh context for the next item.
  }
}

function collect<TItem, TValue>(
  results: ReadonlyArray<WorkerItemResult<TItem, TValue> | undefined>,
): WorkerPoolResult<TItem, TValue> {
  const dense: WorkerItemResult<TItem, TValue>[] = [];
  const errors: QaError[] = [];
  for (const result of results) {
    if (result === undefined) {
      throw new Error("Worker pool did not record every item");
    }
    dense.push(result);
    if (result.error !== undefined) {
      errors.push(result.error);
    }
  }
  return { results: dense, errors };
}

function createBrowserSlot(): BrowserSlot {
  let tail: Promise<void> = Promise.resolve();
  let session: BrowserSession | undefined;

  const exclusive = async <T>(task: () => Promise<T>): Promise<T> => {
    let release: (() => void) | undefined;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = tail;
    tail = turn;
    await previous;
    try {
      return await task();
    } finally {
      release?.();
    }
  };

  return {
    acquire: () =>
      exclusive(async () => {
        if (session !== undefined && session.browser.isConnected()) {
          return session.browser;
        }
        const previousSession = session;
        session = undefined;
        if (previousSession !== undefined) {
          await previousSession.close().catch(() => {
            // The disconnected process is replaced below.
          });
        }
        const next = await startBrowser({ headless: true });
        session = next;
        await closeLaunchContext(next);
        return next.browser;
      }),
    close: () =>
      exclusive(async () => {
        const current = session;
        session = undefined;
        if (current !== undefined) {
          await current.close();
        }
      }),
  };
}

async function closeLaunchContext(session: BrowserSession): Promise<void> {
  try {
    await session.context.close();
  } catch {
    // Worker items open their own contexts. The launch context is unused.
  }
}
