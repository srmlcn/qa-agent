import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { QaError } from "../errors/qa-error.js";
import { loadProjectConfig, projectConfigPath } from "./load-project.js";
import { loadUserConfig, type LoadedUserConfig } from "./load-user.js";
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
 * Precedence, highest first: caller `application.baseUrl`, user LLM fields,
 * project config, then defaults from `defaults.ts` via `loadProjectConfig`.
 * User `security`, `application.productionAllowed`, and `application.allowedHosts`
 * are ignored. Their names are returned in `warnings`. The API key value is never loaded.
 */
export function loadEffectiveConfig(
  projectRoot: string,
  overrides?: EffectiveConfigOverrides,
): EffectiveConfigResult {
  const user = loadUserConfig();
  const config = applyBaseUrlOverride(
    loadProjectLayer(projectRoot, user.llm),
    overrides,
  );
  return {
    config,
    warnings: warningList(user.ignoredFields),
  };
}

function loadProjectLayer(
  projectRoot: string,
  userLlm: LoadedUserConfig["llm"],
): ProjectConfig {
  if (Object.keys(userLlm).length === 0) {
    return loadProjectConfig(projectRoot);
  }
  const read = readProjectDocument(projectRoot);
  if (!read.ok) {
    return loadProjectConfig(projectRoot);
  }
  const merged = mergeUserLlm(read.document, userLlm);
  if (!merged.changed) {
    return loadProjectConfig(projectRoot);
  }
  return loadMergedDocument(projectRoot, merged.document);
}

function readProjectDocument(
  projectRoot: string,
): { ok: true; document: unknown } | { ok: false } {
  let source: string;
  try {
    source = readFileSync(projectConfigPath(projectRoot), "utf8");
  } catch {
    return { ok: false };
  }
  try {
    return { ok: true, document: toUnknown(parse(source)) };
  } catch {
    return { ok: false };
  }
}

function mergeUserLlm(
  document: unknown,
  userLlm: LoadedUserConfig["llm"],
): { document: unknown; changed: boolean } {
  if (!isPlainObject(document)) {
    return { document, changed: false };
  }
  if (document.llm !== undefined && !isPlainObject(document.llm)) {
    return { document, changed: false };
  }

  const projectLlm = isPlainObject(document.llm) ? document.llm : undefined;
  const llm: Record<string, unknown> =
    projectLlm === undefined ? {} : { ...projectLlm };
  let changed = false;
  for (const [field, value] of Object.entries(userLlm)) {
    if (value === undefined) {
      continue;
    }
    if (
      projectLlm !== undefined &&
      Object.hasOwn(projectLlm, field) &&
      sameJsonValue(projectLlm[field], value)
    ) {
      continue;
    }
    llm[field] = value;
    changed = true;
  }
  if (!changed) {
    return { document, changed: false };
  }
  return {
    document: {
      ...document,
      llm,
    },
    changed: true,
  };
}

function loadMergedDocument(projectRoot: string, document: unknown): ProjectConfig {
  const tempRoot = mkdtempSync(join(tmpdir(), "qa-effective-"));
  const tempConfigPath = projectConfigPath(tempRoot);
  try {
    mkdirSync(join(tempRoot, ".autonomous-qa"));
    writeFileSync(tempConfigPath, stringify(document), "utf8");
    return loadProjectConfig(tempRoot);
  } catch (error: unknown) {
    if (error instanceof QaError) {
      throw new QaError({
        code: error.code,
        message: error.message.replaceAll(
          tempConfigPath,
          projectConfigPath(projectRoot),
        ),
      });
    }
    throw error;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
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

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toUnknown(value: unknown): unknown {
  return value;
}
