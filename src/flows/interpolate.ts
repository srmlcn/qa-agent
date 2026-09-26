import { QaError } from "../errors/qa-error.js";
import { parseFlowSpec, type FlowSpec } from "./schema.js";

export type FlowInputValue = string | number | boolean;

export type FlowInputs = Readonly<Record<string, FlowInputValue>>;

type InputType = "string" | "number" | "boolean";

type Resolution = {
  values: ReadonlyMap<string, string>;
  declared: ReadonlySet<string>;
};

const PLACEHOLDER_START = "${";

/**
 * Replace `${name}` placeholders in step, locator, and assertion strings.
 * Substitution is literal text only: inserted values are not evaluated and
 * are not scanned for further placeholders.
 */
export function interpolateFlow(flow: FlowSpec, inputs: FlowInputs): FlowSpec {
  let validated: FlowSpec;
  try {
    validated = parseFlowSpec(flow);
  } catch (error) {
    throw flowValidationFailed(error, flow.id);
  }

  const resolution = resolveInputs(validated, inputs);
  const copy = structuredClone(validated);
  const replace = (value: string): string =>
    substitute(value, resolution, validated.id);
  copy.steps = mapStrings(copy.steps, replace);
  copy.assertions = mapStrings(copy.assertions, replace);
  return copy;
}

function resolveInputs(flow: FlowSpec, inputs: FlowInputs): Resolution {
  const values = new Map<string, string>();
  const declared = new Set<string>();

  for (const [name, spec] of Object.entries(flow.inputs)) {
    declared.add(name);
    const provided = Object.hasOwn(inputs, name) ? inputs[name] : undefined;
    if (provided !== undefined) {
      assertRuntimeType(flow.id, name, spec.type, provided);
      values.set(name, literalString(provided));
      continue;
    }
    if (spec.default !== undefined) {
      assertRuntimeType(flow.id, name, spec.type, spec.default);
      values.set(name, literalString(spec.default));
      continue;
    }
    if (spec.required === true) {
      throw new QaError({
        code: "FLOW_VALIDATION_FAILED",
        message: `Missing required input "${name}"`,
        flowId: flow.id,
      });
    }
  }

  return { values, declared };
}

function assertRuntimeType(
  flowId: string,
  name: string,
  expected: InputType,
  value: unknown,
): asserts value is FlowInputValue {
  if (typeof value !== expected) {
    throw new QaError({
      code: "FLOW_VALIDATION_FAILED",
      message: `Input "${name}" must be a ${expected}`,
      flowId,
    });
  }
}

function literalString(value: FlowInputValue): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return String(value);
}

function substitute(
  value: string,
  resolution: Resolution,
  flowId: string,
): string {
  let result = "";
  let cursor = 0;

  while (cursor < value.length) {
    const start = value.indexOf(PLACEHOLDER_START, cursor);
    if (start === -1) {
      result += value.slice(cursor);
      return result;
    }

    result += value.slice(cursor, start);
    const end = value.indexOf("}", start + PLACEHOLDER_START.length);
    if (end === -1) {
      throw new QaError({
        code: "FLOW_VALIDATION_FAILED",
        message: 'Unclosed input placeholder "${"',
        flowId,
      });
    }

    const name = value.slice(start + PLACEHOLDER_START.length, end);
    if (!resolution.declared.has(name)) {
      throw new QaError({
        code: "FLOW_VALIDATION_FAILED",
        message: `Unknown input "${name}"`,
        flowId,
      });
    }

    const replacement = resolution.values.get(name);
    if (replacement === undefined) {
      throw new QaError({
        code: "FLOW_VALIDATION_FAILED",
        message: `Unresolved input "${name}"`,
        flowId,
      });
    }

    result += replacement;
    cursor = end + 1;
  }

  return result;
}

function mapStrings<T>(value: T, replace: (input: string) => string): T {
  if (typeof value === "string") {
    return replace(value) as T;
  }
  if (Array.isArray(value)) {
    const mapped = value.map((item: unknown) => mapStrings(item, replace));
    return mapped as T;
  }
  if (typeof value === "object" && value !== null) {
    const source = value as Record<string, unknown>;
    const mapped: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      mapped[key] = mapStrings(source[key], replace);
    }
    return mapped as T;
  }
  return value;
}

function flowValidationFailed(error: unknown, flowId: string): QaError {
  if (error instanceof QaError) {
    return error;
  }
  const message =
    error instanceof Error ? error.message : "Flow validation failed";
  return new QaError({
    code: "FLOW_VALIDATION_FAILED",
    message,
    flowId,
  });
}
