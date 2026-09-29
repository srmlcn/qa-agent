import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z, ZodError, type ZodIssue } from "zod";
import { QaError } from "../errors/qa-error.js";
import { homeDir } from "../runtime/paths.js";
import {
  authSchema,
  evidenceSchema,
  llmSchema,
  playwrightSchema,
  stagehandSchema,
  type LlmConfig,
} from "./schema.js";

const USER_CONFIG_FILE_NAME = "config.json";

const userLlmSchema = llmSchema.partial();

/** True when user LLM settings can stand in for a project `llm` block. */
export function userLlmIsComplete(llm: Partial<LlmConfig>): boolean {
  if (
    llm.provider === undefined ||
    llm.model === undefined ||
    llm.apiKeyEnv === undefined ||
    llm.timeoutMs === undefined
  ) {
    return false;
  }
  if (llm.provider === "openai-compatible" && llm.baseUrl === undefined) {
    return false;
  }
  return true;
}

export type LoadedUserConfig = {
  llm: Partial<LlmConfig>;
  /** Non-safety keys to merge under a repo file. Arrays and `llm.headers` replace. */
  overlay: Readonly<Record<string, unknown>>;
  ignoredFields: readonly string[];
};

/**
 * Path of the user config inside the autonomous-qa home directory.
 * `homeDir()` honors `AUTONOMOUS_QA_HOME` and otherwise uses `~/.autonomous-qa`.
 */
export function userConfigPath(): string {
  return join(homeDir(), USER_CONFIG_FILE_NAME);
}

/**
 * Loads user `config.json` for LLM connection fields only.
 * A missing file yields an empty result.
 * Safety fields are named in `ignoredFields` and are not applied.
 * An `apiKey` value is discarded and never returned.
 */
export function loadUserConfig(): LoadedUserConfig {
  const filePath = userConfigPath();
  const source = readUserSource(filePath);
  if (source === undefined) {
    return { llm: {}, overlay: {}, ignoredFields: [] };
  }
  return interpretUserConfig(parseUserJson(source, filePath), filePath);
}

function readUserSource(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, "utf8");
  } catch (error: unknown) {
    if (isEnoent(error)) {
      return undefined;
    }
    throw configError(unreadableUserConfigMessage(filePath));
  }
}

function parseUserJson(source: string, filePath: string): unknown {
  try {
    return toUnknown(JSON.parse(source));
  } catch {
    throw configError(invalidUserConfigMessage(filePath, ["(document)"]));
  }
}

function interpretUserConfig(value: unknown, filePath: string): LoadedUserConfig {
  if (!isPlainObject(value)) {
    throw configError(invalidUserConfigMessage(filePath, ["(root)"]));
  }

  const ignoredFields: string[] = [];
  collectIgnoredSafetyFields(value, ignoredFields);
  stripApiKey(value, "apiKey", ignoredFields);
  const llm = readUserLlm(value, filePath, ignoredFields);

  return {
    llm,
    overlay: userOverlay(value, llm, filePath),
    ignoredFields,
  };
}

function collectIgnoredSafetyFields(
  root: Record<string, unknown>,
  ignoredFields: string[],
): void {
  if (Object.hasOwn(root, "security")) {
    ignoredFields.push("security");
  }
  const application = root.application;
  if (!isPlainObject(application)) {
    return;
  }
  if (Object.hasOwn(application, "productionAllowed")) {
    ignoredFields.push("application.productionAllowed");
  }
  if (Object.hasOwn(application, "allowedHosts")) {
    ignoredFields.push("application.allowedHosts");
  }
}

const USER_BLOCKS = {
  stagehand: stagehandSchema,
  playwright: playwrightSchema,
  evidence: evidenceSchema,
  auth: authSchema,
} as const;

function userOverlay(
  root: Record<string, unknown>,
  llm: Partial<LlmConfig>,
  filePath: string,
): Record<string, unknown> {
  const overlay: Record<string, unknown> = {};
  const llmOverlay = definedEntries(llm);
  if (Object.keys(llmOverlay).length > 0) {
    overlay.llm = llmOverlay;
  }
  const baseUrl = readUserBaseUrl(root, filePath);
  if (baseUrl !== undefined) {
    overlay.application = { baseUrl };
  }
  for (const [field, schema] of Object.entries(USER_BLOCKS)) {
    if (!Object.hasOwn(root, field)) {
      continue;
    }
    overlay[field] = validatedBlock(schema, root[field], filePath, field);
  }
  return overlay;
}

function readUserBaseUrl(
  root: Record<string, unknown>,
  filePath: string,
): string | undefined {
  if (!Object.hasOwn(root, "application")) {
    return undefined;
  }
  const application = root.application;
  if (!isPlainObject(application)) {
    throw configError(invalidUserConfigMessage(filePath, ["application"]));
  }
  if (!Object.hasOwn(application, "baseUrl")) {
    return undefined;
  }
  const parsed = z.string().url().safeParse(application.baseUrl);
  if (!parsed.success) {
    throw configError(invalidUserConfigMessage(filePath, ["application.baseUrl"]));
  }
  return parsed.data;
}

function validatedBlock(
  schema: z.ZodObject<z.ZodRawShape>,
  value: unknown,
  filePath: string,
  field: string,
): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw configError(invalidUserConfigMessage(filePath, [field]));
  }
  const parsed = schema.partial().safeParse(value);
  if (!parsed.success) {
    throw configError(
      invalidUserConfigMessage(filePath, blockFieldNames(field, parsed.error)),
    );
  }
  const accepted = parsed.data;
  const block: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (accepted[key] !== undefined) {
      block[key] = structuredClone(value[key]);
    }
  }
  return block;
}

function definedEntries(llm: Partial<LlmConfig>): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(llm)) {
    if (value !== undefined) {
      entries[key] = structuredClone(value);
    }
  }
  return entries;
}

function blockFieldNames(prefix: string, error: ZodError): string[] {
  const names: string[] = [];
  for (const issue of error.issues) {
    for (const name of issueFieldNames(issue)) {
      names.push(name === "(root)" ? prefix : `${prefix}.${name}`);
    }
  }
  return names.length === 0 ? [prefix] : names;
}

function readUserLlm(
  root: Record<string, unknown>,
  filePath: string,
  ignoredFields: string[],
): Partial<LlmConfig> {
  if (!Object.hasOwn(root, "llm")) {
    return {};
  }
  const llm = root.llm;
  if (!isPlainObject(llm)) {
    throw configError(invalidUserConfigMessage(filePath, ["llm"]));
  }
  stripApiKey(llm, "llm.apiKey", ignoredFields);
  const parsed = userLlmSchema.safeParse(llm);
  if (!parsed.success) {
    throw configError(invalidUserConfigMessage(filePath, fieldNames(parsed.error)));
  }
  return parsed.data;
}

function stripApiKey(
  record: Record<string, unknown>,
  field: string,
  ignoredFields: string[],
): void {
  if (!Object.hasOwn(record, "apiKey")) {
    return;
  }
  ignoredFields.push(field);
  delete record.apiKey;
}

function configError(message: string): QaError {
  return new QaError({
    code: "POLICY_BLOCKED",
    message,
  });
}

function unreadableUserConfigMessage(filePath: string): string {
  return `Unreadable ${USER_CONFIG_FILE_NAME} at ${filePath}`;
}

function invalidUserConfigMessage(
  filePath: string,
  fields: readonly string[],
): string {
  const listed = [...new Set(fields)].sort();
  const noun = listed.length === 1 ? "field" : "fields";
  return `Invalid ${USER_CONFIG_FILE_NAME} at ${filePath}: ${noun} ${listed.join(", ")}`;
}

function fieldNames(error: ZodError): string[] {
  const names: string[] = [];
  for (const issue of error.issues) {
    for (const name of issueFieldNames(issue)) {
      names.push(name === "(root)" ? "llm" : `llm.${name}`);
    }
  }
  return names.length === 0 ? ["llm"] : names;
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

function toUnknown(value: unknown): unknown {
  return value;
}
