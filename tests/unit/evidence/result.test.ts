import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import type { QaErrorCode } from "../../../src/errors/codes.js";
import { QaError } from "../../../src/errors/qa-error.js";
import { startRun } from "../../../src/evidence/result.js";
import type {
  FailureCategory,
  RunResult,
  RunStatus,
} from "../../../src/evidence/types.js";

const SPEC_MAPPINGS = [
  ["ASSERTION_FAILED", "failed", "assertion"],
  ["LOCATOR_STALE", "failed", "locator"],
  ["TIMEOUT", "error", "timeout"],
  ["BROWSER_CRASHED", "error", "runtime"],
  ["PAGE_ERROR", "error", "runtime"],
  ["NAVIGATION_FAILED", "error", "navigation"],
  ["POLICY_BLOCKED", "error", "runtime"],
  ["RUN_CANCELLED", "error", "runtime"],
  ["NETWORK_FAILURE", "error", "network"],
] as const satisfies readonly (readonly [QaErrorCode, RunStatus, FailureCategory])[];

const OTHER_RUNTIME_CODES = [
  "DISCOVERY_FAILED",
  "FLOW_COMPILE_FAILED",
  "FLOW_VALIDATION_FAILED",
  "AUTH_EXPIRED",
  "AUTH_MISSING",
  "LLM_PROVIDER_UNAVAILABLE",
  "LLM_RATE_LIMITED",
] as const satisfies readonly QaErrorCode[];

test("a passed step and no failures yields passed", () => {
  let nowMs = Date.parse("2026-09-26T19:00:00.000Z");
  const run = startRun({
    runId: "run-1",
    flowId: "archive-project",
    now: () => nowMs,
  });

  nowMs = Date.parse("2026-09-26T19:00:00.400Z");
  run.stepPassed("open");
  nowMs = Date.parse("2026-09-26T19:00:00.400Z");
  const result = run.finish();

  expect(result.status).toBe("passed");
  expect(result.failure).toBeUndefined();
  expect(Object.keys(result)).not.toContain("failure");
  expect(result.steps).toEqual([
    {
      stepId: "open",
      status: "passed",
      startedAt: "2026-09-26T19:00:00.000Z",
      durationMs: 400,
    },
  ]);
  expect(result.network).toEqual({ failedRequests: [], responses: [] });
  expect(result.console).toEqual({ errors: [], warnings: [] });
  expect(result.pageErrors).toEqual([]);
  expect(result.artifacts).toEqual({ screenshots: [] });
  assertNoRecoveryAppropriate(result);
});

test("an assertion failure yields failed and omits recoveryAppropriate", () => {
  const error = new QaError({
    code: "ASSERTION_FAILED",
    message: "project still visible",
    stepId: "archive",
  });
  expect(error.recoveryAppropriate).toBe(false);

  const result = finishStep("archive", error);

  expect(result.status).toBe("failed");
  expect(result.failure).toEqual({
    stepId: "archive",
    category: "assertion",
    message: "project still visible",
  });
  expect(result.steps[0]).toMatchObject({
    stepId: "archive",
    status: "failed",
    error: "project still visible",
  });
  assertNoRecoveryAppropriate(result);
});

test("a locator failure stays distinct from an assertion failure", () => {
  const error = new QaError({
    code: "LOCATOR_STALE",
    message: "archive button missing",
    stepId: "archive",
  });
  expect(error.recoveryAppropriate).toBe(true);

  const result = finishStep("archive", error);

  expect(result.status).toBe("failed");
  expect(result.failure).toEqual({
    stepId: "archive",
    category: "locator",
    message: "archive button missing",
  });
  expect(result.failure?.category).not.toBe("assertion");
  assertNoRecoveryAppropriate(result);
});

test("a timeout yields error and category timeout", () => {
  const result = finishStep(
    "archive",
    new QaError({ code: "TIMEOUT", message: "step timed out" }),
  );

  expect(result.status).toBe("error");
  expect(result.failure).toEqual({
    stepId: "archive",
    category: "timeout",
    message: "step timed out",
  });
  expect(result.steps[0]?.status).toBe("error");
});

test("timestamps come from the injected clock", () => {
  const dateNow = vi.spyOn(Date, "now");
  try {
    let nowMs = Date.parse("2026-09-26T19:00:00.000Z");
    const run = startRun({
      runId: "run-1",
      flowId: "archive-project",
      now: () => nowMs,
    });

    nowMs = Date.parse("2026-09-26T19:00:00.400Z");
    run.stepPassed("open");

    nowMs = Date.parse("2026-09-26T19:00:01.500Z");
    run.stepFailed(
      "archive",
      new QaError({
        code: "ASSERTION_FAILED",
        message: "project still visible",
      }),
    );

    nowMs = Date.parse("2026-09-26T19:00:02.000Z");
    const result = run.finish();

    expect(dateNow).not.toHaveBeenCalled();
    expect(result.startedAt).toBe("2026-09-26T19:00:00.000Z");
    expect(result.durationMs).toBe(2000);
    expect(result.runId).toBe("run-1");
    expect(result.flowId).toBe("archive-project");
    expect(result.steps).toEqual([
      {
        stepId: "open",
        status: "passed",
        startedAt: "2026-09-26T19:00:00.000Z",
        durationMs: 400,
      },
      {
        stepId: "archive",
        status: "failed",
        startedAt: "2026-09-26T19:00:00.400Z",
        durationMs: 1100,
        error: "project still visible",
      },
    ]);
  } finally {
    dateNow.mockRestore();
  }
});

test("a failed step is recorded and does not throw", () => {
  let nowMs = 0;
  const run = startRun({
    runId: "run-1",
    flowId: "flow-1",
    now: () => nowMs,
  });
  nowMs = 25;
  run.stepPassed("open");
  nowMs = 40;

  expect(() => {
    run.stepFailed(
      "archive",
      new QaError({ code: "ASSERTION_FAILED", message: "still visible" }),
    );
  }).not.toThrow();

  nowMs = 50;
  const result = run.finish();
  expect(result.status).toBe("failed");
  expect(result.steps.map((step) => step.stepId)).toEqual(["open", "archive"]);
});

test("cancellation returns the partial result", () => {
  let nowMs = 1_000;
  const run = startRun({
    runId: "run-9",
    flowId: "flow-9",
    now: () => nowMs,
  });
  nowMs = 1_400;
  run.stepPassed("open");
  nowMs = 1_450;

  expect(() => {
    run.stepFailed(
      "archive",
      new QaError({ code: "RUN_CANCELLED", message: "cancelled by caller" }),
    );
  }).not.toThrow();

  nowMs = 1_500;
  const result = run.finish();

  expect(result.status).toBe("error");
  expect(result.failure).toEqual({
    stepId: "archive",
    category: "runtime",
    message: "cancelled by caller",
  });
  expect(result.steps).toEqual([
    {
      stepId: "open",
      status: "passed",
      startedAt: new Date(1_000).toISOString(),
      durationMs: 400,
    },
    {
      stepId: "archive",
      status: "error",
      startedAt: new Date(1_400).toISOString(),
      durationMs: 50,
      error: "cancelled by caller",
    },
  ]);
  expect(result.durationMs).toBe(500);
});

test("an assertion failure classifies the run even after a later timeout", () => {
  let nowMs = 0;
  const run = startRun({
    runId: "run-1",
    flowId: "flow-1",
    now: () => nowMs,
  });
  nowMs = 10;
  run.stepFailed(
    "check",
    new QaError({ code: "ASSERTION_FAILED", message: "count mismatch" }),
  );
  nowMs = 30;
  run.stepFailed(
    "wait",
    new QaError({ code: "TIMEOUT", message: "navigation hung" }),
  );
  nowMs = 40;
  const result = run.finish();

  expect(result.status).toBe("failed");
  expect(result.failure).toEqual({
    stepId: "check",
    category: "assertion",
    message: "count mismatch",
  });
  expect(result.steps).toHaveLength(2);
});

test.each(SPEC_MAPPINGS)(
  "%s maps to status %s and category %s",
  (code, status, category) => {
    const result = finishStep(
      "target",
      new QaError({ code, message: `${code} message` }),
    );

    expect(result.status).toBe(status);
    expect(result.failure).toEqual({
      stepId: "target",
      category,
      message: `${code} message`,
    });
    assertNoRecoveryAppropriate(result);
  },
);

test.each(OTHER_RUNTIME_CODES)(
  "%s maps to status error and category runtime",
  (code) => {
    const result = finishStep(
      "target",
      new QaError({ code, message: `${code} message` }),
    );

    expect(result.status).toBe("error");
    expect(result.failure?.category).toBe("runtime");
    assertNoRecoveryAppropriate(result);
  },
);

test("the default clock is the current time", () => {
  const before = Date.now();
  const run = startRun({ runId: "run-1", flowId: "flow-1" });
  const result = run.finish();
  const after = Date.now();
  const started = Date.parse(result.startedAt);

  expect(started).toBeGreaterThanOrEqual(before);
  expect(started).toBeLessThanOrEqual(after);
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
  expect(result.durationMs).toBeLessThanOrEqual(after - before);
  expect(result.status).toBe("passed");
});

test("assembly does not import Playwright or node I/O", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../../../src/evidence/result.ts", import.meta.url)),
    "utf8",
  );
  const imports = source
    .split("\n")
    .filter((line) => line.startsWith("import "))
    .join("\n");

  expect(imports).not.toMatch(/playwright/i);
  expect(imports).not.toMatch(/node:fs|node:net|node:http|node:https/);
});

function finishStep(stepId: string, error: QaError): RunResult {
  let nowMs = 0;
  const run = startRun({
    runId: "run-1",
    flowId: "flow-1",
    now: () => nowMs,
  });
  nowMs = 15;
  run.stepFailed(stepId, error);
  nowMs = 20;
  return run.finish();
}

function assertNoRecoveryAppropriate(result: RunResult): void {
  expect(ownKeysDeep(result)).not.toContain("recoveryAppropriate");
  expect(JSON.stringify(result)).not.toContain("recoveryAppropriate");
}

function ownKeysDeep(value: unknown): string[] {
  const keys: string[] = [];
  visit(value, keys);
  return keys;
}

function visit(value: unknown, keys: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      visit(item, keys);
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, nested] of Object.entries(value)) {
      keys.push(key);
      visit(nested, keys);
    }
  }
}
