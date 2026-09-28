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

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || !isConcrete(entry)) {
      continue;
    }

    const action = actionText(entry);
    const method = methodText(entry);
    const instruction = instructionText(entry);
    const role = text(entry.role);
    const accessibleName = text(entry.accessibleName);
    const ariaLabel = text(entry["aria-label"]);
    const screenshotPath = text(entry.screenshotPath);
    const urlBefore = urlText(entry) ?? "";
    const record: DiscoveryAction = {
      index: actions.length,
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

    actions.push(record);
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
  return trajectory;
}
