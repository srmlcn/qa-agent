import { z } from "zod";

const flowIdPattern = /^[a-z0-9]+(\.[a-z0-9-]+)*$/;

const roleLocatorSchema = z
  .object({
    type: z.literal("role"),
    role: z.string(),
    name: z.string(),
  })
  .strict();

const labelLocatorSchema = z
  .object({
    type: z.literal("label"),
    name: z.string(),
  })
  .strict();

const placeholderLocatorSchema = z
  .object({
    type: z.literal("placeholder"),
    value: z.string(),
  })
  .strict();

const textLocatorSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
  })
  .strict();

const testIdLocatorSchema = z
  .object({
    type: z.literal("testid"),
    name: z.string(),
  })
  .strict();

const attrLocatorSchema = z
  .object({
    type: z.literal("attr"),
    name: z.string(),
    value: z.string(),
  })
  .strict();

const cssLocatorSchema = z
  .object({
    type: z.literal("css"),
    selector: z.string(),
  })
  .strict();

const xpathLocatorSchema = z
  .object({
    type: z.literal("xpath"),
    selector: z.string(),
  })
  .strict();

export const locatorSchema = z.discriminatedUnion("type", [
  roleLocatorSchema,
  labelLocatorSchema,
  placeholderLocatorSchema,
  textLocatorSchema,
  testIdLocatorSchema,
  attrLocatorSchema,
  cssLocatorSchema,
  xpathLocatorSchema,
]);

const stepIdentity = {
  id: z.string().min(1),
  intent: z.string(),
  semanticFallback: z.string().optional(),
};

const sequenceActionIdentity = {
  id: z.string().min(1).optional(),
  intent: z.string().optional(),
  semanticFallback: z.string().optional(),
};

function actionSchema<Action extends string>(
  action: Action,
  extras: z.ZodRawShape,
  identity: z.ZodRawShape,
) {
  return z
    .object({
      ...identity,
      action: z.literal(action),
      ...extras,
    })
    .strict();
}

function actionSchemas(identity: z.ZodRawShape) {
  return [
    actionSchema("goto", { value: z.string() }, identity),
    actionSchema("click", { locator: locatorSchema }, identity),
    actionSchema(
      "fill",
      { locator: locatorSchema, value: z.string() },
      identity,
    ),
    actionSchema(
      "press",
      { locator: locatorSchema, value: z.string() },
      identity,
    ),
    actionSchema(
      "select",
      { locator: locatorSchema, value: z.string() },
      identity,
    ),
    actionSchema("check", { locator: locatorSchema }, identity),
    actionSchema("uncheck", { locator: locatorSchema }, identity),
    actionSchema("reload", {}, identity),
    actionSchema(
      "waitFor",
      {
        locator: locatorSchema.optional(),
        value: z.string().optional(),
      },
      identity,
    ),
  ] as const;
}

export const stepSchema = z.discriminatedUnion(
  "action",
  actionSchemas(stepIdentity),
);

const sequenceActionSchema = z.discriminatedUnion(
  "action",
  actionSchemas(sequenceActionIdentity),
);

const optionalAssertionId = z.string().min(1).optional();
const requiredAssertionId = z.string().min(1);

function visibleAssertionSchema(id: z.ZodType<string | undefined> | z.ZodString) {
  return z
    .object({
      id,
      type: z.literal("visible"),
      locator: locatorSchema,
    })
    .strict();
}

function notVisibleAssertionSchema(
  id: z.ZodType<string | undefined> | z.ZodString,
) {
  return z
    .object({
      id,
      type: z.literal("not-visible"),
      locator: locatorSchema,
    })
    .strict();
}

function textAssertionSchema(id: z.ZodType<string | undefined> | z.ZodString) {
  return z
    .object({
      id,
      type: z.literal("text"),
      locator: locatorSchema,
      text: z.string(),
    })
    .strict();
}

function urlAssertionSchema(id: z.ZodType<string | undefined> | z.ZodString) {
  return z
    .object({
      id,
      type: z.literal("url"),
      url: z.string(),
    })
    .strict();
}

/**
 * Section 3.5 writes `custom-sequence` and a nested `assert` key.
 * Both are parser-boundary aliases. The stored assertion uses `type`.
 */
function normalizeAssertionAlias(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }

  const record = { ...(value as Record<string, unknown>) };
  if ("assert" in record) {
    const asserted = record.assert;
    delete record.assert;
    if (!("type" in record)) {
      record.type = asserted === "custom-sequence" ? "sequence" : asserted;
    }
  }
  if (record.type === "custom-sequence") {
    record.type = "sequence";
  }
  return record;
}

const nestedAssertionSchema = z.discriminatedUnion("type", [
  visibleAssertionSchema(optionalAssertionId),
  notVisibleAssertionSchema(optionalAssertionId),
  textAssertionSchema(optionalAssertionId),
  urlAssertionSchema(optionalAssertionId),
]);

const sequenceEntrySchema = z.preprocess(
  normalizeAssertionAlias,
  z.union([sequenceActionSchema, nestedAssertionSchema]),
);

const sequenceAssertionSchema = z
  .object({
    id: requiredAssertionId,
    type: z.literal("sequence"),
    sequence: z.array(sequenceEntrySchema).min(1),
  })
  .strict();

export const assertionSchema = z.preprocess(
  normalizeAssertionAlias,
  z.discriminatedUnion("type", [
    visibleAssertionSchema(requiredAssertionId),
    notVisibleAssertionSchema(requiredAssertionId),
    textAssertionSchema(requiredAssertionId),
    urlAssertionSchema(requiredAssertionId),
    sequenceAssertionSchema,
  ]),
);

const inputSchema = z
  .object({
    type: z.enum(["string", "number", "boolean"]),
    required: z.boolean().optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  })
  .strict();

const screenshotSchema = z
  .object({
    after: z.string().min(1),
  })
  .strict();

const canonicalEvidenceSchema = z
  .object({
    screenshots: z.array(screenshotSchema).optional(),
    network: z.boolean().optional(),
    console: z
      .object({
        errors: z.boolean(),
      })
      .strict()
      .optional(),
    trace: z.enum(["on-failure", "off"]).optional(),
  })
  .strict();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeNetwork(value: unknown): unknown {
  if (typeof value === "boolean" || !isRecord(value)) {
    return value;
  }
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === "capture" && typeof value.capture === "boolean") {
    return value.capture;
  }
  return value;
}

function normalizeTrace(value: unknown): unknown {
  if (value === "on-failure" || value === "off" || !isRecord(value)) {
    return value;
  }
  const keys = Object.keys(value);
  if (
    keys.length === 1 &&
    keys[0] === "onFailure" &&
    typeof value.onFailure === "boolean"
  ) {
    return value.onFailure ? "on-failure" : "off";
  }
  return value;
}

/**
 * The section 3.5 sample writes `network.capture` and `trace.onFailure`.
 * In memory, network is a boolean and trace is `on-failure` or `off`.
 */
function normalizeEvidence(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const record = { ...value };
  if ("network" in record) {
    record.network = normalizeNetwork(record.network);
  }
  if ("trace" in record) {
    record.trace = normalizeTrace(record.trace);
  }
  return record;
}

const evidenceSchema = z.preprocess(normalizeEvidence, canonicalEvidenceSchema);

const flowStateSchema = z.enum([
  "draft",
  "validated",
  "stable",
  "stale",
  "repaired",
]);

export const flowSpecSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(flowIdPattern),
    name: z.string(),
    objective: z.string(),
    state: flowStateSchema.default("draft"),
    authProfile: z.string().optional(),
    inputs: z.record(inputSchema),
    steps: z.array(stepSchema),
    assertions: z.array(assertionSchema),
    evidence: evidenceSchema.optional(),
  })
  .strict();

export type Locator = z.infer<typeof locatorSchema>;
export type Step = z.infer<typeof stepSchema>;
export type Assertion = z.infer<typeof assertionSchema>;
export type FlowSpec = z.infer<typeof flowSpecSchema>;

export function parseFlowSpec(input: unknown): FlowSpec {
  return flowSpecSchema.parse(input);
}
