const DEFAULT_PRODUCTION_ALLOWED = false;
const DEFAULT_DESTRUCTIVE_ACTIONS_ALLOWED = false;
/** Ten minutes. Used when `security.maxRunDurationMs` is omitted. */
const DEFAULT_MAX_RUN_DURATION_MS = 600_000;
const DEFAULT_PLAYWRIGHT_BROWSER = "chromium";
const DEFAULT_PLAYWRIGHT_HEADLESS = true;
const DEFAULT_STAGEHAND_MAX_STEPS = 30;
const DEFAULT_MAX_RESPONSE_BODY_BYTES = 262144;
const DEFAULT_REDACT_HEADERS = ["authorization", "cookie", "set-cookie"] as const;
const DEFAULT_WORKER_PROFILES: readonly string[] = [];

export {
  DEFAULT_DESTRUCTIVE_ACTIONS_ALLOWED,
  DEFAULT_MAX_RESPONSE_BODY_BYTES,
  DEFAULT_MAX_RUN_DURATION_MS,
  DEFAULT_PLAYWRIGHT_BROWSER,
  DEFAULT_PLAYWRIGHT_HEADLESS,
  DEFAULT_PRODUCTION_ALLOWED,
  DEFAULT_REDACT_HEADERS,
  DEFAULT_STAGEHAND_MAX_STEPS,
  DEFAULT_WORKER_PROFILES,
};

const APPLICATION_DEFAULTS: Readonly<Record<string, unknown>> = {
  productionAllowed: DEFAULT_PRODUCTION_ALLOWED,
};

const PLAYWRIGHT_DEFAULTS: Readonly<Record<string, unknown>> = {
  browser: DEFAULT_PLAYWRIGHT_BROWSER,
  headless: DEFAULT_PLAYWRIGHT_HEADLESS,
};

const STAGEHAND_DEFAULTS: Readonly<Record<string, unknown>> = {
  maxSteps: DEFAULT_STAGEHAND_MAX_STEPS,
};

const EVIDENCE_DEFAULTS: Readonly<Record<string, unknown>> = {
  maxResponseBodyBytes: DEFAULT_MAX_RESPONSE_BODY_BYTES,
};

const SECURITY_DEFAULTS: Readonly<Record<string, unknown>> = {
  destructiveActionsAllowed: DEFAULT_DESTRUCTIVE_ACTIONS_ALLOWED,
  maxRunDurationMs: DEFAULT_MAX_RUN_DURATION_MS,
  redactHeaders: DEFAULT_REDACT_HEADERS,
};

const AUTH_DEFAULTS: Readonly<Record<string, unknown>> = {
  workerProfiles: DEFAULT_WORKER_PROFILES,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneDefaultValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return [...value];
  }
  return value;
}

function cloneDefaultRecord(
  defaults: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const cloned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(defaults)) {
    cloned[key] = cloneDefaultValue(value);
  }
  return cloned;
}

function withFieldDefaults(
  target: Record<string, unknown>,
  key: string,
  defaults: Readonly<Record<string, unknown>>,
  materializeWhenMissing: boolean,
): void {
  const current = target[key];
  if (current === undefined) {
    if (materializeWhenMissing) {
      target[key] = cloneDefaultRecord(defaults);
    }
    return;
  }
  if (!isPlainObject(current)) {
    return;
  }

  const next: Record<string, unknown> = { ...current };
  for (const [field, value] of Object.entries(defaults)) {
    if (next[field] === undefined) {
      next[field] = cloneDefaultValue(value);
    }
  }
  target[key] = next;
}

/**
 * Fills omitted project-config defaults without overwriting values that are present.
 * Fully defaulted blocks (`security`, `auth`) are created when the block is absent.
 */
export function applyProjectDefaults(input: unknown): unknown {
  if (!isPlainObject(input)) {
    return input;
  }

  const result: Record<string, unknown> = { ...input };
  withFieldDefaults(result, "application", APPLICATION_DEFAULTS, false);
  withFieldDefaults(result, "playwright", PLAYWRIGHT_DEFAULTS, false);
  withFieldDefaults(result, "stagehand", STAGEHAND_DEFAULTS, false);
  withFieldDefaults(result, "evidence", EVIDENCE_DEFAULTS, false);
  withFieldDefaults(result, "security", SECURITY_DEFAULTS, true);
  withFieldDefaults(result, "auth", AUTH_DEFAULTS, true);
  return result;
}
