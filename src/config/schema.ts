import { z } from "zod";
import {
  DEFAULT_CURSOR_SHOW_ON_ACTIONS,
  DEFAULT_FFMPEG_CRF,
  DEFAULT_SCREENSHOT_LOAD_TIMEOUT_MS,
  DEFAULT_SCREENSHOT_NETWORK_IDLE_TIMEOUT_MS,
  DEFAULT_SCREENSHOT_SETTLE_DELAY_MS,
  DEFAULT_VIDEO_HEIGHT,
  DEFAULT_VIDEO_WIDTH,
} from "./evidence-defaults.js";
import { DEFAULT_MAX_RUN_DURATION_MS } from "./defaults.js";

/** Spec prose: project ids used in home-directory paths. */
export const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const LLM_PROVIDERS = [
  "openai-compatible",
  "openai",
  "anthropic",
  "grok",
] as const;
export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export const PLAYWRIGHT_BROWSERS = ["chromium"] as const;
export const EVIDENCE_SCREENSHOT_MODES = ["checkpoints"] as const;
export const EVIDENCE_TRACE_MODES = ["on-failure", "off"] as const;
export const EVIDENCE_SCREENSHOT_LOAD_STATES = [
  "load",
  "domcontentloaded",
  "networkidle",
] as const;
export const EVIDENCE_SCREENSHOT_ANIMATIONS = ["disabled", "allow"] as const;
export const EVIDENCE_SCREENSHOT_CARET = ["hide", "initial"] as const;
export const EVIDENCE_CURSOR_MODES = ["auto", "always", "never"] as const;
export const CURSOR_SHOW_ON_ACTIONS = [
  "hover",
  "click",
  "select",
  "check",
  "uncheck",
  "drag",
  "move",
] as const;
export const EVIDENCE_CURSOR_STYLES = ["native-arrow"] as const;
export const EVIDENCE_FFMPEG_PRESETS = [
  "ultrafast",
  "superfast",
  "veryfast",
  "faster",
  "fast",
  "medium",
  "slow",
  "slower",
  "veryslow",
] as const;

export const evidenceScreenshotOptionsSchema = z
  .object({
    waitForLoadState: z
      .enum(EVIDENCE_SCREENSHOT_LOAD_STATES)
      .default("networkidle"),
    loadTimeoutMs: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_SCREENSHOT_LOAD_TIMEOUT_MS),
    networkIdleTimeoutMs: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_SCREENSHOT_NETWORK_IDLE_TIMEOUT_MS),
    settleDelayMs: z
      .number()
      .int()
      .nonnegative()
      .default(DEFAULT_SCREENSHOT_SETTLE_DELAY_MS),
    animations: z.enum(EVIDENCE_SCREENSHOT_ANIMATIONS).default("disabled"),
    caret: z.enum(EVIDENCE_SCREENSHOT_CARET).default("initial"),
    fullPage: z.boolean().default(false),
  })
  .strict();

export const evidenceCursorSchema = z
  .object({
    mode: z.enum(EVIDENCE_CURSOR_MODES).default("auto"),
    showOnActions: z
      .array(z.enum(CURSOR_SHOW_ON_ACTIONS))
      .default([...DEFAULT_CURSOR_SHOW_ON_ACTIONS]),
    showOnLocatorWait: z.boolean().default(true),
    showOnFailure: z.boolean().default(true),
    showOnLowSemanticLocator: z.boolean().default(true),
    style: z.enum(EVIDENCE_CURSOR_STYLES).default("native-arrow"),
  })
  .strict();

export const evidenceFfmpegSchema = z
  .object({
    enabled: z.boolean().default(true),
    outputFormat: z.literal("mp4").default("mp4"),
    crf: z.number().int().min(0).max(51).default(DEFAULT_FFMPEG_CRF),
    preset: z.enum(EVIDENCE_FFMPEG_PRESETS).default("veryfast"),
    keepSourceWebm: z.boolean().default(false),
  })
  .strict();

export const evidenceVideoSchema = z
  .object({
    enabled: z.boolean().default(false),
    size: z
      .object({
        width: z.number().int().positive().default(DEFAULT_VIDEO_WIDTH),
        height: z.number().int().positive().default(DEFAULT_VIDEO_HEIGHT),
      })
      .strict()
      .default({ width: DEFAULT_VIDEO_WIDTH, height: DEFAULT_VIDEO_HEIGHT }),
    retainOnPass: z.boolean().default(false),
    retainOnFailure: z.boolean().default(true),
    ffmpeg: evidenceFfmpegSchema.default({
      enabled: true,
      outputFormat: "mp4",
      crf: DEFAULT_FFMPEG_CRF,
      preset: "veryfast",
      keepSourceWebm: false,
    }),
  })
  .strict();

export const projectSchema = z
  .object({
    id: z.string().regex(PROJECT_ID_PATTERN),
  })
  .strict();

export const applicationSchema = z
  .object({
    baseUrl: z.string().url(),
    allowedHosts: z.array(z.string().min(1)).min(1),
    productionAllowed: z.boolean(),
  })
  .strict();

export const llmSchema = z
  .object({
    provider: z.enum(LLM_PROVIDERS),
    model: z.string().min(1),
    baseUrl: z.string().url().optional(),
    apiKeyEnv: z.string().regex(ENV_VAR_NAME_PATTERN),
    timeoutMs: z.number().int().positive(),
    headers: z.record(z.string()).optional(),
    /** Overrides the provider client's reasoning-effort default. */
    reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
  })
  .strict();

export const stagehandSchema = z
  .object({
    enabled: z.boolean(),
    maxSteps: z.number().int().positive(),
    recoveryEnabled: z.boolean(),
    /** Optional in YAML. Omitted configs leave browser debug tools unregistered. */
    debugTools: z.boolean().default(false),
  })
  .strict();

export const playwrightSchema = z
  .object({
    browser: z.enum(PLAYWRIGHT_BROWSERS),
    headless: z.boolean(),
    workers: z.number().int().positive(),
    timeoutMs: z.number().int().positive(),
  })
  .strict();

export const evidenceSchema = z
  .object({
    screenshots: z.enum(EVIDENCE_SCREENSHOT_MODES),
    network: z.boolean(),
    console: z.boolean(),
    trace: z.enum(EVIDENCE_TRACE_MODES),
    maxResponseBodyBytes: z.number().int().nonnegative(),
    screenshotOptions: evidenceScreenshotOptionsSchema.default({
      waitForLoadState: "networkidle",
      loadTimeoutMs: DEFAULT_SCREENSHOT_LOAD_TIMEOUT_MS,
      networkIdleTimeoutMs: DEFAULT_SCREENSHOT_NETWORK_IDLE_TIMEOUT_MS,
      settleDelayMs: DEFAULT_SCREENSHOT_SETTLE_DELAY_MS,
      animations: "disabled",
      caret: "initial",
      fullPage: false,
    }),
    cursor: evidenceCursorSchema.default({
      mode: "auto",
      showOnActions: [...DEFAULT_CURSOR_SHOW_ON_ACTIONS],
      showOnLocatorWait: true,
      showOnFailure: true,
      showOnLowSemanticLocator: true,
      style: "native-arrow",
    }),
    video: evidenceVideoSchema.default({
      enabled: false,
      size: { width: DEFAULT_VIDEO_WIDTH, height: DEFAULT_VIDEO_HEIGHT },
      retainOnPass: false,
      retainOnFailure: true,
      ffmpeg: {
        enabled: true,
        outputFormat: "mp4",
        crf: DEFAULT_FFMPEG_CRF,
        preset: "veryfast",
        keepSourceWebm: false,
      },
    }),
  })
  .strict();

export const securitySchema = z
  .object({
    redactHeaders: z.array(z.string().min(1)),
    destructiveActionsAllowed: z.boolean(),
    /** Optional in YAML. Omitted configs receive 10 minutes. */
    maxRunDurationMs: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_MAX_RUN_DURATION_MS),
  })
  .strict();

export const authSchema = z
  .object({
    workerProfiles: z.array(z.string().min(1)),
  })
  .strict();

export const projectConfigSchema = z
  .object({
    version: z.literal(1),
    project: projectSchema,
    application: applicationSchema,
    llm: llmSchema,
    stagehand: stagehandSchema,
    playwright: playwrightSchema,
    evidence: evidenceSchema,
    security: securitySchema,
    auth: authSchema,
  })
  .strict();

export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export type LlmConfig = z.infer<typeof llmSchema>;
