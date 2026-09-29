import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  attachPageEvents,
  type BrowserEvent,
} from "../../../src/playwright/events.js";
import { startBrowser } from "../../../src/playwright/runtime.js";

const LAUNCH_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 60_000;
const DATA_URL = "data:text/plain,ping";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

test(
  "an inline page logs one console error and fetches one data URL",
  async () => {
    const before = snapshotRepo(repoRoot);
    const session = await startBrowser({
      headless: true,
      timeoutMs: LAUNCH_TIMEOUT_MS,
    });
    const events: BrowserEvent[] = [];
    try {
      const detach = await attachPageEvents(session.page, (event) => {
        events.push(event);
      });
      await session.page.setContent(
        `<!doctype html><script>
          console.error("evidence-marker");
          fetch(${JSON.stringify(DATA_URL)});
        </script>`,
      );

      await expect
        .poll(() => countEvents(events), { timeout: 5_000 })
        .toEqual({ console: 1, request: 1 });
      await expect
        .poll(
          () =>
            events.some(
              (event) => event.type === "response" && event.url === DATA_URL,
            ),
          { timeout: 5_000 },
        )
        .toBe(true);

      const consoleEvent = events.find((event) => event.type === "console");
      const requestEvent = events.find((event) => event.type === "request");
      expect(consoleEvent).toMatchObject({
        type: "console",
        consoleType: "error",
        text: "evidence-marker",
      });
      expect(requestEvent).toMatchObject({
        type: "request",
        url: DATA_URL,
        method: "GET",
      });
      expect(typeof consoleEvent?.timestamp).toBe("string");
      expect(Number.isNaN(Date.parse(consoleEvent?.timestamp ?? ""))).toBe(
        false,
      );
      expect(typeof requestEvent?.resourceType).toBe("string");

      const responseEvent = events.find(
        (event) => event.type === "response" && event.url === DATA_URL,
      );
      expect(responseEvent?.status).toBe(200);
      expect(responseEvent?.headers).toBeTypeOf("object");
      expect(responseEvent?.headers).not.toBeInstanceOf(Map);
      expect(responseEvent && "body" in responseEvent).toBe(false);

      const seen = events.length;
      detach();
      detach();
      await session.page.goto(
        `data:text/html,${encodeURIComponent(
          `<script>console.error("after-detach");fetch(${JSON.stringify(DATA_URL)});</script>`,
        )}`,
      );
      await new Promise((resolve) => {
        setTimeout(resolve, 300);
      });
      expect(events).toHaveLength(seen);
      expect(snapshotRepo(repoRoot)).toEqual(before);
    } finally {
      await session.close();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "a listener exception is emitted as a runtime event and does not break the page",
  async () => {
    const session = await startBrowser({
      headless: true,
      timeoutMs: LAUNCH_TIMEOUT_MS,
    });
    const events: BrowserEvent[] = [];
    let calls = 0;
    try {
      await attachPageEvents(session.page, (event) => {
        calls += 1;
        events.push(event);
        if (event.type === "console") {
          throw new Error("listener blew up");
        }
        if (event.type === "runtime") {
          throw new Error("runtime listener blew up");
        }
      });
      await session.page.setContent(
        `<!doctype html><script>console.error("evidence-marker");</script>`,
      );
      await expect
        .poll(() =>
          events.some(
            (event) =>
              event.type === "runtime" &&
              event.errorMessage === "listener blew up",
          ),
        )
        .toBe(true);
      expect(calls).toBeLessThan(10);
      await expect(session.page.evaluate(() => 1 + 1)).resolves.toBe(2);
    } finally {
      await session.close();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "navigation, page errors, failed requests, and response headers are plain facts",
  async () => {
    const session = await startBrowser({
      headless: true,
      timeoutMs: LAUNCH_TIMEOUT_MS,
    });
    const events: BrowserEvent[] = [];
    try {
      const detach = await attachPageEvents(session.page, (event) => {
        events.push(event);
      });
      await session.page.route("https://qa-agent.test/fail", (route) =>
        route.abort("failed"),
      );
      await session.page.route("https://qa-agent.test/ok", (route) =>
        route.fulfill({
          status: 201,
          headers: {
            "x-trace": "abc",
            "content-type": "text/plain",
            "access-control-allow-origin": "*",
          },
          body: "secret-body",
        }),
      );

      await session.page.goto("data:text/html,<title>nav</title>");
      await session.page.setContent(
        `<!doctype html><script>setTimeout(() => { throw new Error("page-boom"); }, 0);</script>`,
      );
      await session.page.evaluate(async () => {
        await fetch("https://qa-agent.test/fail").catch(() => undefined);
        await fetch("https://qa-agent.test/ok");
      });

      await expect
        .poll(() => events.some((event) => event.type === "pageerror"))
        .toBe(true);

      expect(
        events.some(
          (event) =>
            event.type === "framenavigated" &&
            event.url === "data:text/html,<title>nav</title>",
        ),
      ).toBe(true);
      expect(
        events.some(
          (event) =>
            event.type === "pageerror" &&
            event.errorMessage?.includes("page-boom") === true,
        ),
      ).toBe(true);

      const failed = events.filter(
        (event) =>
          event.type === "requestfailed" &&
          event.url === "https://qa-agent.test/fail",
      );
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({
        method: "GET",
        resourceType: "fetch",
      });
      expect(failed[0]?.errorMessage).toBeTruthy();

      const okRequests = events.filter(
        (event) =>
          event.type === "request" && event.url === "https://qa-agent.test/ok",
      );
      expect(okRequests).toHaveLength(1);
      const okResponse = events.find(
        (event) =>
          event.type === "response" && event.url === "https://qa-agent.test/ok",
      );
      expect(okResponse).toMatchObject({
        status: 201,
        method: "GET",
        headers: { "x-trace": "abc" },
      });
      expect(okResponse?.headers).not.toBeNull();
      expect(Object.getPrototypeOf(okResponse?.headers)).toBe(Object.prototype);
      expect(JSON.stringify(events)).not.toContain("secret-body");

      detach();
    } finally {
      await session.close();
    }
  },
  TEST_TIMEOUT_MS,
);

test("the events module does not write files or read response bodies", () => {
  const sourcePath = fileURLToPath(
    new URL("../../../src/playwright/events.ts", import.meta.url),
  );
  const source = readFileSync(sourcePath, "utf8");
  expect(source).not.toContain("import(");
  expect(source).not.toContain("src/evidence");
  expect(source).not.toContain("node:fs");
  expect(source).not.toMatch(/\b(writeFile|appendFile|createWriteStream|mkdir)Sync?\b/);
  expect(source).not.toContain(".body(");
  expect(source).not.toContain("getResponseBody");
  expect(source).not.toContain("response.text(");
  expect(source).not.toContain("response.json(");
  expect(importSpecifiers(source).sort()).toEqual(["playwright"]);
});

function countEvents(events: readonly BrowserEvent[]): {
  console: number;
  request: number;
} {
  return {
    console: events.filter((event) => event.type === "console").length,
    request: events.filter((event) => event.type === "request").length,
  };
}

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

function snapshotRepo(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        entry.name === "node_modules" ||
        entry.name === ".git" ||
        entry.name === "dist" ||
        entry.name === "test-results" ||
        entry.name === "playwright-report"
      ) {
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const stat = statSync(path);
      files.push(`${path}:${stat.size}:${stat.mtimeMs}`);
    }
  };
  walk(root);
  return files.sort();
}
