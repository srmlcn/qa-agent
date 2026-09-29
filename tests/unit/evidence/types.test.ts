import { expect, test } from "vitest";
import { isRunStatus, type RunResult } from "../../../src/evidence/types.js";

const fixture: RunResult = {
  runId: "run-1",
  flowId: "archive-project",
  status: "failed",
  startedAt: "2026-09-26T19:00:00.000Z",
  durationMs: 1500,
  steps: [
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
  ],
  network: {
    failedRequests: [
      {
        method: "POST",
        url: "https://app.example/api/archive",
        status: 500,
        timing: 80,
        body: '{"error":"unavailable"}',
        headers: { authorization: "[redacted]" },
      },
    ],
    responses: [
      {
        method: "GET",
        url: "https://app.example/projects",
        status: 200,
        timing: 40,
        headers: { "content-type": "application/json" },
      },
    ],
  },
  console: {
    errors: [
      {
        level: "error",
        text: "failed to archive",
        url: "https://app.example/projects",
      },
    ],
    warnings: [{ level: "warning", text: "slow response" }],
  },
  pageErrors: [
    { message: "Unhandled rejection", url: "https://app.example/projects" },
  ],
  artifacts: {
    screenshots: ["after-archive.png"],
    trace: "trace.zip",
  },
  failure: {
    stepId: "archive",
    category: "assertion",
    message: "project still visible",
  },
};

const minimalFixture: RunResult = {
  runId: "run-2",
  flowId: "health",
  status: "passed",
  startedAt: "2026-09-26T19:01:00.000Z",
  durationMs: 10,
  steps: [],
  network: { failedRequests: [], responses: [] },
  console: { errors: [], warnings: [] },
  pageErrors: [],
  artifacts: { screenshots: [] },
};

test("a fixture matching the run result shape typechecks", () => {
  expect(fixture.failure?.category).toBe("assertion");
  expect(fixture.network.failedRequests[0]?.headers.authorization).toBe(
    "[redacted]",
  );
  expect(minimalFixture.artifacts.trace).toBeUndefined();
  expect(minimalFixture.failure).toBeUndefined();
  expect(isRunStatus(fixture.status)).toBe(true);
  expect(isRunStatus(minimalFixture.status)).toBe(true);
});

test.each(["passed", "failed", "error"] as const)(
  "isRunStatus accepts %s",
  (status) => {
    expect(isRunStatus(status)).toBe(true);
  },
);

test.each([
  "skipped",
  "PASSED",
  "",
  "flaky",
  null,
  undefined,
  0,
  true,
  { status: "passed" },
])("isRunStatus rejects %j", (status) => {
  expect(isRunStatus(status)).toBe(false);
});
