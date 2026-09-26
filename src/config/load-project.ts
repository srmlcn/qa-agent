import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { ZodError, type ZodIssue } from "zod";
import { QaError } from "../errors/qa-error.js";
import { applyProjectDefaults } from "./defaults.js";
import { projectConfigSchema, type ProjectConfig } from "./schema.js";

export const PROJECT_CONFIG_RELATIVE_PATH = ".autonomous-qa/config.yml";

export function projectConfigPath(projectRoot: string): string {
  return join(projectRoot, ".autonomous-qa", "config.yml");
}

/**
 * Loads `.autonomous-qa/config.yml` from `projectRoot`.
 * The result stores `llm.apiKeyEnv` and never an API key value.
 * A missing file or schema violation throws `POLICY_BLOCKED` and names the file and field.
 */
export function loadProjectConfig(projectRoot: string): ProjectConfig {
  const filePath = projectConfigPath(projectRoot);
  const source = readConfigSource(filePath);
  const parsed = parseConfigYaml(source, filePath);
  const withDefaults = applyProjectDefaults(parsed);
  return validateConfig(withDefaults, filePath);
}

function readConfigSource(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch (error: unknown) {
    if (isEnoent(error)) {
      throw configError(missingConfigMessage(filePath));
    }
    throw configError(unreadableConfigMessage(filePath));
  }
}

function parseConfigYaml(source: string, filePath: string): unknown {
  try {
    return toUnknown(parse(source));
  } catch {
    throw configError(invalidConfigMessage(filePath, ["(document)"]));
  }
}

function toUnknown(value: unknown): unknown {
  return value;
}

function validateConfig(input: unknown, filePath: string): ProjectConfig {
  const parsed = projectConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw configError(invalidConfigMessage(filePath, fieldNames(parsed.error)));
  }
  return parsed.data;
}

function configError(message: string): QaError {
  return new QaError({
    code: "POLICY_BLOCKED",
    message,
  });
}

function missingConfigMessage(filePath: string): string {
  return `Missing ${PROJECT_CONFIG_RELATIVE_PATH} at ${filePath}`;
}

function unreadableConfigMessage(filePath: string): string {
  return `Unreadable ${PROJECT_CONFIG_RELATIVE_PATH} at ${filePath}`;
}

function invalidConfigMessage(
  filePath: string,
  fields: readonly string[],
): string {
  const listed = [...new Set(fields)].sort();
  const noun = listed.length === 1 ? "field" : "fields";
  return `Invalid ${PROJECT_CONFIG_RELATIVE_PATH} at ${filePath}: ${noun} ${listed.join(", ")}`;
}

function fieldNames(error: ZodError): string[] {
  const names: string[] = [];
  for (const issue of error.issues) {
    names.push(...issueFieldNames(issue));
  }
  return names.length === 0 ? ["(root)"] : names;
}

function issueFieldNames(issue: ZodIssue): string[] {
  const prefix = issue.path.map(String).join(".");
  if (issue.code === "unrecognized_keys") {
    return issue.keys.map((key) => joinField(prefix, key));
  }
  if (prefix.length === 0) {
    return ["(root)"];
  }
  return [prefix];
}

function joinField(prefix: string, key: string): string {
  return prefix.length === 0 ? key : `${prefix}.${key}`;
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
