import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import type { BrowserContext, Page } from "playwright";
import { QaError } from "../../../src/errors/qa-error.js";
import { runPool } from "../../../src/playwright/workers.js";

const TEST_TIMEOUT_MS = 60_000;
const INLINE_URL = "https://inline.test/page";
const INLINE_HTML = "<!doctype html><title>inline</title><p>inline page</p>";

type StorageSnapshot = {
  owner: string | null;
  openContexts: number;
};

test(
  "two contexts opened against inline pages do not share localStorage",
  async () => {
    const before = browserPids();
    const release = deferred<void>();
    const bothWrote = deferred<void>();
    let writes = 0;

    const pending = runPool({
      concurrency: 2,
      items: ["alpha", "beta"],
      authStrategy: "shared",
      storageStates: [],
      run: async ({ item, page }) => {
        await openInlinePage(page);
        await page.evaluate((owner) => {
          localStorage.setItem("owner", owner);
        }, item);
        writes += 1;
        if (writes === 2) {
          bothWrote.resolve();
        }
        await bothWrote.promise;
        const openContexts = page.context().browser()?.contexts().length ?? 0;
        await release.promise;
        const owner = await page.evaluate(() => localStorage.getItem("owner"));
        return { owner, openContexts } satisfies StorageSnapshot;
      },
    });

    try {
      await bothWrote.promise;
      release.resolve();
      const outcome = await pending;

      expect(outcome.errors).toEqual([]);
      expect(outcome.results.map((result) => result.value?.owner)).toEqual([
        "alpha",
        "beta",
      ]);
      expect(
        outcome.results.map((result) => result.value?.openContexts),
      ).toEqual([2, 2]);
    } finally {
      release.resolve();
    }

    await expectBrowsersClosed(before);
  },
  TEST_TIMEOUT_MS,
);

test(
  "the next item does not inherit localStorage from the previous context",
  async () => {
    const before = browserPids();
    const outcome = await runPool({
      concurrency: 1,
      items: ["first", "second"],
      authStrategy: "shared",
      storageStates: [],
      run: async ({ item, page }) => {
        await openInlinePage(page);
        const openContexts = page.context().browser()?.contexts().length ?? 0;
        if (item === "first") {
          await page.evaluate(() => {
            localStorage.setItem("owner", "first");
          });
        }
        const owner = await page.evaluate(() => localStorage.getItem("owner"));
        return { owner, openContexts } satisfies StorageSnapshot;
      },
    });

    expect(outcome.errors).toEqual([]);
    expect(outcome.results.map((result) => result.value)).toEqual([
      { owner: "first", openContexts: 1 },
      { owner: null, openContexts: 1 },
    ]);
    await expectBrowsersClosed(before);
  },
  TEST_TIMEOUT_MS,
);

test(
  "concurrency 2 runs at most two of four items at once",
  async () => {
    const before = browserPids();
    const release = deferred<void>();
    const twoStarted = deferred<void>();
    let active = 0;
    let peak = 0;
    let started = 0;

    try {
      const pending = runPool({
        concurrency: 2,
        items: [0, 1, 2, 3],
        authStrategy: "shared",
        storageStates: [],
        run: async ({ item }) => {
          active += 1;
          peak = Math.max(peak, active);
          started += 1;
          if (started === 2) {
            twoStarted.resolve();
          }
          await release.promise;
          active -= 1;
          return item;
        },
      });

      await twoStarted.promise;
      await delay(100);
      expect(active).toBe(2);
      expect(started).toBe(2);
      release.resolve();

      const outcome = await pending;
      expect(peak).toBe(2);
      expect(outcome.errors).toEqual([]);
      expect(outcome.results.map((result) => result.value)).toEqual([
        0, 1, 2, 3,
      ]);
    } finally {
      release.resolve();
    }

    await expectBrowsersClosed(before);
  },
  TEST_TIMEOUT_MS,
);

test(
  "a thrown error on item 1 still produces a result for item 2",
  async () => {
    const before = browserPids();
    const outcome = await runPool({
      concurrency: 2,
      items: [1, 2],
      authStrategy: "shared",
      storageStates: [],
      run: async ({ item }) => {
        if (item === 1) {
          throw new QaError({
            code: "PAGE_ERROR",
            message: "item 1 failed",
          });
        }
        await delay(50);
        return "item-2";
      },
    });

    expect(outcome.results).toHaveLength(2);
    expect(outcome.results[0]).toMatchObject({
      index: 0,
      item: 1,
    });
    expect(outcome.results[0]?.error).toBeInstanceOf(QaError);
    expect(outcome.results[0]?.error).toMatchObject({
      code: "PAGE_ERROR",
      message: "item 1 failed",
    });
    expect(outcome.results[0]?.value).toBeUndefined();
    expect(outcome.results[1]).toEqual({
      index: 1,
      item: 2,
      value: "item-2",
    });
    expect(outcome.errors).toEqual([outcome.results[0]?.error]);
    await expectBrowsersClosed(before);
  },
  TEST_TIMEOUT_MS,
);

test("per-worker with an empty profile list throws AUTH_MISSING before launch", async () => {
  const before = browserPids();
  let started = false;
  const pending = runPool({
    concurrency: 2,
    items: ["flow-a", "flow-b"],
    authStrategy: "per-worker",
    storageStates: [],
    run: async () => {
      started = true;
      return "ran";
    },
  });

  await expect(pending).rejects.toBeInstanceOf(QaError);
  await expect(pending).rejects.toMatchObject({
    code: "AUTH_MISSING",
    recoveryAppropriate: false,
  });
  await expect(pending).rejects.toThrow(/per-worker auth requires at least one storage state/);
  expect(started).toBe(false);
  expect(extraPids(before)).toEqual([]);
});

test(
  "shared uses the first storage state and per-worker follows the worker slot",
  async () => {
    const before = browserPids();
    const directory = mkdtempSync(join(tmpdir(), "qa-worker-auth-"));
    const profiles = ["profile-a", "profile-b", "profile-c"].map((value) =>
      writeStorageState(directory, value),
    );

    try {
      const shared = await runPool({
        concurrency: 2,
        items: ["one", "two"],
        authStrategy: "shared",
        storageStates: profiles,
        run: async ({ context }) => readSession(context),
      });
      expect(shared.errors).toEqual([]);
      expect(shared.results.map((result) => result.value)).toEqual([
        "profile-a",
        "profile-a",
      ]);

      const perWorker = await runPool({
        concurrency: 2,
        items: [0, 1, 2, 3],
        authStrategy: "per-worker",
        storageStates: profiles,
        run: async ({ workerIndex, context }) => ({
          workerIndex,
          session: await readSession(context),
        }),
      });
      expect(perWorker.errors).toEqual([]);
      expect(perWorker.results).toHaveLength(4);
      for (const result of perWorker.results) {
        const workerIndex = result.value?.workerIndex;
        expect(workerIndex).toBeTypeOf("number");
        if (typeof workerIndex !== "number") {
          throw new Error("missing worker index");
        }
        const profilesByWorker = ["profile-a", "profile-b", "profile-c"];
        expect(result.value?.session).toBe(
          profilesByWorker[workerIndex % profilesByWorker.length],
        );
      }
      const workers = new Set(
        perWorker.results.map((result) => result.value?.workerIndex),
      );
      expect(workers).toEqual(new Set([0, 1]));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }

    await expectBrowsersClosed(before);
  },
  TEST_TIMEOUT_MS,
);

test("the worker module does not read project config", () => {
  const sourcePath = fileURLToPath(
    new URL("../../../src/playwright/workers.ts", import.meta.url),
  );
  const source = readFileSync(sourcePath, "utf8");
  expect(source).not.toContain("load-project");
  expect(source).not.toContain("readFileSync");
  expect(importSpecifiers(source)).not.toContain("../config/schema.js");
  expect(importSpecifiers(source)).not.toContain("../config/load-project.js");
});

async function openInlinePage(page: Page): Promise<void> {
  await page.route("https://inline.test/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: INLINE_HTML,
    }),
  );
  await page.goto(INLINE_URL);
}

async function readSession(
  context: BrowserContext,
): Promise<string | undefined> {
  const cookies = await context.cookies("https://example.com");
  return cookies.find((cookie) => cookie.name === "session")?.value;
}

function writeStorageState(directory: string, value: string): string {
  const storageState = join(directory, `${value}.json`);
  writeFileSync(
    storageState,
    JSON.stringify({
      cookies: [
        {
          name: "session",
          value,
          domain: "example.com",
          path: "/",
          expires: -1,
          httpOnly: false,
          secure: false,
          sameSite: "Lax",
        },
      ],
      origins: [],
    }),
  );
  return storageState;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return {
    promise,
    resolve: (value) => {
      if (resolve === undefined) {
        throw new Error("Deferred resolve is unavailable");
      }
      resolve(value);
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const fromPattern = /\bfrom\s+["']([^"']+)["']/g;
  for (const match of source.matchAll(fromPattern)) {
    const specifier = match[1];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

async function expectBrowsersClosed(before: readonly number[]): Promise<void> {
  await expect.poll(() => extraPids(before), { timeout: 10_000 }).toEqual([]);
}

function browserPids(): number[] {
  let output = "";
  try {
    output = execFileSync("ps", ["-A", "-o", "pid=,command="], {
      encoding: "utf8",
    });
  } catch {
    return [];
  }

  const pids: number[] = [];
  for (const line of output.split("\n")) {
    if (!line.includes("ms-playwright")) {
      continue;
    }
    const pidText = line.trim().split(/\s+/, 1)[0];
    if (pidText === undefined) {
      continue;
    }
    const pid = Number(pidText);
    if (Number.isInteger(pid)) {
      pids.push(pid);
    }
  }
  return pids;
}

function extraPids(before: readonly number[]): number[] {
  const known = new Set(before);
  return browserPids().filter((pid) => !known.has(pid));
}
