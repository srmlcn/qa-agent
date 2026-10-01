const DEFAULT_BASE_URL = "http://localhost:3000";
const DEFAULT_ALLOWED_HOSTS = ["localhost"] as const;
const DEFAULT_PRODUCTION_ALLOWED = false;
const DEFAULT_PLAYWRIGHT_WORKERS = 4;
const DEFAULT_PLAYWRIGHT_TIMEOUT_MS = 60_000;
const DEFAULT_STAGEHAND_ENABLED = true;
const DEFAULT_STAGEHAND_RECOVERY_ENABLED = true;
const DEFAULT_EVIDENCE_SCREENSHOTS = "checkpoints";
const DEFAULT_EVIDENCE_NETWORK = true;
const DEFAULT_EVIDENCE_CONSOLE = true;
const DEFAULT_EVIDENCE_TRACE = "on-failure";
const DEFAULT_DESTRUCTIVE_ACTIONS_ALLOWED = false;
/** Ten minutes. Used when `security.maxRunDurationMs` is omitted. */
const DEFAULT_MAX_RUN_DURATION_MS = 600_000;
const DEFAULT_PLAYWRIGHT_BROWSER = "chromium";
const DEFAULT_PLAYWRIGHT_HEADLESS = true;
const DEFAULT_STAGEHAND_DEBUG_TOOLS = false;
const DEFAULT_STAGEHAND_MAX_STEPS = 30;
const DEFAULT_MAX_RESPONSE_BODY_BYTES = 262144;
const DEFAULT_REDACT_HEADERS = ["authorization", "cookie", "set-cookie"] as const;
const DEFAULT_WORKER_PROFILES: readonly string[] = [];
const DEFAULT_SCREENSHOT_SETTLE_DELAY_MS = 1500;
const DEFAULT_SCREENSHOT_LOAD_TIMEOUT_MS = 15_000;
const DEFAULT_SCREENSHOT_NETWORK_IDLE_TIMEOUT_MS = 5000;
const DEFAULT_CURSOR_SHOW_ON_ACTIONS = [
  "hover",
  "click",
  "select",
  "check",
  "uncheck",
  "drag",
  "move",
] as const;
const DEFAULT_VIDEO_WIDTH = 1280;
const DEFAULT_VIDEO_HEIGHT = 720;
const DEFAULT_FFMPEG_CRF = 23;

export {
  DEFAULT_ALLOWED_HOSTS,
  DEFAULT_BASE_URL,
  DEFAULT_DESTRUCTIVE_ACTIONS_ALLOWED,
  DEFAULT_MAX_RESPONSE_BODY_BYTES,
  DEFAULT_MAX_RUN_DURATION_MS,
  DEFAULT_PLAYWRIGHT_BROWSER,
  DEFAULT_PLAYWRIGHT_HEADLESS,
  DEFAULT_PRODUCTION_ALLOWED,
  DEFAULT_REDACT_HEADERS,
  DEFAULT_STAGEHAND_DEBUG_TOOLS,
  DEFAULT_STAGEHAND_MAX_STEPS,
  DEFAULT_WORKER_PROFILES,
};

/**
 * Built-in project document used when a repo omits a key.
 * `llm` is absent: it comes from user config or the repo file.
 * Safety keys are present here because user config cannot set them.
 */
export function builtinProjectDocument(projectId: string): Record<string, unknown> {
  return {
    version: 1,
    project: { id: projectId },
    application: {
      baseUrl: DEFAULT_BASE_URL,
      allowedHosts: [...DEFAULT_ALLOWED_HOSTS],
      productionAllowed: DEFAULT_PRODUCTION_ALLOWED,
    },
    stagehand: {
      enabled: DEFAULT_STAGEHAND_ENABLED,
      maxSteps: DEFAULT_STAGEHAND_MAX_STEPS,
      recoveryEnabled: DEFAULT_STAGEHAND_RECOVERY_ENABLED,
    },
    playwright: {
      browser: DEFAULT_PLAYWRIGHT_BROWSER,
      headless: DEFAULT_PLAYWRIGHT_HEADLESS,
      workers: DEFAULT_PLAYWRIGHT_WORKERS,
      timeoutMs: DEFAULT_PLAYWRIGHT_TIMEOUT_MS,
    },
    evidence: {
      screenshots: DEFAULT_EVIDENCE_SCREENSHOTS,
      network: DEFAULT_EVIDENCE_NETWORK,
      console: DEFAULT_EVIDENCE_CONSOLE,
      trace: DEFAULT_EVIDENCE_TRACE,
      maxResponseBodyBytes: DEFAULT_MAX_RESPONSE_BODY_BYTES,
    },
    security: {
      destructiveActionsAllowed: DEFAULT_DESTRUCTIVE_ACTIONS_ALLOWED,
      redactHeaders: [...DEFAULT_REDACT_HEADERS],
    },
    auth: {
      workerProfiles: [...DEFAULT_WORKER_PROFILES],
    },
  };
}

const APPLICATION_DEFAULTS: Readonly<Record<string, unknown>> = {
  productionAllowed: DEFAULT_PRODUCTION_ALLOWED,
};

const PLAYWRIGHT_DEFAULTS: Readonly<Record<string, unknown>> = {
  browser: DEFAULT_PLAYWRIGHT_BROWSER,
  headless: DEFAULT_PLAYWRIGHT_HEADLESS,
};

const STAGEHAND_DEFAULTS: Readonly<Record<string, unknown>> = {
  debugTools: DEFAULT_STAGEHAND_DEBUG_TOOLS,
  maxSteps: DEFAULT_STAGEHAND_MAX_STEPS,
};

const EVIDENCE_SCREENSHOT_OPTIONS_DEFAULTS: Readonly<Record<string, unknown>> = {
  waitForLoadState: "networkidle",
  loadTimeoutMs: DEFAULT_SCREENSHOT_LOAD_TIMEOUT_MS,
  networkIdleTimeoutMs: DEFAULT_SCREENSHOT_NETWORK_IDLE_TIMEOUT_MS,
  settleDelayMs: DEFAULT_SCREENSHOT_SETTLE_DELAY_MS,
  animations: "disabled",
  caret: "initial",
  fullPage: false,
};

const EVIDENCE_CURSOR_DEFAULTS: Readonly<Record<string, unknown>> = {
  mode: "auto",
  showOnActions: [...DEFAULT_CURSOR_SHOW_ON_ACTIONS],
  showOnLocatorWait: true,
  showOnFailure: true,
  showOnLowSemanticLocator: true,
  style: "native-arrow",
};

const EVIDENCE_FFMPEG_DEFAULTS: Readonly<Record<string, unknown>> = {
  enabled: true,
  outputFormat: "mp4",
  crf: DEFAULT_FFMPEG_CRF,
  preset: "veryfast",
  keepSourceWebm: false,
};

const EVIDENCE_VIDEO_DEFAULTS: Readonly<Record<string, unknown>> = {
  enabled: false,
  size: { width: DEFAULT_VIDEO_WIDTH, height: DEFAULT_VIDEO_HEIGHT },
  retainOnPass: false,
  retainOnFailure: true,
  ffmpeg: { ...EVIDENCE_FFMPEG_DEFAULTS },
};

const EVIDENCE_DEFAULTS: Readonly<Record<string, unknown>> = {
  maxResponseBodyBytes: DEFAULT_MAX_RESPONSE_BODY_BYTES,
  screenshotOptions: { ...EVIDENCE_SCREENSHOT_OPTIONS_DEFAULTS },
  cursor: { ...EVIDENCE_CURSOR_DEFAULTS },
  video: { ...EVIDENCE_VIDEO_DEFAULTS },
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
  applyNestedEvidenceDefaults(result);
  withFieldDefaults(result, "security", SECURITY_DEFAULTS, true);
  withFieldDefaults(result, "auth", AUTH_DEFAULTS, true);
  return result;
}

function applyNestedEvidenceDefaults(result: Record<string, unknown>): void {
  const evidence = result.evidence;
  if (!isPlainObject(evidence)) {
    return;
  }
  withFieldDefaults(
    evidence,
    "screenshotOptions",
    EVIDENCE_SCREENSHOT_OPTIONS_DEFAULTS,
    true,
  );
  withFieldDefaults(evidence, "cursor", EVIDENCE_CURSOR_DEFAULTS, true);
  withFieldDefaults(evidence, "video", EVIDENCE_VIDEO_DEFAULTS, true);
  const video = evidence.video;
  if (isPlainObject(video)) {
    withFieldDefaults(video, "ffmpeg", EVIDENCE_FFMPEG_DEFAULTS, true);
    const size = video.size;
    if (!isPlainObject(size)) {
      video.size = {
        width: DEFAULT_VIDEO_WIDTH,
        height: DEFAULT_VIDEO_HEIGHT,
      };
    } else {
      if (size.width === undefined) {
        size.width = DEFAULT_VIDEO_WIDTH;
      }
      if (size.height === undefined) {
        size.height = DEFAULT_VIDEO_HEIGHT;
      }
    }
  }
}
