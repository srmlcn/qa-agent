import type { DiscoveryAction } from "../stagehand/trajectory.js";
import type { Locator } from "./schema.js";

const ROLE_SELECTOR =
  /^(?:internal:)?role=([A-Za-z][\w-]*)(?:\[name=(?:"([^"]*)"|'([^']*)')[a-z]*\])?$/;

const ENGINE_SELECTOR =
  /^(?:internal:)?(text|label|placeholder|testid|data-testid|css|id|nth|visible)=([\s\S]+)$/i;

const DATA_ATTRIBUTE_SELECTOR =
  /^\[(data-[\w-]+)=(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\]$/;

const DATA_ATTRIBUTE_NAME = /^data-[\w-]+$/;

type RoleParts = {
  role?: string;
  name?: string;
};

type SelectorEngine = {
  name: string;
  value: string;
};

/**
 * Preference, highest first:
 * role with an accessible name, label, placeholder, text, testid,
 * a `data-testid` or other `data-*` attribute, css, then xpath.
 * An attribute named `data-testid` stays below an explicit testid locator.
 */
const PREFERENCE_RANK: Readonly<Record<Locator["type"], number>> = {
  role: 0,
  label: 1,
  placeholder: 2,
  text: 3,
  testid: 4,
  attr: 5,
  css: 6,
  xpath: 7,
};

/**
 * Returns the highest-preference locator.
 * Role counts only when it has an accessible name. Attr counts only when
 * the attribute is `data-*`. XPath is returned when it is the only
 * rankable candidate.
 */
export function rankCandidates(candidates: readonly Locator[]): Locator {
  let selected: Locator | undefined;
  let selectedRank = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const rank = preferenceRank(candidate);
    if (rank === undefined || rank >= selectedRank) {
      continue;
    }
    selected = candidate;
    selectedRank = rank;
  }

  if (selected === undefined) {
    throw new Error("No rankable locator candidate.");
  }

  return selected;
}

/**
 * Reads selector strings and ARIA fields from a discovery action and
 * returns the single highest-preference locator. Returns undefined when
 * the action has no rankable candidate.
 */
export function chooseLocator(action: DiscoveryAction): Locator | undefined {
  const candidates = collectCandidates(action);
  if (candidates.length === 0) {
    return undefined;
  }
  return rankCandidates(candidates);
}

function preferenceRank(locator: Locator): number | undefined {
  switch (locator.type) {
    case "role":
      return hasText(locator.name) ? PREFERENCE_RANK.role : undefined;
    case "label":
      return hasText(locator.name) ? PREFERENCE_RANK.label : undefined;
    case "placeholder":
      return hasText(locator.value) ? PREFERENCE_RANK.placeholder : undefined;
    case "text":
      return hasText(locator.text) ? PREFERENCE_RANK.text : undefined;
    case "testid":
      return hasText(locator.name) ? PREFERENCE_RANK.testid : undefined;
    case "attr":
      return isDataAttribute(locator.name) && hasText(locator.value)
        ? PREFERENCE_RANK.attr
        : undefined;
    case "css":
      return hasText(locator.selector) ? PREFERENCE_RANK.css : undefined;
    case "xpath":
      return hasText(locator.selector) ? PREFERENCE_RANK.xpath : undefined;
  }
}

function collectCandidates(action: DiscoveryAction): Locator[] {
  const candidates: Locator[] = [];
  push(candidates, roleCandidate(action));
  push(candidates, labelCandidate(action));
  push(candidates, placeholderCandidate(action));
  push(candidates, testIdCandidate(action));
  push(candidates, attrRecordCandidate(action));
  pushDataAttributes(candidates, action);
  pushDataAttributes(candidates, action.arguments);
  push(candidates, cssCandidate(action));
  push(candidates, xpathCandidate(action));

  for (const selector of selectorStrings(action)) {
    push(candidates, locatorFromSelector(selector));
  }

  return candidates;
}

function roleCandidate(action: DiscoveryAction): Locator | undefined {
  let role = hintString(action, "role");
  let name =
    hintString(action, "name") ??
    hintString(action, "accessibleName") ??
    hintString(action, "aria-label");

  for (const selector of selectorStrings(action)) {
    const parsed = parseRoleSelector(selector);
    if (parsed === undefined) {
      continue;
    }
    role = role ?? parsed.role;
    name = name ?? parsed.name;
  }

  if (role === undefined || name === undefined) {
    return undefined;
  }

  return { type: "role", role, name };
}

function labelCandidate(action: DiscoveryAction): Locator | undefined {
  const name = hintString(action, "label");
  if (name === undefined) {
    return undefined;
  }
  return { type: "label", name };
}

function placeholderCandidate(action: DiscoveryAction): Locator | undefined {
  const value = hintString(action, "placeholder");
  if (value === undefined) {
    return undefined;
  }
  return { type: "placeholder", value };
}

function testIdCandidate(action: DiscoveryAction): Locator | undefined {
  const name = hintString(action, "testid") ?? hintString(action, "testId");
  if (name === undefined) {
    return undefined;
  }
  return { type: "testid", name };
}

function attrRecordCandidate(action: DiscoveryAction): Locator | undefined {
  const record =
    recordProperty(action, "attr") ?? recordProperty(action.arguments, "attr");
  if (record === undefined) {
    return undefined;
  }
  const name = nonEmptyString(record.name);
  const value = nonEmptyString(record.value);
  if (name === undefined || value === undefined || !isDataAttribute(name)) {
    return undefined;
  }
  return { type: "attr", name, value };
}

function cssCandidate(action: DiscoveryAction): Locator | undefined {
  const explicit = hintString(action, "css");
  if (explicit === undefined) {
    return undefined;
  }
  const selector = stripEngine(explicit, "css");
  if (selector.length === 0) {
    return undefined;
  }
  return { type: "css", selector };
}

function xpathCandidate(action: DiscoveryAction): Locator | undefined {
  const explicit = hintString(action, "xpath");
  if (explicit === undefined) {
    return undefined;
  }
  const selector = stripEngine(explicit, "xpath");
  if (selector.length === 0) {
    return undefined;
  }
  return { type: "xpath", selector };
}

function locatorFromSelector(selector: string): Locator | undefined {
  const trimmed = selector.trim();
  if (trimmed.length === 0 || parseRoleSelector(trimmed) !== undefined) {
    return undefined;
  }

  if (isXPath(trimmed)) {
    const xpath = stripEngine(trimmed, "xpath");
    return xpath.length > 0 ? { type: "xpath", selector: xpath } : undefined;
  }

  const engine = parseEngine(trimmed);
  if (engine !== undefined) {
    return locatorFromEngine(engine);
  }

  const attribute = parseDataAttribute(trimmed);
  if (attribute !== undefined) {
    return attribute;
  }

  if (/^internal:/i.test(trimmed)) {
    return undefined;
  }

  return { type: "css", selector: trimmed };
}

function locatorFromEngine(engine: SelectorEngine): Locator | undefined {
  const name = engine.name.toLowerCase();
  if (name === "css") {
    const selector = engine.value.trim();
    return selector.length > 0 ? { type: "css", selector } : undefined;
  }

  if (engine.value.includes(">>")) {
    return undefined;
  }

  const value = unquote(engine.value);
  if (value.length === 0) {
    return undefined;
  }

  switch (name) {
    case "text":
      return { type: "text", text: value };
    case "label":
      return { type: "label", name: value };
    case "placeholder":
      return { type: "placeholder", value };
    case "testid":
    case "data-testid":
      return { type: "testid", name: value };
    default:
      return undefined;
  }
}

function parseDataAttribute(selector: string): Locator | undefined {
  const match = DATA_ATTRIBUTE_SELECTOR.exec(selector);
  if (match === null) {
    return undefined;
  }
  const name = match[1];
  const value = nonEmptyString(match[2] ?? match[3] ?? match[4]);
  if (name === undefined || value === undefined || !isDataAttribute(name)) {
    return undefined;
  }
  return { type: "attr", name, value };
}

function parseEngine(selector: string): SelectorEngine | undefined {
  const match = ENGINE_SELECTOR.exec(selector);
  if (match === null) {
    return undefined;
  }
  const name = match[1];
  const value = match[2];
  if (name === undefined || value === undefined) {
    return undefined;
  }
  return { name, value };
}

function parseRoleSelector(selector: string): RoleParts | undefined {
  const match = ROLE_SELECTOR.exec(selector.trim());
  if (match === null) {
    return undefined;
  }
  const role = match[1];
  if (role === undefined) {
    return undefined;
  }
  const name = nonEmptyString(match[2] ?? match[3]);
  if (name === undefined) {
    return { role };
  }
  return { role, name };
}

function selectorStrings(action: DiscoveryAction): string[] {
  const selectors: string[] = [];
  const direct = nonEmptyString(action.selector);
  if (direct !== undefined) {
    selectors.push(direct);
  }
  const nested = stringProperty(action.arguments, "selector");
  if (nested !== undefined && !selectors.includes(nested)) {
    selectors.push(nested);
  }
  return selectors;
}

function pushDataAttributes(candidates: Locator[], value: unknown): void {
  if (!isPlainRecord(value)) {
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!isDataAttribute(key)) {
      continue;
    }
    const text = nonEmptyString(entry);
    if (text === undefined) {
      continue;
    }
    candidates.push({ type: "attr", name: key, value: text });
  }
}

function hintString(action: DiscoveryAction, key: string): string | undefined {
  return stringProperty(action, key) ?? stringProperty(action.arguments, key);
}

function recordProperty(
  value: unknown,
  key: string,
): Record<string, unknown> | undefined {
  if (!isPlainRecord(value) || !Object.hasOwn(value, key)) {
    return undefined;
  }
  const nested = value[key];
  return isPlainRecord(nested) ? nested : undefined;
}

function stringProperty(value: unknown, key: string): string | undefined {
  if (!isPlainRecord(value) || !Object.hasOwn(value, key)) {
    return undefined;
  }
  return nonEmptyString(value[key]);
}

function isDataAttribute(name: string): boolean {
  return DATA_ATTRIBUTE_NAME.test(name.trim());
}

function isXPath(selector: string): boolean {
  const trimmed = selector.trim();
  return (
    trimmed.toLowerCase().startsWith("xpath=") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("(") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../")
  );
}

function stripEngine(selector: string, engine: string): string {
  const trimmed = selector.trim();
  const prefix = `${engine}=`;
  if (trimmed.toLowerCase().startsWith(prefix)) {
    return trimmed.slice(prefix.length).trim();
  }
  return trimmed;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function push(candidates: Locator[], locator: Locator | undefined): void {
  if (locator !== undefined) {
    candidates.push(locator);
  }
}

function hasText(value: string): boolean {
  return value.trim().length > 0;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
