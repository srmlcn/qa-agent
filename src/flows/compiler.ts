import { QaError } from "../errors/qa-error.js";
import type {
  DiscoveryAction,
  DiscoveryTrajectory,
} from "../stagehand/trajectory.js";
import { chooseLocator } from "./rank.js";
import type { FlowSpec, Locator, Step } from "./schema.js";

export type CompileOptions = {
  id: string;
  name: string;
  objective: string;
  authProfile?: string;
};

type FlowAction =
  | "click"
  | "fill"
  | "press"
  | "select"
  | "check"
  | "uncheck"
  | "goto"
  | "reload"
  | "waitFor";

type StepIdentity = {
  id: string;
  intent: string;
  semanticFallback: string;
};

const METHOD_TO_ACTION: Readonly<Record<string, FlowAction>> = {
  click: "click",
  fill: "fill",
  type: "fill",
  press: "press",
  select: "select",
  check: "check",
  uncheck: "uncheck",
  goto: "goto",
  reload: "reload",
  waitfor: "waitFor",
};

const VALUE_KEYS = ["value", "text", "url", "keys", "key"] as const;

/**
 * Turns a discovery trajectory into a draft FlowSpec.
 * Playwright validation is a separate leaf.
 */
export function compile(
  trajectory: DiscoveryTrajectory,
  options: CompileOptions,
): FlowSpec {
  if (trajectory.actions.length === 0) {
    throw compileFailed(
      options.id,
      undefined,
      "Discovery trajectory has no concrete actions.",
    );
  }

  const usedIds = new Set<string>();
  const steps = trajectory.actions.map((action, ordinal) =>
    compileAction(action, options.id, ordinal, usedIds),
  );

  const flow: FlowSpec = {
    version: 1,
    id: options.id,
    name: options.name,
    objective: options.objective,
    state: "draft",
    inputs: {},
    steps,
    assertions: [],
  };

  if (options.authProfile !== undefined) {
    flow.authProfile = options.authProfile;
  }

  return flow;
}

function compileAction(
  action: DiscoveryAction,
  flowId: string,
  ordinal: number,
  usedIds: Set<string>,
): Step {
  const flowAction = resolveMethod(action, flowId);
  const locator = chooseLocator(action);
  const value = actionValue(action, flowAction);
  const intent =
    trajectoryDescription(action) ??
    intentSentence(flowAction, targetLabel(locator, value, flowAction));
  const semanticFallback = nonEmptyString(action.instruction) ?? intent;
  const identity = {
    id: stepId(intent, ordinal, usedIds),
    intent,
    semanticFallback,
  };

  return toStep(flowAction, identity, locator, value, flowId, action.index);
}

function toStep(
  flowAction: FlowAction,
  identity: StepIdentity,
  locator: Locator | undefined,
  value: string | undefined,
  flowId: string,
  index: number,
): Step {
  switch (flowAction) {
    case "click":
    case "check":
    case "uncheck":
      return pointedStep(
        flowAction,
        identity,
        requiredLocator(locator, flowId, identity.id, index),
      );
    case "fill":
    case "press":
    case "select":
      return valuedStep(
        flowAction,
        identity,
        requiredLocator(locator, flowId, identity.id, index),
        requiredValue(value, flowAction, flowId, identity.id, index),
      );
    case "goto":
      return seal({
        ...identity,
        action: "goto",
        value: requiredValue(value, flowAction, flowId, identity.id, index),
      });
    case "reload":
      return { ...identity, action: "reload" };
    case "waitFor":
      return waitForStep(identity, locator, value);
  }
}

function pointedStep(
  action: "click" | "check" | "uncheck",
  identity: StepIdentity,
  locator: Locator,
): Step {
  switch (action) {
    case "click":
      return seal({ ...identity, action, locator });
    case "check":
      return seal({ ...identity, action, locator });
    case "uncheck":
      return seal({ ...identity, action, locator });
  }
}

function valuedStep(
  action: "fill" | "press" | "select",
  identity: StepIdentity,
  locator: Locator,
  value: string,
): Step {
  switch (action) {
    case "fill":
      return seal({ ...identity, action, locator, value });
    case "press":
      return seal({ ...identity, action, locator, value });
    case "select":
      return seal({ ...identity, action, locator, value });
  }
}

function waitForStep(
  identity: StepIdentity,
  locator: Locator | undefined,
  value: string | undefined,
): Step {
  if (locator !== undefined && value !== undefined) {
    return seal({ ...identity, action: "waitFor", locator, value });
  }
  if (locator !== undefined) {
    return seal({ ...identity, action: "waitFor", locator });
  }
  if (value !== undefined) {
    return seal({ ...identity, action: "waitFor", value });
  }
  return seal({ ...identity, action: "waitFor" });
}

/**
 * Zod's inferred Step union drops fields other than `action`.
 * Sealing through an annotated parameter keeps those fields and still
 * returns the schema's Step type.
 */
function seal<T extends StepIdentity & { action: FlowAction }>(step: T): Step {
  return step;
}

function resolveMethod(action: DiscoveryAction, flowId: string): FlowAction {
  const explicit = nonEmptyString(action.method);
  if (explicit !== undefined) {
    const mapped = mapMethod(explicit);
    if (mapped === undefined) {
      throw compileFailed(
        flowId,
        undefined,
        `Unknown action method "${explicit}".`,
      );
    }
    return mapped;
  }

  const fromAction = mapMethod(action.action);
  if (fromAction !== undefined) {
    return fromAction;
  }

  const fromKind = mapMethod(action.kind);
  if (fromKind !== undefined) {
    return fromKind;
  }

  throw compileFailed(
    flowId,
    undefined,
    `Action at index ${action.index} has no known method.`,
  );
}

function mapMethod(value: string | undefined): FlowAction | undefined {
  const token = nonEmptyString(value);
  if (token === undefined) {
    return undefined;
  }
  return METHOD_TO_ACTION[token.toLowerCase()];
}

function trajectoryDescription(action: DiscoveryAction): string | undefined {
  const described = nonEmptyString(action.action);
  if (described === undefined || mapMethod(described) !== undefined) {
    return undefined;
  }
  return described;
}

function intentSentence(flowAction: FlowAction, target: string): string {
  switch (flowAction) {
    case "reload":
      return "Reload the page";
    case "goto":
      return target.length > 0 ? `Go to ${target}` : "Go to the page";
    case "click":
      return target.length > 0 ? `Click ${target}` : "Click the target";
    case "fill":
      return target.length > 0 ? `Fill ${target}` : "Fill the target";
    case "press":
      return target.length > 0 ? `Press ${target}` : "Press the target";
    case "select":
      return target.length > 0 ? `Select ${target}` : "Select the target";
    case "check":
      return target.length > 0 ? `Check ${target}` : "Check the target";
    case "uncheck":
      return target.length > 0 ? `Uncheck ${target}` : "Uncheck the target";
    case "waitFor":
      return target.length > 0 ? `Wait for ${target}` : "Wait for the target";
  }
}

function targetLabel(
  locator: Locator | undefined,
  value: string | undefined,
  flowAction: FlowAction,
): string {
  if (flowAction === "goto" && value !== undefined) {
    return value;
  }
  if (locator !== undefined) {
    return locatorTarget(locator);
  }
  if (flowAction === "waitFor" && value !== undefined) {
    return value;
  }
  return "";
}

function locatorTarget(locator: Locator): string {
  switch (locator.type) {
    case "role":
    case "label":
    case "testid":
      return locator.name;
    case "placeholder":
    case "attr":
      return locator.value;
    case "text":
      return locator.text;
    case "css":
    case "xpath":
      return locator.selector;
  }
}

function actionValue(
  action: DiscoveryAction,
  flowAction: FlowAction,
): string | undefined {
  const fromArguments = valueFromArguments(action.arguments);
  if (fromArguments !== undefined) {
    return fromArguments;
  }
  if (flowAction === "goto") {
    return nonEmptyString(action.urlAfter) ?? nonEmptyString(action.urlBefore);
  }
  return undefined;
}

function valueFromArguments(value: unknown): string | undefined {
  const direct = scalarString(value);
  if (direct !== undefined) {
    return direct;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const scalar = scalarString(item);
      if (scalar !== undefined) {
        return scalar;
      }
    }
    return undefined;
  }
  if (!isPlainRecord(value)) {
    return undefined;
  }
  for (const key of VALUE_KEYS) {
    const scalar = scalarString(value[key]);
    if (scalar !== undefined) {
      return scalar;
    }
  }
  return undefined;
}

function stepId(intent: string, ordinal: number, used: Set<string>): string {
  const slug = intent
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  const base = slug.length > 0 ? slug : `step-${ordinal + 1}`;
  let id = base;
  let duplicate = 2;
  while (used.has(id)) {
    id = `${base}-${duplicate}`;
    duplicate += 1;
  }
  used.add(id);
  return id;
}

function scalarString(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return nonEmptyString(value);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Kinds `chooseLocator` can return, in rank preference order.
 * The missing-locator error is built from this record so it cannot
 * omit a kind the compiler accepts.
 */
const ACCEPTED_LOCATOR_KINDS = {
  role: "role",
  label: "label",
  placeholder: "placeholder",
  text: "text",
  testid: "testid",
  attr: "attr",
  css: "css",
  xpath: "xpath",
} as const satisfies Record<Locator["type"], string>;

const ACCEPTED_LOCATOR_LIST = formatAcceptedLocators(ACCEPTED_LOCATOR_KINDS);

function formatAcceptedLocators(
  kinds: Readonly<Record<Locator["type"], string>>,
): string {
  const names = Object.keys(kinds);
  const last = names[names.length - 1];
  if (last === undefined) {
    return "supported";
  }
  if (names.length === 1) {
    return last;
  }
  return `${names.slice(0, -1).join(", ")}, or ${last}`;
}

function requiredLocator(
  locator: Locator | undefined,
  flowId: string,
  stepId: string,
  index: number,
): Locator {
  if (locator === undefined) {
    throw compileFailed(
      flowId,
      stepId,
      `Action at index ${index} has no ${ACCEPTED_LOCATOR_LIST} locator.`,
    );
  }
  return locator;
}

function requiredValue(
  value: string | undefined,
  flowAction: FlowAction,
  flowId: string,
  stepId: string,
  index: number,
): string {
  if (value === undefined) {
    throw compileFailed(
      flowId,
      stepId,
      `Action at index ${index} is missing a value for ${flowAction}.`,
    );
  }
  return value;
}

function compileFailed(
  flowId: string,
  stepId: string | undefined,
  message: string,
): QaError {
  return new QaError({
    code: "FLOW_COMPILE_FAILED",
    message,
    flowId,
    ...(stepId === undefined ? {} : { stepId }),
  });
}
