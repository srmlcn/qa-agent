import { expect, test } from "vitest";
import { QaError } from "../../../src/errors/qa-error.js";
import { classifyPlaywrightError } from "../../../src/playwright/errors.js";
import { redactBody } from "../../../src/security/redaction.js";

const CONTEXT = {
  runId: "run-1",
  flowId: "flow-1",
  stepId: "step-1",
} as const;

test("AbortError maps to RUN_CANCELLED", () => {
  const message = "The operation was aborted";
  const named = new Error("caller stopped the run");
  named.name = "AbortError";

  for (const error of [new Error(message), named]) {
    const classified = classifyPlaywrightError(error, CONTEXT);
    expect(classified).toBeInstanceOf(QaError);
    expect(classified.code).toBe("RUN_CANCELLED");
    expect(classified.recoveryAppropriate).toBe(false);
    expect(classified.message).toBe(error.message);
  }
});

test("an aborted runtime signal maps to RUN_CANCELLED", () => {
  const controller = new AbortController();
  controller.abort();
  const message = "locator.click: Timeout 30000ms exceeded.";

  const classified = classifyPlaywrightError(new Error(message), {
    ...CONTEXT,
    signal: controller.signal,
  });

  expect(classified.code).toBe("RUN_CANCELLED");
  expect(classified.recoveryAppropriate).toBe(false);
  expect(classified.message).toBe(message);
  expect(classified.runId).toBe(CONTEXT.runId);
  expect(classified.flowId).toBe(CONTEXT.flowId);
  expect(classified.stepId).toBe(CONTEXT.stepId);
});

test("a signal that is not aborted does not cancel the run", () => {
  const controller = new AbortController();
  const message = "locator.click: Timeout 30000ms exceeded.";

  const classified = classifyPlaywrightError(new Error(message), {
    signal: controller.signal,
  });

  expect(classified.code).toBe("TIMEOUT");
  expect(classified.recoveryAppropriate).toBe(false);
});

test("Playwright timeout maps to TIMEOUT", () => {
  const message = "locator.click: Timeout 30000ms exceeded.";
  const named = new Error("waiting until the deadline");
  named.name = "TimeoutError";

  for (const error of [new Error(message), named]) {
    const classified = classifyPlaywrightError(error, CONTEXT);
    expect(classified).toBeInstanceOf(QaError);
    expect(classified.code).toBe("TIMEOUT");
    expect(classified.recoveryAppropriate).toBe(false);
    expect(classified.message).toBe(error.message);
  }

  expect(
    classifyPlaywrightError(
      new Error("page.goto: Navigation timed out after 30000ms."),
    ).code,
  ).toBe("TIMEOUT");
});

test("target closed, browser disconnected, and crash map to BROWSER_CRASHED", () => {
  const messages = [
    "page.click: Target page, context or browser has been closed",
    "page.click: Target closed",
    "browser.newContext: Browser has been closed",
    "browser.newContext: Browser closed.",
    "browser.newContext: Browser disconnected",
    "browser.newContext: Browser has disconnected",
    "browser.newContext: Connection closed",
    "Page crashed",
    "Target crashed",
    "Target crashed\nBrowser logs:\nreceived crash signal",
  ];

  for (const message of messages) {
    const classified = classifyPlaywrightError(new Error(message), CONTEXT);
    expect(classified).toBeInstanceOf(QaError);
    expect(classified.code).toBe("BROWSER_CRASHED");
    expect(classified.recoveryAppropriate).toBe(false);
    expect(classified.message).toBe(message);
  }

  const named = new Error("socket hangup");
  named.name = "TargetClosedError";
  expect(classifyPlaywrightError(named).code).toBe("BROWSER_CRASHED");
});

test("navigation errors map to NAVIGATION_FAILED", () => {
  const messages = [
    'page.goto: net::ERR_CONNECTION_REFUSED at https://example.com/',
    'page.goto: net::ERR_ABORTED at https://example.com/',
    'page.goto: NS_ERROR_CONNECTION_REFUSED at https://example.com/',
    'page.goto: Navigation to "https://example.com/" is interrupted by another navigation to "https://example.com/login"',
    "page.goto: Navigation failed",
    "page.goto: Cannot navigate to invalid URL",
    "page.goto: Download is starting",
  ];

  for (const message of messages) {
    const classified = classifyPlaywrightError(new Error(message), CONTEXT);
    expect(classified).toBeInstanceOf(QaError);
    expect(classified.code).toBe("NAVIGATION_FAILED");
    expect(classified.recoveryAppropriate).toBe(false);
    expect(classified.message).toBe(message);
  }
});

test("locator not found maps to LOCATOR_STALE", () => {
  const messages = [
    "locator.click: Element(s) not found",
    "locator.click: element(s) not found",
    [
      "locator.click: Timeout 30000ms exceeded.",
      "Call log:",
      "  - waiting for locator('button.submit')",
    ].join("\n"),
    [
      "locator.click: Timeout 30000ms exceeded.",
      "Call log:",
      "  - waiting for getByRole('button', { name: 'Save' })",
    ].join("\n"),
    "locator resolved to 0 elements",
  ];

  for (const message of messages) {
    const classified = classifyPlaywrightError(new Error(message), CONTEXT);
    expect(classified).toBeInstanceOf(QaError);
    expect(classified.code).toBe("LOCATOR_STALE");
    expect(classified.recoveryAppropriate).toBe(true);
    expect(classified.message).toBe(message);
  }
});

test("strict-mode violation maps to LOCATOR_STALE", () => {
  const message =
    "locator.click: strict mode violation: locator('button') resolved to 2 elements";
  const classified = classifyPlaywrightError(new Error(message), CONTEXT);

  expect(classified).toBeInstanceOf(QaError);
  expect(classified.code).toBe("LOCATOR_STALE");
  expect(classified.recoveryAppropriate).toBe(true);
  expect(classified.message).toBe(message);
});

test("detached element maps to LOCATOR_STALE", () => {
  const messages = [
    "locator.click: Element is not attached to the DOM",
    "element was detached from the DOM, retrying",
  ];

  for (const message of messages) {
    const classified = classifyPlaywrightError(new Error(message), CONTEXT);
    expect(classified).toBeInstanceOf(QaError);
    expect(classified.code).toBe("LOCATOR_STALE");
    expect(classified.recoveryAppropriate).toBe(true);
    expect(classified.message).toBe(message);
  }
});

test("anything else maps to PAGE_ERROR", () => {
  const message = "page.evaluate: ReferenceError: missing is not defined";
  const classified = classifyPlaywrightError(new Error(message), CONTEXT);

  expect(classified).toBeInstanceOf(QaError);
  expect(classified.code).toBe("PAGE_ERROR");
  expect(classified.recoveryAppropriate).toBe(false);
  expect(classified.message).toBe(message);

  const unknown = classifyPlaywrightError(undefined);
  expect(unknown.code).toBe("PAGE_ERROR");
  expect(unknown.recoveryAppropriate).toBe(false);
  expect(unknown.message).toBe("Unknown Playwright failure");
});

test("LOCATOR_STALE is the only mapped code with recoveryAppropriate true", () => {
  const cases = [
    { message: "The operation was aborted", code: "RUN_CANCELLED" },
    { message: "locator.click: Timeout 30000ms exceeded.", code: "TIMEOUT" },
    {
      message: "page.click: Target page, context or browser has been closed",
      code: "BROWSER_CRASHED",
    },
    { message: "browser.newContext: Browser disconnected", code: "BROWSER_CRASHED" },
    { message: "Page crashed", code: "BROWSER_CRASHED" },
    {
      message: "page.goto: net::ERR_CONNECTION_REFUSED at https://example.com/",
      code: "NAVIGATION_FAILED",
    },
    { message: "locator.click: Element(s) not found", code: "LOCATOR_STALE" },
    {
      message:
        "locator.click: strict mode violation: locator('button') resolved to 2 elements",
      code: "LOCATOR_STALE",
    },
    {
      message: "locator.click: Element is not attached to the DOM",
      code: "LOCATOR_STALE",
    },
    {
      message: "page.evaluate: ReferenceError: missing is not defined",
      code: "PAGE_ERROR",
    },
  ] as const;

  const recoveryCodes = new Set<string>();
  for (const entry of cases) {
    const classified = classifyPlaywrightError(new Error(entry.message));
    expect(classified.code).toBe(entry.code);
    expect(classified.recoveryAppropriate).toBe(entry.code === "LOCATOR_STALE");
    if (classified.recoveryAppropriate) {
      recoveryCodes.add(classified.code);
    }
  }

  expect([...recoveryCodes]).toEqual(["LOCATOR_STALE"]);
});

test("preserves runId, flowId, and stepId from context when provided", () => {
  const message = "page.evaluate: ReferenceError: missing is not defined";
  const classified = classifyPlaywrightError(new Error(message), {
    runId: "run-9",
    flowId: "flow-2",
    stepId: "step-3",
  });

  expect(classified.toJSON()).toEqual({
    code: "PAGE_ERROR",
    message,
    runId: "run-9",
    flowId: "flow-2",
    stepId: "step-3",
    recoveryAppropriate: false,
  });
  expect(JSON.parse(JSON.stringify(classified))).toEqual(classified.toJSON());
});

test("omits ids that context does not provide", () => {
  const message = "page.evaluate: ReferenceError: missing is not defined";
  const classified = classifyPlaywrightError(new Error(message), {
    runId: "run-4",
  });

  expect(classified.flowId).toBeUndefined();
  expect(classified.stepId).toBeUndefined();
  expect(classified.toJSON()).toEqual({
    code: "PAGE_ERROR",
    message,
    runId: "run-4",
    recoveryAppropriate: false,
  });
});

test("includes the original message truncated to 500 characters after redactBody", () => {
  const secret = "hunter2-password-value";
  const original = `page.evaluate: {"password":"${secret}"} ${"x".repeat(600)}`;
  const expected = redactBody(original, Number.POSITIVE_INFINITY).slice(0, 500);
  const classified = classifyPlaywrightError(new Error(original));

  expect(expected.length).toBe(500);
  expect(classified.message).toBe(expected);
  expect(classified.message.startsWith("page.evaluate:")).toBe(true);
  expect(classified.message).toContain('{"password":"[redacted]"}');
  expect(classified.message).not.toContain(secret);
  expect(classified.code).toBe("PAGE_ERROR");
});

test("passes a short message through redactBody and keeps the original text", () => {
  const secret = "top-secret-token";
  const original = `page.goto: Authorization: Bearer ${secret} failed`;
  const classified = classifyPlaywrightError(new Error(original));

  expect(classified.message).toBe(redactBody(original, Number.POSITIVE_INFINITY));
  expect(classified.message).toBe("page.goto: Authorization: [redacted]");
  expect(classified.message).toContain("page.goto:");
  expect(classified.message).not.toContain(secret);
  expect(classified.message.length).toBeLessThanOrEqual(500);
});

test("keeps a 500 character message and drops the 501st character", () => {
  const exact = "n".repeat(500);
  const longer = `${exact}Z`;

  expect(classifyPlaywrightError(new Error(exact)).message).toBe(exact);
  expect(classifyPlaywrightError(new Error(longer)).message).toBe(exact);
  expect(classifyPlaywrightError(new Error(longer)).message).not.toContain("Z");
});
