import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { QaError } from "../errors/qa-error.js";
import { parseFlowSpec, type FlowSpec } from "./schema.js";

export type FlowFormat = "yaml" | "json";

/**
 * Parse YAML or JSON text into a FlowSpec.
 * Schema aliases are normalized by {@link parseFlowSpec}.
 */
export function parseFlow(text: string, format: FlowFormat): FlowSpec {
  const raw = decodeFlow(text, format);
  try {
    return parseFlowSpec(raw);
  } catch (error) {
    throw flowValidationFailed(error);
  }
}

/**
 * Serialize a FlowSpec to YAML or JSON.
 * The parsed object is the source of truth, so optional fields such as
 * `semanticFallback` are written whenever they are present.
 */
export function stringifyFlow(flow: FlowSpec, format: FlowFormat): string {
  let validated: FlowSpec;
  try {
    validated = parseFlowSpec(flow);
  } catch (error) {
    throw flowValidationFailed(error);
  }

  switch (format) {
    case "yaml":
      return stringifyYaml(validated, {
        aliasDuplicateObjects: false,
        lineWidth: 0,
      });
    case "json":
      return JSON.stringify(validated, null, 2);
    default:
      return unsupportedFormat(format);
  }
}

function decodeFlow(text: string, format: FlowFormat): unknown {
  try {
    switch (format) {
      case "yaml":
        return parseYaml(text) as unknown;
      case "json":
        return JSON.parse(text) as unknown;
      default:
        return unsupportedFormat(format);
    }
  } catch (error) {
    throw flowValidationFailed(error);
  }
}

function unsupportedFormat(format: never): never {
  throw new QaError({
    code: "FLOW_VALIDATION_FAILED",
    message: `Unsupported flow format: ${String(format)}`,
  });
}

function flowValidationFailed(error: unknown): QaError {
  if (error instanceof QaError) {
    return error;
  }
  const message =
    error instanceof Error ? error.message : "Flow validation failed";
  return new QaError({
    code: "FLOW_VALIDATION_FAILED",
    message,
  });
}
