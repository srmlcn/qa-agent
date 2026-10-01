import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { QaError } from "../../../src/errors/qa-error.js";
import { startBrowser } from "../../../src/playwright/runtime.js";

const LAUNCH_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 60_000;

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

test(
  "close() disconnects Chromium after opening about:blank",
  async () => {
    const session = await startBrowser({
      headless: true,
      timeoutMs: LAUNCH_TIMEOUT_MS,
    });
    try {
      await session.page.goto("about:blank");
      expect(session.page.url()).toBe("about:blank");
      expect(session.browser.isConnected()).toBe(true);
    } finally {
      await session.close();
    }
    expect(session.browser.isConnected()).toBe(false);
  },
  TEST_TIMEOUT_MS,
);

test(
  "aborting the signal closes the browser",
  async () => {
    const controller = new AbortController();
    const session = await startBrowser({
      headless: true,
      timeoutMs: LAUNCH_TIMEOUT_MS,
      signal: controller.signal,
    });
    try {
      expect(session.browser.isConnected()).toBe(true);
      controller.abort();
      await expect
        .poll(() => session.browser.isConnected(), { timeout: 10_000 })
        .toBe(false);
    } finally {
      await session.close();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "a second close() does not throw",
  async () => {
    const session = await startBrowser({
      headless: true,
      timeoutMs: LAUNCH_TIMEOUT_MS,
    });
    try {
      await session.page.goto("about:blank");
      await session.close();
      await expect(session.close()).resolves.toBeUndefined();
      expect(session.browser.isConnected()).toBe(false);
    } finally {
      await session.close();
    }
  },
  TEST_TIMEOUT_MS,
);

test("firefox and webkit are rejected", async () => {
  for (const browser of ["firefox", "webkit"]) {
    const pending = startBrowser({ browser, headless: true });
    await expect(pending).rejects.toBeInstanceOf(QaError);
    await expect(pending).rejects.toMatchObject({
      code: "POLICY_BLOCKED",
      recoveryAppropriate: false,
    });
    await expect(pending).rejects.toThrow(browser);
  }
});

test("the runtime module does not import Stagehand or an LLM client", () => {
  const sourcePath = fileURLToPath(
    new URL("../../../src/playwright/runtime.ts", import.meta.url),
  );
  const source = readFileSync(sourcePath, "utf8");
  expect(source).not.toContain("import(");
  expect(importSpecifiers(source).sort()).toEqual([
    "../errors/qa-error.js",
    "../runtime/paths.js",
    "node:fs",
    "node:net",
    "playwright",
  ]);
});

test(
  "forwards a storageState path into the browser context",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "qa-storage-state-"));
    const storageState = join(directory, "state.json");
    writeFileSync(
      storageState,
      JSON.stringify({
        cookies: [
          {
            name: "session",
            value: "abc",
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

    const session = await startBrowser({
      headless: true,
      timeoutMs: LAUNCH_TIMEOUT_MS,
      storageState,
    });
    try {
      const cookies = await session.context.cookies("https://example.com");
      expect(cookies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "session", value: "abc" }),
        ]),
      );
    } finally {
      await session.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "context creation failure closes Chromium",
  async () => {
    const before = browserPids();
    const missing = join(
      tmpdir(),
      `qa-missing-state-${process.pid}-${Date.now()}.json`,
    );
    await expect(
      startBrowser({
        headless: true,
        timeoutMs: LAUNCH_TIMEOUT_MS,
        storageState: missing,
      }),
    ).rejects.toThrow();
    await expect.poll(() => extraPids(before), { timeout: 10_000 }).toEqual([]);
  },
  TEST_TIMEOUT_MS,
);

test(
  "an aborted signal during launch does not leave Chromium running",
  async () => {
    const controller = new AbortController();
    const before = browserPids();
    const pending = startBrowser({
      headless: true,
      timeoutMs: LAUNCH_TIMEOUT_MS,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "RUN_CANCELLED" });
    await expect.poll(() => extraPids(before), { timeout: 10_000 }).toEqual([]);
  },
  TEST_TIMEOUT_MS,
);

test(
  "remote debugging publishes the loopback websocket URL",
  async () => {
    const session = await startBrowser({
      headless: true,
      timeoutMs: LAUNCH_TIMEOUT_MS,
      remoteDebugging: true,
    });
    try {
      const cdpUrl = session.cdpUrl;
      expect(cdpUrl).toEqual(expect.any(String));
      if (cdpUrl === undefined) {
        return;
      }
      const parsed = new URL(cdpUrl);
      expect(parsed.protocol).toBe("ws:");
      expect(parsed.hostname).toBe("127.0.0.1");
      const version = await fetch(`http://127.0.0.1:${parsed.port}/json/version`);
      expect(version.ok).toBe(true);
      const body = (await version.json()) as { webSocketDebuggerUrl?: string };
      expect(body.webSocketDebuggerUrl).toBe(cdpUrl);
    } finally {
      await session.close();
    }
    expect(session.browser.isConnected()).toBe(false);
  },
  TEST_TIMEOUT_MS,
);

test("an already aborted signal does not launch Chromium", async () => {
  const controller = new AbortController();
  controller.abort();
  const before = browserPids();
  await expect(
    startBrowser({
      headless: true,
      timeoutMs: LAUNCH_TIMEOUT_MS,
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ code: "RUN_CANCELLED" });
  expect(extraPids(before)).toEqual([]);
});

test(
  "a missing Chromium executable throws BROWSER_CRASHED",
  () => {
    const script = [
      'import { startBrowser } from "./src/playwright/runtime.ts";',
      "try {",
      "  await startBrowser({ headless: true, timeoutMs: 15000 });",
      "  process.exit(2);",
      "} catch (error) {",
      '  const code = error instanceof Error && "code" in error ? String(error.code) : "";',
      "  const message = error instanceof Error ? error.message : String(error);",
      "  process.stdout.write(JSON.stringify({ code, message }));",
      "  process.exit(0);",
      "}",
    ].join("\n");

    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        cwd: repoRoot,
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: "0" },
        encoding: "utf8",
        timeout: 30_000,
      },
    );

    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout) as { code: string; message: string };
    expect(parsed.code).toBe("BROWSER_CRASHED");
    expect(parsed.message).toContain("npx playwright install chromium");
  },
  TEST_TIMEOUT_MS,
);

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const fromPattern = /\bfrom\s+["']([^"']+)["']/g;
  const sideEffectPattern = /\bimport\s+["']([^"']+)["']/g;
  for (const pattern of [fromPattern, sideEffectPattern]) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) {
        specifiers.push(specifier);
      }
    }
  }
  return specifiers;
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
