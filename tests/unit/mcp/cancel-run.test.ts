import { expect, test, vi } from "vitest";
import type { RunResult, RunStatus } from "../../../src/evidence/types.js";
import { QaError } from "../../../src/errors/qa-error.js";
import { tool as cancelRunTool } from "../../../src/mcp/tools/cancel-run.js";
import { complete, createRun, getRun } from "../../../src/orchestrator/runs.js";

test("qa.cancel_run cancels a running run and returns cancelled", async () => {
  const onCancel = vi.fn();
  const created = createRun("archive-project", { onCancel });

  const output = await cancelRunTool.handler({ runId: created.runId });

  expect(output).toEqual({ runId: created.runId, status: "cancelled" });
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(created.signal.aborted).toBe(true);
  expect(getRun(created.runId).status).toBe("cancelled");
});

test("qa.cancel_run does not call the hook again when the run is already cancelled", async () => {
  const onCancel = vi.fn();
  const created = createRun("archive-project", { onCancel });

  await cancelRunTool.handler({ runId: created.runId });
  const output = await cancelRunTool.handler({ runId: created.runId });

  expect(output).toEqual({ runId: created.runId, status: "cancelled" });
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(getRun(created.runId).status).toBe("cancelled");
});

test("qa.cancel_run leaves a finished run's status unchanged", async () => {
  for (const status of ["passed", "failed", "error"] as const) {
    const onCancel = vi.fn();
    const created = createRun(`flow-${status}`, { onCancel });
    const result = runResult(created.runId, `flow-${status}`, status);
    complete(created.runId, result);

    const output = await cancelRunTool.handler({ runId: created.runId });

    expect(output).toEqual({ runId: created.runId, status });
    expect(getRun(created.runId).status).toBe(status);
    expect(getRun(created.runId).result).toBe(result);
    expect(created.signal.aborted).toBe(false);
    expect(onCancel).not.toHaveBeenCalled();
  }
});

test("qa.cancel_run rejects an unknown run", async () => {
  await expect(cancelRunTool.handler({ runId: "run-missing" })).rejects.toEqual(
    expect.objectContaining({
      code: "FLOW_VALIDATION_FAILED",
      message: "run not found",
    }),
  );
  await expect(cancelRunTool.handler({ runId: "run-missing" })).rejects.toBeInstanceOf(
    QaError,
  );
});

function runResult(runId: string, flowId: string, status: RunStatus): RunResult {
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
