import { randomBytes } from "node:crypto";
import type { RunResult, RunStatus } from "../evidence/types.js";
import { QaError } from "../errors/qa-error.js";

/**
 * In-memory registry status. Terminal `RunResult` statuses stay on the
 * result; `running` and `cancelled` exist only while the registry owns the run.
 */
export type RunRecordStatus = RunStatus | "running" | "cancelled";

export type CancelHook = () => void;

export type CreateRunOptions = {
  onCancel?: CancelHook;
};

export type CreatedRun = {
  runId: string;
  signal: AbortSignal;
};

export type RunRecord = {
  runId: string;
  flowId: string;
  status: RunRecordStatus;
  signal: AbortSignal;
  result?: RunResult;
};

type StoredRun = {
  runId: string;
  flowId: string;
  status: RunRecordStatus;
  controller: AbortController;
  onCancel?: CancelHook;
  result?: RunResult;
};

const runs = new Map<string, StoredRun>();

/**
 * Starts a run. Storage is in-memory for v0.1 and this module does not write
 * artifact files. `runId` is `run-` plus 16 hex characters.
 */
export function createRun(
  flowId: string,
  options?: CreateRunOptions,
): CreatedRun {
  const runId = createRunId();
  const controller = new AbortController();
  const stored: StoredRun = {
    runId,
    flowId,
    status: "running",
    controller,
  };
  if (options?.onCancel !== undefined) {
    stored.onCancel = options.onCancel;
  }
  runs.set(runId, stored);
  return { runId, signal: controller.signal };
}

/** Replaces the close hook the pipeline registered. Ignored after cancel. */
export function setOnCancel(runId: string, onCancel: CancelHook): void {
  const run = requireRun(runId);
  if (run.status === "cancelled") {
    return;
  }
  run.onCancel = onCancel;
}

export function getRun(runId: string): RunRecord {
  return toRecord(requireRun(runId));
}

/**
 * Stores `result`. Status follows `result.status` unless the run was already
 * cancelled, in which case status stays `cancelled`.
 */
export function complete(runId: string, result: RunResult): void {
  const run = requireRun(runId);
  run.result = result;
  if (run.status !== "cancelled") {
    run.status = result.status;
  }
}

/**
 * Aborts the run signal with `RUN_CANCELLED`, sets status to `cancelled`, and
 * calls the registered close hook once. A second call does not throw and does
 * not call the hook again.
 */
export function cancel(runId: string): void {
  const run = requireRun(runId);
  if (run.status === "cancelled") {
    return;
  }

  run.status = "cancelled";
  const hook = run.onCancel;
  run.onCancel = undefined;
  run.controller.abort(
    new QaError({
      code: "RUN_CANCELLED",
      message: "run cancelled",
      runId: run.runId,
      flowId: run.flowId,
    }),
  );
  hook?.();
}

/** Ids whose status is `running`, in creation order. */
export function listActive(): string[] {
  const active: string[] = [];
  for (const run of runs.values()) {
    if (run.status === "running") {
      active.push(run.runId);
    }
  }
  return active;
}

function createRunId(): string {
  let runId = formatRunId();
  while (runs.has(runId)) {
    runId = formatRunId();
  }
  return runId;
}

function formatRunId(): string {
  return `run-${randomBytes(8).toString("hex")}`;
}

function requireRun(runId: string): StoredRun {
  const run = runs.get(runId);
  if (run === undefined) {
    throw new QaError({
      code: "FLOW_VALIDATION_FAILED",
      message: "run not found",
      runId,
    });
  }
  return run;
}

function toRecord(run: StoredRun): RunRecord {
  const record: RunRecord = {
    runId: run.runId,
    flowId: run.flowId,
    status: run.status,
    signal: run.controller.signal,
  };
  if (run.result !== undefined) {
    record.result = run.result;
  }
  return record;
}
