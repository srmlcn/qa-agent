import type { Page } from "playwright";
import { QaError } from "../errors/qa-error.js";
import { runAction } from "../playwright/actions.js";
import { runAssertion } from "../playwright/assertions.js";
import type { FlowSpec } from "./schema.js";
import { transition } from "./state.js";

export type ValidateFlowInput = {
  flow: FlowSpec;
  page: Page;
  timeoutMs: number;
};

export type ValidateFlowResult =
  | { ok: true; flow: FlowSpec }
  | { ok: false; error: QaError };

/**
 * Replays a compiled flow with Playwright.
 * Success returns a new flow from the legal `validate` edge.
 * The input flow is left unchanged and nothing is written to disk.
 * Locator and assertion failures are returned. Every other error propagates.
 */
export async function validateFlow(
  input: ValidateFlowInput,
): Promise<ValidateFlowResult> {
  const { flow, page, timeoutMs } = input;

  try {
    for (const step of flow.steps) {
      await runAction(page, step, timeoutMs);
    }
    for (const assertion of flow.assertions) {
      await runAssertion(page, assertion, timeoutMs);
    }
  } catch (error) {
    if (isReplayFailure(error)) {
      return { ok: false, error };
    }
    throw error;
  }

  return { ok: true, flow: transition(flow, "validate") };
}

function isReplayFailure(error: unknown): error is QaError {
  return (
    error instanceof QaError &&
    (error.code === "LOCATOR_STALE" || error.code === "ASSERTION_FAILED")
  );
}
