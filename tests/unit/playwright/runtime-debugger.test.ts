import { afterEach, expect, test, vi } from "vitest";
import { QaError } from "../../../src/errors/qa-error.js";

const launch = vi.hoisted(() => vi.fn());

vi.mock("playwright", () => ({
  chromium: {
    launch,
  },
}));

import { startBrowser } from "../../../src/playwright/runtime.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  launch.mockReset();
});

test("a debugger websocket on another port is rejected", async () => {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const requested = new URL(String(input));
    calls.push(requested.port);
    return jsonResponse({
      webSocketDebuggerUrl: `ws://127.0.0.1:${otherPort(requested.port)}/devtools/browser/other`,
    });
  });
  installBrowser();

  const pending = startBrowser({
    headless: true,
    timeoutMs: 350,
    remoteDebugging: true,
  });

  await expect(pending).rejects.toBeInstanceOf(QaError);
  await expect(pending).rejects.toMatchObject({
    code: "BROWSER_CRASHED",
    message: "Chromium did not expose a loopback websocket debugger URL.",
  });
  expect(calls.length).toBeGreaterThan(1);
});

test("a debugger websocket on the expected port is accepted", async () => {
  let expectedPort = "";
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const requested = new URL(String(input));
    expectedPort = requested.port;
    return jsonResponse({
      webSocketDebuggerUrl: `ws://127.0.0.1:${requested.port}/devtools/browser/local`,
    });
  });
  installBrowser();

  const session = await startBrowser({
    headless: true,
    timeoutMs: 1_000,
    remoteDebugging: true,
  });
  try {
    expect(session.cdpUrl).toBe(
      `ws://127.0.0.1:${expectedPort}/devtools/browser/local`,
    );
  } finally {
    await session.close();
  }
});

function otherPort(port: string): string {
  return port === "65535" ? "65534" : String(Number(port) + 1);
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function installBrowser(): void {
  let connected = true;
  launch.mockResolvedValue({
    isConnected: () => connected,
    close: async () => {
      connected = false;
    },
    newContext: async () => ({
      setDefaultTimeout: () => undefined,
      setDefaultNavigationTimeout: () => undefined,
      close: async () => undefined,
      newPage: async () => ({
        close: async () => undefined,
      }),
    }),
  });
}
