import { afterEach, expect, test, vi } from "vitest";
import { QaError } from "../../../src/errors/qa-error.js";

const launch = vi.hoisted(() => vi.fn());

vi.mock("playwright", () => ({
  chromium: {
    launch,
  },
}));

import { startBrowser } from "../../../src/playwright/runtime.js";

type FakeBrowser = {
  pageClose: () => Promise<void>;
  contextClose: () => Promise<void>;
  browserClose: () => Promise<void>;
  connected: () => boolean;
  pid: number;
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  launch.mockReset();
});

test("close waits for Chromium to disconnect", async () => {
  let connected = true;
  installBrowser({
    pageClose: async () => undefined,
    contextClose: async () => undefined,
    browserClose: async () => {
      connected = false;
    },
    connected: () => connected,
    pid: 4242,
  });
  const kill = vi.spyOn(process, "kill").mockImplementation(() => {
    throw new Error("process.kill should not run");
  });

  const session = await startBrowser({ headless: true });
  await session.close();

  expect(session.browser.isConnected()).toBe(false);
  expect(kill).not.toHaveBeenCalled();
});

test("a close that leaves Chromium connected fails", async () => {
  installBrowser({
    pageClose: async () => undefined,
    contextClose: async () => undefined,
    browserClose: async () => undefined,
    connected: () => true,
    pid: 4242,
  });

  const session = await startBrowser({ headless: true });
  const pending = session.close();

  await expect(pending).rejects.toBeInstanceOf(QaError);
  await expect(pending).rejects.toMatchObject({
    code: "BROWSER_CRASHED",
    message: "Failed to close Chromium.",
  });
});

test(
  "a hung close kills the browser process group and returns",
  async () => {
    vi.useFakeTimers();
    let connected = true;
    installBrowser({
      pageClose: async () => undefined,
      contextClose: async () => undefined,
      browserClose: () => new Promise(() => undefined),
      connected: () => connected,
      pid: 4242,
    });
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      expect(pid).toBe(-4242);
      expect(signal).toBe("SIGKILL");
      connected = false;
      return true;
    });

    const session = await startBrowser({ headless: true });
    const pending = session.close();
    await vi.advanceTimersByTimeAsync(6_000);
    await pending;

    expect(kill).toHaveBeenCalledWith(-4242, "SIGKILL");
    expect(session.browser.isConnected()).toBe(false);
  },
  15_000,
);

function installBrowser(fake: FakeBrowser): void {
  const browser = {
    isConnected: () => fake.connected(),
    close: () => fake.browserClose(),
    newContext: async () => ({
      setDefaultTimeout: () => undefined,
      setDefaultNavigationTimeout: () => undefined,
      close: () => fake.contextClose(),
      newPage: async () => ({
        close: () => fake.pageClose(),
      }),
    }),
    _connection: {
      toImpl: () => ({
        options: {
          browserProcess: {
            process: { pid: fake.pid, kill: vi.fn() },
          },
        },
      }),
    },
  };
  launch.mockResolvedValue(browser);
}
