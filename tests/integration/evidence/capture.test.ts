import { expect, test } from "vitest";
import { applyCapture } from "../../../src/evidence/console.js";
import { startCapture, type CaptureSession } from "../../../src/evidence/network.js";
import { startRun } from "../../../src/evidence/result.js";
import {
  startBrowser,
  type BrowserSession,
} from "../../../src/playwright/runtime.js";
import type { Page } from "playwright";

const LAUNCH_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 60_000;
const POLL_TIMEOUT_MS = 5_000;
const HOST = "https://qa-agent.test";
const FAIL_URL = `${HOST}/fail`;
const SECURE_URL = `${HOST}/secure`;
const COOKIE_URL = `${HOST}/cookie`;
const BIG_URL = `${HOST}/big`;
const BINARY_URL = `${HOST}/binary`;
const SMALL_URL = `${HOST}/small`;
const AUTH_SECRET = "Bearer auth-header-secret-9f3a";
const COOKIE_SECRET = "cookie-header-secret-9f3a";
const SET_COOKIE_SECRET = "set-cookie-header-secret-9f3a";
const JSON_PASSWORD = "json-password-secret-9f3a";
const OVERSIZED_SECRET = "oversized-body-secret-9f3a";
const BINARY_SECRET = "binary-body-secret-9f3a";

test(
  "a page that console.errors and requests a failing URL produces both records",
  async () => {
    await withPage(async (page) => {
      const session = await startCapture(page, evidenceOptions(1024));
      try {
        await page.route(FAIL_URL, (route) => route.abort("failed"));
        await page.setContent(`<!doctype html><script>
          console.error("console-error-marker");
          console.warn("console-warn-marker");
          console.log("console-log-marker");
          console.debug("console-debug-marker");
          setTimeout(() => { throw new Error("page-error-marker"); }, 0);
          fetch(${JSON.stringify(FAIL_URL)}).catch(() => undefined);
        </script>`);

        await expect
          .poll(() => hasConsoleError(session, "console-error-marker"), {
            timeout: POLL_TIMEOUT_MS,
          })
          .toBe(true);
        await expect
          .poll(() => hasFailure(session, FAIL_URL), { timeout: POLL_TIMEOUT_MS })
          .toBe(true);
        await expect
          .poll(
            () =>
              session.capture.pageErrors.some((record) =>
                record.message.includes("page-error-marker"),
              ),
            { timeout: POLL_TIMEOUT_MS },
          )
          .toBe(true);
        await session.stop();

        const error = session.capture.console.errors.find((record) =>
          record.text.includes("console-error-marker"),
        );
        expect(error).toMatchObject({
          level: "error",
          text: "console-error-marker",
        });
        expect(session.capture.console.warnings).toContainEqual(
          expect.objectContaining({
            level: "warning",
            text: "console-warn-marker",
          }),
        );
        const serialized = JSON.stringify(session.capture);
        expect(serialized).not.toContain("console-log-marker");
        expect(serialized).not.toContain("console-debug-marker");

        const failure = session.capture.network.failedRequests.find(
          (record) => record.url === FAIL_URL,
        );
        expect(failure?.method).toBe("GET");
        expect(failure?.status).toBe(0);
        expect(typeof failure?.timing).toBe("number");
        expect(failure?.body?.toLowerCase()).toContain("fail");

        const run = startRun({
          runId: "run-evidence",
          flowId: "evidence-capture",
        }).finish();
        run.network.failedRequests.push({
          method: "POST",
          url: `${HOST}/existing`,
          status: 500,
          timing: 1,
          headers: { authorization: "[redacted]" },
        });
        expect(applyCapture(run, session.capture)).toBe(run);
        expect(run.network.failedRequests[0]?.url).toBe(`${HOST}/existing`);
        expect(run.network.failedRequests.some((record) => record.url === FAIL_URL)).toBe(
          true,
        );
        expect(
          run.console.errors.some((record) => record.text === "console-error-marker"),
        ).toBe(true);
        expect(
          run.pageErrors.some((record) => record.message.includes("page-error-marker")),
        ).toBe(true);
        expect(run.steps).toEqual([]);
        expect(run.status).toBe("passed");
      } finally {
        await session.stop();
      }
    });
  },
  TEST_TIMEOUT_MS,
);

test(
  "an authorization request header is stored as [redacted]",
  async () => {
    await withPage(async (page) => {
      const session = await startCapture(page, evidenceOptions(1024));
      try {
        await page.route(SECURE_URL, (route) => {
          if (route.request().method() === "OPTIONS") {
            return route.fulfill({
              status: 204,
              headers: {
                "access-control-allow-origin": "*",
                "access-control-allow-headers": "authorization",
                "access-control-allow-methods": "GET, OPTIONS",
              },
            });
          }
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            headers: { "access-control-allow-origin": "*" },
            body: JSON.stringify({ password: JSON_PASSWORD, ok: true }),
          });
        });
        await page.setContent("<!doctype html><title>capture</title>");
        await page.evaluate(async (url) => {
          await fetch(url, {
            headers: { Authorization: "Bearer auth-header-secret-9f3a" },
          });
        }, SECURE_URL);

        await expect
          .poll(() => secureRecord(session), { timeout: POLL_TIMEOUT_MS })
          .toBeTruthy();
        await session.stop();

        const record = secureRecord(session);
        expect(header(record?.headers ?? {}, "authorization")).toBe("[redacted]");
        expect(record?.body).toContain("[redacted]");
        expect(record?.body).toContain("ok");
        expect(record?.bodyOmitted).toBeUndefined();
        expect(record?.headers["content-type"]?.toLowerCase()).toContain(
          "application/json",
        );
        const serialized = JSON.stringify(record);
        expect(serialized).not.toContain(AUTH_SECRET);
        expect(serialized).not.toContain("auth-header-secret-9f3a");
        expect(serialized).not.toContain(JSON_PASSWORD);
      } finally {
        await session.stop();
      }
    });
  },
  TEST_TIMEOUT_MS,
);

test(
  "a response larger than the cap stores no body",
  async () => {
    const cap = 64;
    await withPage(async (page) => {
      const session = await startCapture(page, evidenceOptions(cap));
      try {
        await page.route(BIG_URL, (route) =>
          route.fulfill({
            status: 200,
            contentType: "text/plain",
            body: `${OVERSIZED_SECRET}${"y".repeat(cap)}`,
          }),
        );
        await page.route(BINARY_URL, (route) =>
          route.fulfill({
            status: 200,
            contentType: "application/octet-stream",
            body: BINARY_SECRET,
          }),
        );
        await page.route(SMALL_URL, (route) =>
          route.fulfill({
            status: 200,
            contentType: "text/plain",
            body: "hello-body",
          }),
        );
        await page.setContent("<!doctype html><title>capture</title>");
        await page.evaluate(
          async (urls) => {
            await fetch(urls.big);
            await fetch(urls.binary);
            await fetch(urls.small);
          },
          { big: BIG_URL, binary: BINARY_URL, small: SMALL_URL },
        );

        await expect
          .poll(() => responseFor(session, SMALL_URL)?.body, {
            timeout: POLL_TIMEOUT_MS,
          })
          .toBe("hello-body");
        await expect
          .poll(() => responseFor(session, BIG_URL)?.bodyOmitted, {
            timeout: POLL_TIMEOUT_MS,
          })
          .toBe(true);
        await expect
          .poll(() => responseFor(session, BINARY_URL)?.bodyOmitted, {
            timeout: POLL_TIMEOUT_MS,
          })
          .toBe(true);
        await session.stop();

        const big = responseFor(session, BIG_URL);
        expect(big?.status).toBe(200);
        expect(big?.body).toBeUndefined();
        expect(Object.hasOwn(big ?? {}, "body")).toBe(false);
        expect(big?.bodyOmitted).toBe(true);

        const binary = responseFor(session, BINARY_URL);
        expect(binary?.body).toBeUndefined();
        expect(binary?.bodyOmitted).toBe(true);

        const small = responseFor(session, SMALL_URL);
        expect(small?.body).toBe("hello-body");
        expect(small?.bodyOmitted).toBeUndefined();
        expect(small?.headers["content-type"]?.toLowerCase()).toContain("text/plain");

        const serialized = JSON.stringify(session.capture);
        expect(serialized).not.toContain(OVERSIZED_SECRET);
        expect(serialized).not.toContain(BINARY_SECRET);
      } finally {
        await session.stop();
      }
    });
  },
  TEST_TIMEOUT_MS,
);

test(
  "cookie header values do not appear in the JSON serialization of the result",
  async () => {
    await withPage(async (page) => {
      const session = await startCapture(page, evidenceOptions(1024));
      try {
        await page.context().addCookies([
          {
            name: "session",
            value: COOKIE_SECRET,
            domain: "qa-agent.test",
            path: "/",
            secure: true,
            sameSite: "Lax",
          },
        ]);
        await page.setExtraHTTPHeaders({
          cookie: `session=${COOKIE_SECRET}`,
        });
        await page.route(COOKIE_URL, (route) =>
          route.fulfill({
            status: 200,
            contentType: "text/plain",
            headers: {
              "set-cookie": `session=${SET_COOKIE_SECRET}; Path=/; HttpOnly`,
            },
            body: "ok",
          }),
        );
        await page.setContent("<!doctype html><title>capture</title>");
        await page.evaluate(async (url) => {
          await fetch(url);
        }, COOKIE_URL);

        await expect
          .poll(() => responseFor(session, COOKIE_URL)?.body, {
            timeout: POLL_TIMEOUT_MS,
          })
          .toBe("ok");
        await session.stop();

        const record = responseFor(session, COOKIE_URL);
        expect(header(record?.headers ?? {}, "cookie")).toBe("[redacted]");
        expect(header(record?.headers ?? {}, "set-cookie")).toBe("[redacted]");

        const run = startRun({
          runId: "run-cookies",
          flowId: "evidence-capture",
        }).finish();
        applyCapture(run, session.capture);
        const serialized = JSON.stringify(run);
        expect(serialized).not.toContain(COOKIE_SECRET);
        expect(serialized).not.toContain(SET_COOKIE_SECRET);
      } finally {
        await session.stop();
      }
    });
  },
  TEST_TIMEOUT_MS,
);

test(
  "network and console flags skip those records",
  async () => {
    await withPage(async (page) => {
      const session = await startCapture(page, {
        evidence: {
          network: false,
          console: false,
          maxResponseBodyBytes: 1024,
        },
      });
      try {
        await page.route(SMALL_URL, (route) =>
          route.fulfill({
            status: 200,
            contentType: "text/plain",
            body: OVERSIZED_SECRET,
          }),
        );
        await page.setContent(`<!doctype html><script>
          console.error("console-error-marker");
          setTimeout(() => { throw new Error("page-error-marker"); }, 0);
        </script>`);
        await page.evaluate(async (url) => {
          await fetch(url);
        }, SMALL_URL);
        await expect
          .poll(
            () =>
              session.capture.pageErrors.some((record) =>
                record.message.includes("page-error-marker"),
              ),
            { timeout: POLL_TIMEOUT_MS },
          )
          .toBe(true);
        await new Promise((resolve) => {
          setTimeout(resolve, 300);
        });
        await session.stop();

        expect(session.capture.network.responses).toEqual([]);
        expect(session.capture.network.failedRequests).toEqual([]);
        expect(session.capture.console.errors).toEqual([]);
        expect(session.capture.console.warnings).toEqual([]);
        expect(JSON.stringify(session.capture)).not.toContain(OVERSIZED_SECRET);
        expect(JSON.stringify(session.capture)).not.toContain("console-error-marker");
      } finally {
        await session.stop();
      }
    });
  },
  TEST_TIMEOUT_MS,
);

function evidenceOptions(maxResponseBodyBytes: number): {
  evidence: {
    network: boolean;
    console: boolean;
    maxResponseBodyBytes: number;
  };
} {
  return {
    evidence: { network: true, console: true, maxResponseBodyBytes },
  };
}

function hasConsoleError(session: CaptureSession, text: string): boolean {
  return session.capture.console.errors.some((record) => record.text.includes(text));
}

function hasFailure(session: CaptureSession, url: string): boolean {
  return session.capture.network.failedRequests.some((record) => record.url === url);
}

function responseFor(
  session: CaptureSession,
  url: string,
): CaptureSession["capture"]["network"]["responses"][number] | undefined {
  return session.capture.network.responses.find(
    (record) => record.url === url && record.method === "GET",
  );
}

function secureRecord(
  session: CaptureSession,
): CaptureSession["capture"]["network"]["responses"][number] | undefined {
  return session.capture.network.responses.find(
    (record) =>
      record.url === SECURE_URL &&
      record.method === "GET" &&
      record.body !== undefined,
  );
}

function header(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }
  return undefined;
}

async function withPage(run: (page: Page) => Promise<void>): Promise<void> {
  const session: BrowserSession = await startBrowser({
    headless: true,
    timeoutMs: LAUNCH_TIMEOUT_MS,
  });
  try {
    await run(session.page);
  } finally {
    await session.close();
  }
}
