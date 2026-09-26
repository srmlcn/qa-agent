import { QaError } from "../errors/qa-error.js";
import type { AgentResultLike } from "./trajectory.js";

/**
 * One scripted step. `description` becomes the instruction on the
 * `DiscoveryAction` produced by `fromAgentResult`. `method`, `selector`,
 * and `arguments` keep those names through that conversion.
 */
export interface FakeScriptAction {
  method: string;
  selector: string;
  description: string;
  arguments: unknown;
}

/**
 * Ordered actions, or a function that returns them.
 * A function that throws `"rate-limit"` (or an `Error` with that message)
 * is a rate-limit script: `run` rejects with `LLM_RATE_LIMITED`.
 */
export type FakeScript =
  | readonly FakeScriptAction[]
  | (() => readonly FakeScriptAction[]);

/** Agent action shape `fromAgentResult` accepts and keeps in order. */
export interface ScriptedAgentAction {
  type: "act";
  method: string;
  selector: string;
  description: string;
  instruction: string;
  action: string;
  arguments: unknown;
  playwrightArguments: {
    method: string;
    selector: string;
    description: string;
    arguments: unknown;
  };
}

/** Agent result `fromAgentResult` converts into discovery actions. */
export interface ScriptedAgentResult extends AgentResultLike {
  success: boolean;
  completed: boolean;
  message: string;
  actions: ScriptedAgentAction[];
}

/**
 * Client the discovery session can run without a live model.
 *
 * Stagehand's `LLMClient` is an abstract class. Constructing it installs
 * AI SDK helpers that perform real inference, and the agent loop only
 * yields actions by calling browser tools. Satisfying that class in a test
 * needs the Stagehand package plus further SDK glue, so this module does
 * not subclass it and does not import Stagehand. The session should take
 * this `DiscoveryClient` as its `client`. The real provider adapter should
 * implement the same `run` method and return an agent result
 * `fromAgentResult` can convert.
 */
export interface DiscoveryClient {
  run(objective: string): Promise<ScriptedAgentResult>;
}

const RATE_LIMIT_SIGNAL = "rate-limit";

export function createFakeClient(script: FakeScript): DiscoveryClient {
  return {
    run(objective: string): Promise<ScriptedAgentResult> {
      try {
        return Promise.resolve(toResult(objective, loadScript(script)));
      } catch (error: unknown) {
        return Promise.reject(translateScriptError(error));
      }
    },
  };
}

function loadScript(script: FakeScript): readonly FakeScriptAction[] {
  if (typeof script !== "function") {
    return script;
  }
  return script();
}

function toResult(
  objective: string,
  steps: readonly FakeScriptAction[],
): ScriptedAgentResult {
  return {
    success: true,
    completed: true,
    message: objective,
    actions: steps.map(toAgentAction),
  };
}

function toAgentAction(step: FakeScriptAction): ScriptedAgentAction {
  return {
    type: "act",
    method: step.method,
    selector: step.selector,
    description: step.description,
    instruction: step.description,
    action: step.description,
    arguments: step.arguments,
    playwrightArguments: {
      method: step.method,
      selector: step.selector,
      description: step.description,
      arguments: step.arguments,
    },
  };
}

function translateScriptError(error: unknown): unknown {
  if (!isRateLimitSignal(error)) {
    return error;
  }
  return new QaError({
    code: "LLM_RATE_LIMITED",
    message: "The model provider rate limited this request.",
  });
}

function isRateLimitSignal(error: unknown): boolean {
  if (error === RATE_LIMIT_SIGNAL) {
    return true;
  }
  return error instanceof Error && error.message === RATE_LIMIT_SIGNAL;
}
