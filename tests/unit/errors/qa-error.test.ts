import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import * as codesModule from "../../../src/errors/codes.js";
import * as qaErrorModule from "../../../src/errors/qa-error.js";

const { QA_ERROR_CODES } = codesModule;
const { QaError } = qaErrorModule;
type QaErrorCode = (typeof QA_ERROR_CODES)[number];

const CODES = [
  "DISCOVERY_FAILED",
  "FLOW_COMPILE_FAILED",
  "FLOW_VALIDATION_FAILED",
  "LOCATOR_STALE",
  "ASSERTION_FAILED",
  "AUTH_EXPIRED",
  "AUTH_MISSING",
  "NETWORK_FAILURE",
  "PAGE_ERROR",
  "NAVIGATION_FAILED",
  "TIMEOUT",
  "BROWSER_CRASHED",
  "LLM_PROVIDER_UNAVAILABLE",
  "LLM_RATE_LIMITED",
  "POLICY_BLOCKED",
  "RUN_CANCELLED",
] as const satisfies readonly QaErrorCode[];

const JSON_KEYS = [
  "code",
  "message",
  "runId",
  "flowId",
  "stepId",
  "artifacts",
  "recoveryAppropriate",
] as const;

const COOKIE_LIKE_KEY = /cookie/i;

test("codes are exactly the spec section 11 set", () => {
  expect([...QA_ERROR_CODES]).toEqual([...CODES]);
});

for (const code of CODES) {
  test(`${code} constructs a QaError and sets recoveryAppropriate`, () => {
    const error = new QaError({
      code,
      message: "safe log message",
      runId: "run-1",
      flowId: "flow-1",
      stepId: "step-1",
      artifacts: ["evidence/run-1/trace.zip"],
    });

    expect(error).toBeInstanceOf(QaError);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe(code);
    expect(error.message).toBe("safe log message");
    expect(error.recoveryAppropriate).toBe(code === "LOCATOR_STALE");

    const json = error.toJSON();
    expect(json.code).toBe(code);
    expect(json.recoveryAppropriate).toBe(code === "LOCATOR_STALE");
    assertStructuredJson(json);
    assertStructuredJson(JSON.parse(JSON.stringify(error)));
  });
}

test("assertion, navigation, and page errors are not recovery", () => {
  for (const code of [
    "ASSERTION_FAILED",
    "NAVIGATION_FAILED",
    "PAGE_ERROR",
  ] as const) {
    expect(
      new QaError({ code, message: "failed closed" }).recoveryAppropriate,
    ).toBe(false);
  }

  expect(
    new QaError({ code: "LOCATOR_STALE", message: "locator missed" })
      .recoveryAppropriate,
  ).toBe(true);
});

test("toJSON returns only structured fields and omits stack", () => {
  const error = new QaError({
    code: "TIMEOUT",
    message: "step timed out",
  });

  expect(error.stack).toEqual(expect.any(String));
  expect(error.toJSON()).toEqual({
    code: "TIMEOUT",
    message: "step timed out",
    recoveryAppropriate: false,
  });

  const parsed = JSON.parse(JSON.stringify(error)) as Record<string, unknown>;
  expect(parsed).toEqual({
    code: "TIMEOUT",
    message: "step timed out",
    recoveryAppropriate: false,
  });
  assertStructuredJson(parsed);
  expect(parsed).not.toHaveProperty("stack");
  expect(parsed).not.toHaveProperty("cookie");
  expect(parsed).not.toHaveProperty("cookies");
});

test("toJSON keeps supplied ids and artifact paths", () => {
  const error = new QaError({
    code: "LOCATOR_STALE",
    message: "button locator no longer matches",
    runId: "run-9",
    flowId: "flow-2",
    stepId: "step-3",
    artifacts: ["shots/1.png", "traces/1.zip"],
  });

  expect(error.toJSON()).toEqual({
    code: "LOCATOR_STALE",
    message: "button locator no longer matches",
    runId: "run-9",
    flowId: "flow-2",
    stepId: "step-3",
    artifacts: ["shots/1.png", "traces/1.zip"],
    recoveryAppropriate: true,
  });
  assertStructuredJson(JSON.parse(JSON.stringify(error)));
});

test("toJSON drops stack and cookie-like keys even if attached", () => {
  const error = new QaError({
    code: "AUTH_MISSING",
    message: "auth profile missing",
  });
  Object.assign(error, {
    cookie: "session=secret",
    cookies: "session=secret",
    "set-cookie": "session=secret",
    stack: "Error: secret stack",
  });

  const json = error.toJSON();
  expect(json).toEqual({
    code: "AUTH_MISSING",
    message: "auth profile missing",
    recoveryAppropriate: false,
  });
  assertStructuredJson(json);
  assertStructuredJson(JSON.parse(JSON.stringify(error)));
});

test("QaError is the only exported error type from src/errors", () => {
  const errorsDir = fileURLToPath(new URL("../../../src/errors/", import.meta.url));
  const files = readdirSync(errorsDir)
    .filter((name) => name.endsWith(".ts"))
    .sort();

  expect(files).toEqual(["codes.ts", "qa-error.ts"]);
  expect([
    ...exportedErrorTypeNames(codesModule),
    ...exportedErrorTypeNames(qaErrorModule),
  ]).toEqual(["QaError"]);
});

function assertStructuredJson(value: unknown): void {
  expect(value).not.toHaveProperty("stack");
  assertNoCookieOrStackKeys(value);
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const key of Object.keys(value)) {
      expect(JSON_KEYS).toContain(key);
    }
  }
}

function assertNoCookieOrStackKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoCookieOrStackKeys(item);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      expect(key).not.toBe("stack");
      expect(key).not.toMatch(COOKIE_LIKE_KEY);
      assertNoCookieOrStackKeys(nested);
    }
  }
}

function exportedErrorTypeNames(mod: Record<string, unknown>): string[] {
  return Object.entries(mod)
    .filter(([, value]) => isErrorConstructor(value))
    .map(([name]) => name);
}

function isErrorConstructor(value: unknown): boolean {
  if (typeof value !== "function") {
    return false;
  }
  let proto: unknown = value.prototype;
  while (proto) {
    if (proto === Error.prototype) {
      return true;
    }
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}
