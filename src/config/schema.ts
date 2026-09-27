import { z } from "zod";
import { DEFAULT_MAX_RUN_DURATION_MS } from "./defaults.js";

/** Spec prose: project ids used in home-directory paths. */
export const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const LLM_PROVIDERS = ["openai-compatible", "openai"] as const;
export const PLAYWRIGHT_BROWSERS = ["chromium"] as const;
export const EVIDENCE_SCREENSHOT_MODES = ["checkpoints"] as const;
export const EVIDENCE_TRACE_MODES = ["on-failure", "off"] as const;

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
  })
  .strict();

export const stagehandSchema = z
  .object({
    enabled: z.boolean(),
    maxSteps: z.number().int().positive(),
    recoveryEnabled: z.boolean(),
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
