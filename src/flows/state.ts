import { QaError } from "../errors/qa-error.js";
import type { FlowSpec } from "./schema.js";

/** Lifecycle states declared on {@link FlowSpec}. */
export type FlowState = FlowSpec["state"];

export type FlowEvent =
  | "validate"
  | "mark-stable"
  | "mark-stale"
  | "mark-repaired";

/**
 * Legal edges only. `mark-stable` is optional in v0.1 and is not required
 * before execution. A validated flow may go stale without ever being stable.
 * Pairs missing from this table throw `FLOW_VALIDATION_FAILED`.
 */
const TRANSITIONS: {
  readonly [State in FlowState]: Partial<Record<FlowEvent, FlowState>>;
} = {
  draft: {
    validate: "validated",
  },
  validated: {
    "mark-stable": "stable",
    "mark-stale": "stale",
  },
  stable: {
    "mark-stale": "stale",
  },
  stale: {
    "mark-repaired": "repaired",
  },
  repaired: {
    validate: "validated",
  },
};

/**
 * Returns a new flow in the next lifecycle state.
 * Does not change steps, locators, or assertions, and does not write disk.
 */
export function transition(flow: FlowSpec, event: FlowEvent): FlowSpec {
  const next = TRANSITIONS[flow.state]?.[event];
  if (next === undefined) {
    throw new QaError({
      code: "FLOW_VALIDATION_FAILED",
      message: `illegal flow transition from ${flow.state} on ${event}`,
      flowId: flow.id,
    });
  }

  return {
    ...flow,
    state: next,
  };
}
