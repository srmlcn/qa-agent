import { readFileSync } from "node:fs";
import { join, sep } from "node:path";
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
  return validateProjectDocument(parsed, filePath);
}

/**
 * Reads a repo config when the file exists.
 * A missing file returns `undefined`. Invalid YAML throws `POLICY_BLOCKED`.
 */
export function readOptionalProjectDocument(projectRoot: string): unknown | undefined {
  const filePath = projectConfigPath(projectRoot);
  let source: string;
  try {
    source = readFileSync(filePath, "utf8");
  } catch (error: unknown) {
    if (isEnoent(error)) {
      return undefined;
    }
    throw configError(unreadableConfigMessage(filePath));
  }
  const document = parseConfigYaml(source, filePath);
  if (!isPlainObject(document)) {
    throw configError(invalidConfigMessage(filePath, ["(root)"]));
  }
  return document;
}

/** Validates a merged document and names `filePath` in schema errors. */
export function validateProjectDocument(input: unknown, filePath: string): ProjectConfig {
  return validateConfig(applyProjectDefaults(input), filePath);
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
  return `Invalid ${configLabel(filePath)} at ${filePath}: ${noun} ${listed.join(", ")}`;
}

function configLabel(filePath: string): string {
  if (filePath.endsWith(`${sep}config.json`) || filePath.endsWith("/config.json")) {
    return "config.json";
  }
  return PROJECT_CONFIG_RELATIVE_PATH;
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
