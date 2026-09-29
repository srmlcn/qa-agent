import { QaError } from "../errors/qa-error.js";
import { builtinProjectDocument } from "./defaults.js";
import { loadUserConfig, userConfigPath } from "./load-user.js";
import {
  projectConfigPath,
  readOptionalProjectDocument,
  validateProjectDocument,
} from "./load-project.js";
import { projectIdFromRoot } from "./project-id.js";
import { applicationSchema, type ProjectConfig } from "./schema.js";

export type EffectiveConfigOverrides = {
  application?: {
    baseUrl?: string;
  };
};

export type EffectiveConfigResult = {
  config: ProjectConfig;
  warnings: readonly string[];
};

/**
 * Loads one effective config.
 * Precedence, highest first: caller `application.baseUrl`, keys in the repo
 * file, keys in the user config, then built-in defaults.
 * A missing repo file is a repo with no local overrides.
 * User `security`, `application.productionAllowed`, and `application.allowedHosts`
 * are ignored. Their names are returned in `warnings`. The API key value is never loaded.
 */
export function loadEffectiveConfig(
  projectRoot: string,
  overrides?: EffectiveConfigOverrides,
): EffectiveConfigResult {
  const user = loadUserConfig();
  const project = readOptionalProjectDocument(projectRoot);
  const defaults = builtinProjectDocument(projectIdFromRoot(projectRoot));
  const merged = project === undefined
    ? mergeLayers(defaults, user.overlay)
    : mergeLayers(mergeLayers(defaults, user.overlay), project);
  const filePath = project === undefined
    ? userConfigPath()
    : projectConfigPath(projectRoot);
  const config = applyBaseUrlOverride(
    validateProjectDocument(merged, filePath),
    overrides,
  );
  return {
    config,
    warnings: warningList(user.ignoredFields),
  };
}

/**
 * Later layer wins per key. Nested config objects merge.
 * Arrays and `headers` replace the whole value, matching a single git key.
 */
function mergeLayers(
  base: Record<string, unknown>,
  overlay: unknown,
): Record<string, unknown> {
  if (!isPlainObject(overlay)) {
    return base;
  }
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const current = result[key];
    if (key !== "headers" && isPlainObject(value) && isPlainObject(current)) {
      result[key] = mergeLayers(current, value);
      continue;
    }
    result[key] = value;
  }
  return result;
}

function applyBaseUrlOverride(
  config: ProjectConfig,
  overrides: EffectiveConfigOverrides | undefined,
): ProjectConfig {
  const baseUrl = overrides?.application?.baseUrl;
  if (baseUrl === undefined) {
    return config;
  }
  const parsed = applicationSchema.shape.baseUrl.safeParse(baseUrl);
  if (!parsed.success) {
    throw new QaError({
      code: "POLICY_BLOCKED",
      message: "Invalid override: field application.baseUrl",
    });
  }
  return {
    ...config,
    application: {
      ...config.application,
      baseUrl: parsed.data,
    },
  };
}

function warningList(fields: readonly string[]): string[] {
  return [...fields]
    .sort()
    .map((field) => `Ignored user config field ${field}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
