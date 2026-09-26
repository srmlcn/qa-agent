import { expect, test, vi } from "vitest";
import type { RunResult, RunStatus } from "../../../src/evidence/types.js";
import { QaError } from "../../../src/errors/qa-error.js";
import {
  cancel,
  complete,
  createRun,
  getRun,
  listActive,
  setOnCancel,
} from "../../../src/orchestrator/runs.js";

const RUN_ID_PATTERN = /^run-[0-9a-f]{16}$/;

test("createRun stores a running record and returns its signal", () => {
  const created = createRun("archive-project");
  const record = getRun(created.runId);

  expect(Object.keys(created).sort()).toEqual(["runId", "signal"]);
  expect(record.runId).toBe(created.runId);
  expect(record.flowId).toBe("archive-project");
  expect(record.status).toBe("running");
  expect(record.signal).toBe(created.signal);
  expect(record.signal.aborted).toBe(false);
  expect(record.result).toBeUndefined();
  expect(listActive()).toContain(created.runId);
});

test("run ids are run- plus 16 hex characters and contain no path separators", () => {
  const ids = new Set<string>();
  for (let index = 0; index < 8; index += 1) {
    const { runId } = createRun(`flow-${index}`);
    ids.add(runId);
    expect(runId).toMatch(RUN_ID_PATTERN);
    expect(runId.includes("/")).toBe(false);
    expect(runId.includes("\\")).toBe(false);
  }
  expect(ids.size).toBe(8);
});

test("getRun throws FLOW_VALIDATION_FAILED when the id is unknown", () => {
  const runId = "run-does-not-exist";
  expectRunNotFound(() => getRun(runId), runId);
});

test("complete stores the RunResult and sets status from result.status", () => {
  for (const status of ["passed", "failed", "error"] as const) {
    const { runId } = createRun("health");
    const result = runResult(runId, "health", status);
    complete(runId, result);

    const record = getRun(runId);
    expect(record.status).toBe(status);
    expect(record.result).toBe(result);
    expect(listActive()).not.toContain(runId);
  }
});

test("cancel aborts the signal and calls onCancel once", () => {
  const created = createRun("archive-project");
  const onCancel = vi.fn(() => {
    expect(created.signal.aborted).toBe(true);
    expect(readAbortReason(created.signal)).toBeInstanceOf(QaError);
  });
  setOnCancel(created.runId, onCancel);

  const { runId, signal } = created;
  cancel(runId);

  expect(signal.aborted).toBe(true);
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(getRun(runId).status).toBe("cancelled");
  expect(listActive()).not.toContain(runId);

  const reason = readAbortReason(signal);
  expect(reason).toBeInstanceOf(QaError);
  if (!(reason instanceof QaError)) {
    return;
  }
  expect(reason.code).toBe("RUN_CANCELLED");
  expect(reason.message).toBe("run cancelled");
  expect(reason.runId).toBe(runId);
  expect(reason.flowId).toBe("archive-project");
  expect(reason.recoveryAppropriate).toBe(false);
});

test("a second cancel does not call onCancel again and does not throw", () => {
  const onCancel = vi.fn();
  const { runId, signal } = createRun("archive-project");
  setOnCancel(runId, onCancel);

  cancel(runId);
  expect(() => cancel(runId)).not.toThrow();

  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(signal.aborted).toBe(true);
  expect(getRun(runId).status).toBe("cancelled");
});

test("complete after cancel leaves status cancelled", () => {
  const { runId } = createRun("archive-project");
  cancel(runId);

  const result = runResult(runId, "archive-project", "passed");
  complete(runId, result);

  const record = getRun(runId);
  expect(record.status).toBe("cancelled");
  expect(record.result).toBe(result);
  expect(listActive()).not.toContain(runId);
});

test("cancel without a hook does not throw", () => {
  const { runId, signal } = createRun("archive-project");
  expect(() => cancel(runId)).not.toThrow();
  expect(signal.aborted).toBe(true);
  expect(getRun(runId).status).toBe("cancelled");
});

test("a thrown onCancel still leaves the run cancelled and is not retried", () => {
  const onCancel = vi.fn(() => {
    throw new Error("close failed");
  });
  const { runId, signal } = createRun("archive-project", { onCancel });

  expect(() => cancel(runId)).toThrow("close failed");
  expect(signal.aborted).toBe(true);
  expect(getRun(runId).status).toBe("cancelled");
  expect(() => cancel(runId)).not.toThrow();
  expect(onCancel).toHaveBeenCalledTimes(1);
});

test("setOnCancel replaces the hook registered at create time", () => {
  const first = vi.fn();
  const second = vi.fn();
  const { runId } = createRun("archive-project", { onCancel: first });
  setOnCancel(runId, second);

  cancel(runId);

  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledTimes(1);
});

test("unknown cancel and complete throw run not found", () => {
  const runId = "run-missing";
  expectRunNotFound(() => cancel(runId), runId);
  expectRunNotFound(
    () => complete(runId, runResult(runId, "health", "passed")),
    runId,
  );
  expectRunNotFound(() => setOnCancel(runId, () => undefined), runId);
});

test("listActive returns only running ids in creation order", () => {
  const running = createRun("running-flow");
  const finished = createRun("finished-flow");
  const cancelled = createRun("cancelled-flow");
  complete(finished.runId, runResult(finished.runId, "finished-flow", "passed"));
  cancel(cancelled.runId);

  const active = listActive().filter(
    (runId) =>
      runId === running.runId ||
      runId === finished.runId ||
      runId === cancelled.runId,
  );

  expect(active).toEqual([running.runId]);
});

test("cancelling one run does not abort another", () => {
  const first = createRun("one");
  const second = createRun("two");

  cancel(first.runId);

  expect(first.signal.aborted).toBe(true);
  expect(second.signal.aborted).toBe(false);
  expect(getRun(second.runId).status).toBe("running");
});

function runResult(
  runId: string,
  flowId: string,
  status: RunStatus,
): RunResult {
  return {
    runId,
    flowId,
    status,
    startedAt: "2026-09-26T19:00:00.000Z",
    durationMs: 10,
    steps: [],
    network: { failedRequests: [], responses: [] },
    console: { errors: [], warnings: [] },
    pageErrors: [],
    artifacts: { screenshots: [] },
  };
}

function readAbortReason(signal: AbortSignal): unknown {
  return signal.reason as unknown;
}

function expectRunNotFound(run: () => void, runId: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error: unknown) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(QaError);
  if (!(caught instanceof QaError)) {
    return;
  }
  expect(caught.code).toBe("FLOW_VALIDATION_FAILED");
  expect(caught.message).toBe("run not found");
  expect(caught.runId).toBe(runId);
  expect(caught.recoveryAppropriate).toBe(false);
}
