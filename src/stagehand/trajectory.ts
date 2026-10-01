import { QaError } from "../errors/qa-error.js";

export interface AgentActionLike {
  type?: unknown;
  action?: unknown;
  method?: unknown;
  instruction?: unknown;
  describe?: unknown;
  selector?: unknown;
  arguments?: unknown;
  playwrightArguments?: unknown;
  coordinates?: unknown;
  pageUrl?: unknown;
  urlBefore?: unknown;
  urlAfter?: unknown;
  screenshotPath?: unknown;
  [key: string]: unknown;
}

/** Structural agent result. This module does not import Stagehand. */
export interface AgentResultLike {
  success?: unknown;
  message?: unknown;
  actions?: unknown;
  [key: string]: unknown;
}

export interface DiscoveryTrajectoryMeta {
  startedAt: string;
  endedAt: string;
}

export interface DiscoveryAction {
  index: number;
  kind: string;
  instruction?: string;
  action?: string;
  selector?: string;
  method?: string;
  role?: string;
  accessibleName?: string;
  "aria-label"?: string;
  urlBefore: string;
  urlAfter: string;
  arguments: unknown;
  screenshotPath?: string;
}

export interface DiscoveryTrajectory {
  actions: DiscoveryAction[];
  startedAt: string;
  endedAt: string;
  success: boolean;
  note?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function nestedArguments(
  record: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return isRecord(record.playwrightArguments)
    ? record.playwrightArguments
    : undefined;
}

function actionText(record: Record<string, unknown>): string | undefined {
  return text(record.action) ?? text(nestedArguments(record)?.action);
}

function methodText(record: Record<string, unknown>): string | undefined {
  return text(record.method) ?? text(nestedArguments(record)?.method);
}

function instructionText(record: Record<string, unknown>): string | undefined {
  const nested = nestedArguments(record);
  return (
    text(record.instruction) ??
    text(record.describe) ??
    text(nested?.instruction) ??
    text(nested?.description)
  );
}

function selectorText(record: Record<string, unknown>): string {
  return text(record.selector) ?? text(nestedArguments(record)?.selector) ?? "";
}

function coordinateValue(record: Record<string, unknown>): unknown {
  if (record.coordinates !== undefined) {
    return record.coordinates;
  }
  return nestedArguments(record)?.coordinates;
}

function hasCoordinates(record: Record<string, unknown>): boolean {
  const coordinates = coordinateValue(record);
  if (Array.isArray(coordinates) && coordinates.length > 0) {
    return true;
  }
  return isRecord(coordinates) && ("x" in coordinates || "y" in coordinates);
}

function actionArguments(record: Record<string, unknown>): unknown {
  const base = explicitArguments(record);
  const extras = topLevelValues(record);
  if (extras === undefined) {
    return base;
  }
  if (isRecord(base)) {
    return { ...extras, ...base };
  }
  if (Array.isArray(base) && base.length === 0) {
    return extras;
  }
  return base;
}

function explicitArguments(record: Record<string, unknown>): unknown {
  if ("arguments" in record && record.arguments !== undefined) {
    return record.arguments;
  }
  const nested = nestedArguments(record);
  if (nested && "arguments" in nested && nested.arguments !== undefined) {
    return nested.arguments;
  }
  if (hasCoordinates(record)) {
    return { coordinates: coordinateValue(record) };
  }
  return {};
}

/**
 * Stagehand v3 puts keyboard text and navigation targets on the tool record
 * itself (`value`, `text`, `url`), not inside `arguments`.
 */
function topLevelValues(
  record: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const extras: Record<string, unknown> = {};
  for (const key of ["value", "text", "url"] as const) {
    const scalar = text(record[key]);
    if (scalar !== undefined) {
      extras[key] = scalar;
    }
  }
  const times = positiveInteger(record.times);
  if (times !== undefined) {
    extras.times = times;
  }
  return Object.keys(extras).length > 0 ? extras : undefined;
}

function urlText(record: Record<string, unknown>): string | undefined {
  return text(record.urlBefore) ?? text(record.pageUrl);
}

function followingUrl(
  entries: readonly Record<string, unknown>[],
  index: number,
): string | undefined {
  for (let cursor = index + 1; cursor < entries.length; cursor += 1) {
    const entry = entries[cursor];
    if (!entry) {
      continue;
    }
    const url = text(entry.urlBefore) ?? text(entry.pageUrl) ?? text(entry.urlAfter);
    if (url) {
      return url;
    }
  }
  return undefined;
}

function isConcrete(record: Record<string, unknown>): boolean {
  return (
    actionText(record) !== undefined ||
    methodText(record) !== undefined ||
    instructionText(record) !== undefined ||
    hasCoordinates(record)
  );
}

/**
 * Tool names from the installed Stagehand v3 agent (`AgentToolTypesMap`),
 * plus `done`. Comparison is case-insensitive; labels keep the recorded name.
 */
const V3_TOOL_NAMES = new Set([
  "act",
  "ariatree",
  "click",
  "clickandhold",
  "done",
  "draganddrop",
  "extract",
  "fillform",
  "fillformvision",
  "goto",
  "keys",
  "navback",
  "screenshot",
  "scroll",
  "search",
  "think",
  "type",
  "wait",
]);

/**
 * Tools that cannot become a replayable flow step. They are named in the
 * trajectory note, or they fail the run when nothing else is replayable.
 */
const UNSUPPORTED_V3_TOOLS = new Set([
  "ariatree",
  "clickandhold",
  "draganddrop",
  "extract",
  "navback",
  "screenshot",
  "scroll",
  "search",
  "think",
]);

function normalizeV3Record(
  record: Record<string, unknown>,
): Record<string, unknown> {
  return enrichKnownTool(unwrapToolEnvelope(record));
}

/**
 * AI SDK tool calls (`type: "tool-call"`, `toolName`, `input`), Stagehand's
 * `AgentToolCall` (`toolName`, `args`), and verifier steps (`actionName`,
 * `actionArgs`, `toolOutput`) nest the fields `isConcrete` looks for.
 * Flatten them into the tool record `mapToolResultToActions` would emit.
 */
function unwrapToolEnvelope(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const named = text(record.toolName) ?? text(record.actionName);
  const rawType = text(record.type);
  const type = rawType?.toLowerCase();
  const envelope =
    type === "tool-call" || type === "tool-result" || type === "tool-error";
  if (!envelope && named === undefined) {
    return record;
  }
  if (
    !envelope &&
    named !== undefined &&
    type !== undefined &&
    type === named.toLowerCase()
  ) {
    return record;
  }
  const toolName = named;
  if (toolName === undefined) {
    return record;
  }
  const input = firstRecord(record.input, record.args, record.actionArgs) ?? {};
  return {
    ...input,
    ...toolPayload(record),
    type: toolName,
    ...(record.pageUrl !== undefined ? { pageUrl: record.pageUrl } : {}),
    ...(record.urlBefore !== undefined ? { urlBefore: record.urlBefore } : {}),
    ...(record.urlAfter !== undefined ? { urlAfter: record.urlAfter } : {}),
    ...(record.reasoning !== undefined ? { reasoning: record.reasoning } : {}),
    ...(record.timestamp !== undefined ? { timestamp: record.timestamp } : {}),
    ...(record.screenshotPath !== undefined
      ? { screenshotPath: record.screenshotPath }
      : {}),
  };
}

function toolPayload(record: Record<string, unknown>): Record<string, unknown> {
  const direct = firstRecord(record.output, record.result);
  if (direct === undefined) {
    return {};
  }
  if (isRecord(direct.output)) {
    return direct.output;
  }
  if (typeof direct.ok === "boolean" && isRecord(direct.result)) {
    return direct.result;
  }
  return direct;
}

/**
 * Flat records from `mapToolResultToActions` use `type` as the tool name.
 * `goto` and `wait` carry `url` / `timeMs` and none of the fields
 * `isConcrete` already understands, so give them a replayable method first.
 */
function enrichKnownTool(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const type = text(record.type)?.toLowerCase();
  if (
    type === "goto" &&
    methodText(record) === undefined &&
    text(record.url) !== undefined
  ) {
    return { ...record, method: "goto" };
  }
  if (type === "wait" && methodText(record) === undefined) {
    const waited = finiteNumber(record.timeMs) ?? finiteNumber(record.waited);
    if (waited === undefined) {
      return record;
    }
    const current = isRecord(record.arguments) ? record.arguments : {};
    return {
      ...record,
      method: "waitFor",
      arguments: { ...current, value: String(waited) },
    };
  }
  return record;
}

function fillFormActs(
  record: Record<string, unknown>,
): Record<string, unknown>[] {
  const type = text(record.type)?.toLowerCase();
  if (type !== "fillform" && type !== "fillformvision") {
    return [];
  }
  if (!Array.isArray(record.playwrightArguments)) {
    return [];
  }
  const acts: Record<string, unknown>[] = [];
  for (const item of record.playwrightArguments) {
    if (!isRecord(item)) {
      continue;
    }
    acts.push({
      type: "act",
      reasoning: "acting from fillform tool",
      taskCompleted: false,
      playwrightArguments: item,
      ...(record.pageUrl !== undefined ? { pageUrl: record.pageUrl } : {}),
    });
  }
  return acts;
}

function v3ToolName(record: Record<string, unknown>): string | undefined {
  const type = text(record.type)?.toLowerCase();
  if (type !== undefined && V3_TOOL_NAMES.has(type)) {
    return type;
  }
  const named =
    text(record.toolName)?.toLowerCase() ??
    text(record.actionName)?.toLowerCase();
  if (named !== undefined && V3_TOOL_NAMES.has(named)) {
    return named;
  }
  return undefined;
}

function isDoneRecord(record: Record<string, unknown>): boolean {
  return v3ToolName(record) === "done" || text(record.type)?.toLowerCase() === "done";
}

function isFillFormSummary(record: Record<string, unknown>): boolean {
  const tool = v3ToolName(record);
  return tool === "fillform" || tool === "fillformvision";
}

/**
 * `keys` repeats a focused press or type `times` times (the tool's `repeat`
 * input when the result has not yet recorded `times`).
 */
function keyboardRepeats(record: Record<string, unknown>): number {
  const method = methodText(record)?.toLowerCase();
  const type = text(record.type)?.toLowerCase();
  const keyboard = type === "keys" || method === "press" || method === "type";
  if (!keyboard) {
    return 1;
  }
  return positiveInteger(record.times) ?? positiveInteger(record.repeat) ?? 1;
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return undefined;
  }
  return value;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function firstRecord(...values: unknown[]): Record<string, unknown> | undefined {
  for (const value of values) {
    if (isRecord(value)) {
      return value;
    }
  }
  return undefined;
}

function uniqueNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const name of names) {
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    ordered.push(name);
  }
  return ordered;
}

function skipNote(tools: readonly string[]): string {
  const names = uniqueNames(tools);
  if (names.length === 1) {
    return `Skipped unsupported Stagehand tool "${names[0]}".`;
  }
  return `Skipped unsupported Stagehand tools: ${names.join(", ")}.`;
}

function unsupportedToolsError(tools: readonly string[]): QaError {
  const names = uniqueNames(tools);
  return new QaError({
    code: "DISCOVERY_FAILED",
    message: `Discovery recorded only unsupported Stagehand tools (${names.join(", ")}). No replayable actions were produced.`,
  });
}

function emptyTrajectory(
  startedAt: string,
  endedAt: string,
): DiscoveryTrajectory {
  return {
    actions: [],
    startedAt,
    endedAt,
    success: false,
  };
}

export function fromAgentResult(
  result: AgentResultLike,
  meta: DiscoveryTrajectoryMeta,
): DiscoveryTrajectory {
  const startedAt = text(meta?.startedAt) ?? "";
  const endedAt = text(meta?.endedAt) ?? "";

  if (!isRecord(result)) {
    return emptyTrajectory(startedAt, endedAt);
  }

  const entries = Array.isArray(result.actions)
    ? result.actions.filter(isRecord)
    : [];
  const actions: DiscoveryAction[] = [];
  const skipped: string[] = [];
  const containers: string[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) {
      continue;
    }
    const normalized = normalizeV3Record(entry);
    if (isDoneRecord(normalized)) {
      continue;
    }
    const expanded = fillFormActs(normalized);
    const records = expanded.length > 0 ? expanded : [normalized];
    if (expanded.length === 0 && isFillFormSummary(normalized) && !isConcrete(normalized)) {
      containers.push(text(normalized.type) ?? "fillForm");
      continue;
    }
    for (const record of records) {
      if (isDoneRecord(record)) {
        continue;
      }
      const tool = v3ToolName(record);
      if (tool !== undefined && UNSUPPORTED_V3_TOOLS.has(tool)) {
        skipped.push(text(record.type) ?? tool);
        continue;
      }
      if (!isConcrete(record)) {
        continue;
      }
      const repeats = keyboardRepeats(record);
      for (let repeat = 0; repeat < repeats; repeat += 1) {
        actions.push(toDiscoveryAction(record, entries, index, actions.length));
      }
    }
  }

  if (actions.length === 0 && (skipped.length > 0 || containers.length > 0)) {
    throw unsupportedToolsError([...skipped, ...containers]);
  }

  const trajectory: DiscoveryTrajectory = {
    actions,
    startedAt,
    endedAt,
    success: result.success === true,
  };
  if (typeof result.message === "string") {
    trajectory.note = result.message;
  }
  if (skipped.length > 0) {
    const extra = skipNote(skipped);
    trajectory.note = trajectory.note === undefined ? extra : `${trajectory.note} ${extra}`;
  }
  return trajectory;
}

function toDiscoveryAction(
  entry: Record<string, unknown>,
  entries: readonly Record<string, unknown>[],
  index: number,
  actionIndex: number,
): DiscoveryAction {
  const action = actionText(entry);
  const method = methodText(entry);
  const instruction = instructionText(entry);
  const role = text(entry.role);
  const accessibleName = text(entry.accessibleName);
  const ariaLabel = text(entry["aria-label"]);
  const screenshotPath = text(entry.screenshotPath);
  const urlBefore = urlText(entry) ?? "";
  const record: DiscoveryAction = {
    index: actionIndex,
    kind: text(entry.type) ?? method ?? action ?? "action",
    selector: selectorText(entry),
    urlBefore,
    urlAfter: text(entry.urlAfter) ?? followingUrl(entries, index) ?? urlBefore,
    arguments: actionArguments(entry),
  };

  if (instruction) {
    record.instruction = instruction;
  }
  if (action) {
    record.action = action;
  }
  if (method) {
    record.method = method;
  }
  if (role) {
    record.role = role;
  }
  if (accessibleName) {
    record.accessibleName = accessibleName;
  }
  if (ariaLabel) {
    record["aria-label"] = ariaLabel;
  }
  if (screenshotPath) {
    record.screenshotPath = screenshotPath;
  }
  return record;
}
