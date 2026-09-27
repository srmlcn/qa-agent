import { QaError } from "../errors/qa-error.js";

/**
 * Action names that mutate or discard user data.
 * Matched against the semantic intent and the step id, not Playwright labels.
 */
const DESTRUCTIVE_ACTION_NAMES = ["delete", "archive", "remove", "destroy"] as const;

/**
 * A flow step or discovery action. Destructive checks read `intent` and `id`
 * only, so a control label such as a button named Save is ignored.
 */
export type PolicyAction = {
  id?: string;
  intent?: string;
  action?: string;
  locator?: {
    name?: string;
    role?: string;
    type?: string;
  };
};

export type ActionPolicyConfig = {
  security: {
    destructiveActionsAllowed: boolean;
  };
};

/**
 * Blocks the next step once `used` has reached `maxSteps`.
 * Step 30 with `maxSteps` 30 is refused before it runs.
 */
export function assertStepsRemaining(used: number, maxSteps: number): void {
  if (used >= maxSteps) {
    throw new QaError({
      code: "POLICY_BLOCKED",
      message: `Step ${used} is blocked before it runs: maxSteps is ${maxSteps}`,
    });
  }
}

/**
 * Blocks a run whose elapsed time is greater than `maxDurationMs`.
 * Callers pass `security.maxRunDurationMs`, which defaults to 10 minutes.
 */
export function assertDuration(
  startedAtMs: number,
  nowMs: number,
  maxDurationMs: number,
): void {
  const elapsedMs = nowMs - startedAtMs;
  if (elapsedMs > maxDurationMs) {
    throw new QaError({
      code: "TIMEOUT",
      message: `Run duration ${elapsedMs}ms exceeds maxRunDurationMs ${maxDurationMs}`,
    });
  }
}

/** Blocks an artifact whose byte length is above `maxBytes`. */
export function assertArtifactSize(bytes: number, maxBytes: number): void {
  if (bytes > maxBytes) {
    throw new QaError({
      code: "POLICY_BLOCKED",
      message: `Artifact size ${bytes} bytes exceeds the ${maxBytes} byte cap`,
    });
  }
}

/**
 * Blocks delete, archive, remove, and destroy when the project has not opted in.
 * The match is case-insensitive against the semantic intent and the step id.
 */
export function assertActionAllowed(
  action: PolicyAction,
  config: ActionPolicyConfig,
): void {
  if (config.security.destructiveActionsAllowed) {
    return;
  }

  const match = findDestructiveAction(action);
  if (match === undefined) {
    return;
  }

  throw new QaError({
    code: "POLICY_BLOCKED",
    message: `Destructive action "${match.name}" in ${match.source} is blocked`,
    ...(action.id === undefined ? {} : { stepId: action.id }),
  });
}

function findDestructiveAction(
  action: PolicyAction,
): { name: string; source: "intent" | "step id" } | undefined {
  const intent = matchedDestructiveName(action.intent);
  if (intent !== undefined) {
    return { name: intent, source: "intent" };
  }
  const stepId = matchedDestructiveName(action.id);
  if (stepId !== undefined) {
    return { name: stepId, source: "step id" };
  }
  return undefined;
}

function matchedDestructiveName(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const haystack = value.toLowerCase();
  return DESTRUCTIVE_ACTION_NAMES.find((name) => haystack.includes(name));
}
