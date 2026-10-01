import { chromium, type Locator, type Page } from "playwright";
import { QaError } from "../errors/qa-error.js";
import { locatorCandidates, rankCandidates } from "../flows/rank.js";
import type { Locator as FlowLocator } from "../flows/schema.js";
import type {
  DiscoveryAction,
  DiscoveryTrajectory,
} from "../stagehand/trajectory.js";

type AriaRole = Parameters<Page["getByRole"]>[0];

/**
 * Turns a stored FlowSpec locator into a Playwright locator.
 * Ranking stays in the flow ranker. `resolveTrajectoryLocators` checks a
 * live page before a candidate is stored.
 */
export function toLocator(page: Page, locator: FlowLocator): Locator {
  switch (locator.type) {
    case "role":
      return page.getByRole(asRole(locator.role), roleName(locator.name));
    case "label":
      return page.getByLabel(locator.name);
    case "placeholder":
      return page.getByPlaceholder(locator.value);
    case "text":
      return page.getByText(locator.text, { exact: true });
    case "testid":
      return page.getByTestId(locator.name);
    case "attr":
      return page.locator(attributeSelector(locator.name, locator.value));
    case "css":
      return page.locator(locator.selector);
    case "xpath":
      return page.locator(`xpath=${locator.selector}`);
    default:
      throw unsupportedLocator(locator);
  }
}

/**
 * An accessible name is matched exactly. `*` is a case-insensitive wildcard
 * substring; the rest of the name stays literal and is not a regular expression.
 */
function roleName(name: string): { name: string | RegExp; exact?: boolean } {
  if (!name.includes("*")) {
    return { name, exact: true };
  }
  const source = name.split("*").map(escapeRegExp).join(".*");
  return { name: new RegExp(source, "i") };
}

function asRole(role: string): AriaRole {
  return role as AriaRole;
}

function attributeSelector(name: string, value: string): string {
  return `[${escapeCssIdentifier(name)}="${escapeCssString(value)}"]`;
}

/** CSS.escape, so a quote in the attribute name cannot close or widen the selector. */
function escapeCssIdentifier(value: string): string {
  let escaped = "";
  const first = value.charCodeAt(0);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0) {
      escaped += "\uFFFD";
      continue;
    }
    if (
      (code >= 0x0001 && code <= 0x001f) ||
      code === 0x007f ||
      (index === 0 && isDigit(code)) ||
      (index === 1 && isDigit(code) && first === 0x002d)
    ) {
      escaped += `\\${code.toString(16)} `;
      continue;
    }
    if (index === 0 && value.length === 1 && code === 0x002d) {
      escaped += `\\${value.charAt(index)}`;
      continue;
    }
    if (isCssIdentChar(code)) {
      escaped += value.charAt(index);
      continue;
    }
    escaped += `\\${value.charAt(index)}`;
  }
  return escaped;
}

/**
 * CSSOM serialization of a double-quoted string body. NUL becomes U+FFFD.
 * Other controls are hexadecimal escapes, so a newline, carriage return,
 * or form feed cannot end or rewrite the attribute selector.
 */
function escapeCssString(value: string): string {
  let escaped = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0) {
      escaped += "\uFFFD";
      continue;
    }
    if ((code >= 0x0001 && code <= 0x001f) || code === 0x007f) {
      escaped += `\\${code.toString(16)} `;
      continue;
    }
    if (code === 0x0022 || code === 0x005c) {
      escaped += `\\${value.charAt(index)}`;
      continue;
    }
    escaped += value.charAt(index);
  }
  return escaped;
}

function isDigit(code: number): boolean {
  return code >= 0x0030 && code <= 0x0039;
}

function isCssIdentChar(code: number): boolean {
  return (
    code >= 0x0080 ||
    code === 0x002d ||
    code === 0x005f ||
    isDigit(code) ||
    (code >= 0x0041 && code <= 0x005a) ||
    (code >= 0x0061 && code <= 0x007a)
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unsupportedLocator(locator: never): never {
  const type = (locator as { type?: unknown }).type;
  throw new QaError({
    code: "FLOW_VALIDATION_FAILED",
    message: `Unsupported locator type "${String(type)}".`,
  });
}

type Probe = {
  locator: FlowLocator;
  count: number;
  interactable: boolean;
};

type SurfaceDescription = {
  css?: string;
  testId?: string;
  role?: string;
  name?: string;
  text?: string;
};

/**
 * Checks interaction locators on `page` before they are compiled.
 * A hidden field is not kept when a visible control for the same widget
 * is on the page. `nth` is not used: row order is not a stable identity.
 * A locator that still matches multiple elements fails compilation.
 */
export async function resolveTrajectoryLocators(
  page: Page,
  trajectory: DiscoveryTrajectory,
): Promise<DiscoveryTrajectory> {
  const actions: DiscoveryAction[] = [];
  for (const action of trajectory.actions) {
    actions.push(await resolveActionLocator(page, action));
  }
  return { ...trajectory, actions };
}

/**
 * Checks locators on the page discovery actually drove.
 * The Playwright page Stagehand did not navigate stays on `about:blank`.
 * In that case the Stagehand browser is attached through its CDP websocket.
 */
export async function resolveDiscoveryLocators(
  localPage: Page,
  trajectory: DiscoveryTrajectory,
  connectUrl: string | undefined,
): Promise<DiscoveryTrajectory> {
  if (localPage.url() !== "about:blank") {
    return resolveTrajectoryLocators(localPage, trajectory);
  }
  if (connectUrl === undefined) {
    return unchecked(trajectory);
  }
  const connected = await chromium.connectOverCDP(connectUrl);
  try {
    const pages = connected.contexts().flatMap((context) => context.pages());
    const active = [...pages].reverse().find((page) => page.url() !== "about:blank");
    if (active === undefined) {
      return unchecked(trajectory);
    }
    return await resolveTrajectoryLocators(active, trajectory);
  } finally {
    await connected.close().catch(() => undefined);
  }
}

/**
 * A candidate that cannot be checked on a live page is not treated as valid.
 * `discoverFlow` would otherwise compile it and save the draft after replay fails.
 */
function unchecked(trajectory: DiscoveryTrajectory): DiscoveryTrajectory {
  for (const action of trajectory.actions) {
    if (!needsLocatorCheck(action) || locatorCandidates(action).length === 0) {
      continue;
    }
    throw missedLocator(action);
  }
  return trajectory;
}

async function resolveActionLocator(
  page: Page,
  action: DiscoveryAction,
): Promise<DiscoveryAction> {
  if (!needsLocatorCheck(action)) {
    return action;
  }
  const candidates = locatorCandidates(action);
  if (candidates.length === 0) {
    return action;
  }
  const probes: Probe[] = [];
  for (const candidate of candidates) {
    probes.push(await probeLocator(page, candidate));
  }
  if (probes.every((probe) => probe.count === 0)) {
    throw missedLocator(action);
  }

  const interactable = probes
    .filter((probe) => probe.count === 1 && probe.interactable)
    .map((probe) => probe.locator);
  if (interactable.length > 0) {
    return withResolved(action, rankCandidates(interactable));
  }

  const unique = probes
    .filter((probe) => probe.count === 1)
    .map((probe) => probe.locator);
  if (isPointerAction(action)) {
    for (const locator of orderByPreference(unique)) {
      if (!(await isFormField(page, locator))) {
        continue;
      }
      const surface = await visibleSurface(page, locator);
      if (surface !== undefined) {
        return withResolved(action, surface);
      }
    }
  }

  const bestUnique = orderByPreference(unique)[0];
  if (bestUnique !== undefined) {
    return withResolved(action, bestUnique);
  }

  const ambiguous = probes.filter((probe) => probe.count > 1);
  const sample = orderByPreference(ambiguous.map((probe) => probe.locator))[0];
  if (sample !== undefined) {
    throw ambiguousLocator(action, sample);
  }
  return action;
}

function missedLocator(action: DiscoveryAction): QaError {
  return new QaError({
    code: "FLOW_COMPILE_FAILED",
    message: `Action at index ${action.index}: locator candidates matched no elements.`,
  });
}

function isPointerAction(action: DiscoveryAction): boolean {
  const token = (action.method ?? action.kind).trim().toLowerCase();
  return (
    token === "click" ||
    token === "hover" ||
    token === "check" ||
    token === "uncheck"
  );
}

function ambiguousLocator(action: DiscoveryAction, locator: FlowLocator): QaError {
  return new QaError({
    code: "FLOW_COMPILE_FAILED",
    message: `Action at index ${action.index}: ${locatorLabel(locator)} matched multiple elements.`,
  });
}

function locatorLabel(locator: FlowLocator): string {
  switch (locator.type) {
    case "role":
      return `role locator "${locator.role}" "${locator.name}"`;
    case "label":
      return `label locator "${locator.name}"`;
    case "placeholder":
      return `placeholder locator "${locator.value}"`;
    case "text":
      return `text locator "${locator.text}"`;
    case "testid":
      return `testid locator "${locator.name}"`;
    case "attr":
      return `attribute locator "${locator.name}"="${locator.value}"`;
    case "css":
      return `css locator "${locator.selector}"`;
    case "xpath":
      return `xpath locator "${locator.selector}"`;
  }
}

function needsLocatorCheck(action: DiscoveryAction): boolean {
  const token = (action.method ?? action.kind).trim().toLowerCase();
  if (
    token === "goto" ||
    token === "reload" ||
    token === "wait" ||
    token === "waitfor"
  ) {
    return false;
  }
  const kind = action.kind.trim().toLowerCase();
  if (
    (token === "press" || token === "type" || kind === "keys") &&
    locatorCandidates(action).length === 0
  ) {
    return false;
  }
  return true;
}

async function probeLocator(page: Page, locator: FlowLocator): Promise<Probe> {
  try {
    const target = toLocator(page, locator);
    const count = await target.count();
    if (count !== 1) {
      return { locator, count, interactable: false };
    }
    const interactable = await target.evaluate(elementIsInteractable);
    return { locator, count, interactable };
  } catch {
    return { locator, count: 0, interactable: false };
  }
}

async function isFormField(page: Page, locator: FlowLocator): Promise<boolean> {
  try {
    return await toLocator(page, locator).evaluate(
      (element) =>
        element.tagName === "INPUT" ||
        element.tagName === "TEXTAREA" ||
        element.tagName === "SELECT",
    );
  } catch {
    return false;
  }
}

async function visibleSurface(
  page: Page,
  locator: FlowLocator,
): Promise<FlowLocator | undefined> {
  let described: SurfaceDescription | null;
  try {
    described = await toLocator(page, locator).evaluate(describeVisibleSurface);
  } catch {
    return undefined;
  }
  if (described === null) {
    return undefined;
  }
  const viable: FlowLocator[] = [];
  for (const candidate of locatorsFromSurface(described)) {
    const probed = await probeLocator(page, candidate);
    if (probed.count === 1 && probed.interactable) {
      viable.push(candidate);
    }
  }
  if (viable.length === 0) {
    return undefined;
  }
  return rankCandidates(viable);
}

function locatorsFromSurface(surface: SurfaceDescription): FlowLocator[] {
  const locators: FlowLocator[] = [];
  if (surface.role !== undefined && surface.name !== undefined) {
    locators.push({ type: "role", role: surface.role, name: surface.name });
  }
  if (surface.testId !== undefined) {
    locators.push({ type: "testid", name: surface.testId });
  }
  if (surface.text !== undefined) {
    locators.push({ type: "text", text: surface.text });
  }
  if (surface.css !== undefined) {
    locators.push({ type: "css", selector: surface.css });
  }
  return locators;
}

function orderByPreference(locators: readonly FlowLocator[]): FlowLocator[] {
  const remaining = [...locators];
  const ordered: FlowLocator[] = [];
  while (remaining.length > 0) {
    let next: FlowLocator;
    try {
      next = rankCandidates(remaining);
    } catch {
      break;
    }
    ordered.push(next);
    const index = remaining.indexOf(next);
    if (index < 0) {
      break;
    }
    remaining.splice(index, 1);
  }
  return ordered;
}

function withResolved(
  action: DiscoveryAction,
  locator: FlowLocator,
): DiscoveryAction {
  return { ...action, resolvedLocator: locator };
}

function elementIsInteractable(element: Element): boolean {
  const style = window.getComputedStyle(element);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.pointerEvents === "none" ||
    Number(style.opacity) === 0
  ) {
    return false;
  }
  if (
    element.getAttribute("aria-hidden") === "true" ||
    element.hasAttribute("hidden")
  ) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) {
    return false;
  }
  const view = element.ownerDocument.defaultView;
  if (view === null) {
    return false;
  }
  if (
    rect.bottom <= 0 ||
    rect.right <= 0 ||
    rect.top >= view.innerHeight ||
    rect.left >= view.innerWidth
  ) {
    return false;
  }
  if (
    (element instanceof HTMLInputElement ||
      element instanceof HTMLButtonElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement) &&
    element.disabled
  ) {
    return false;
  }
  return true;
}

/**
 * Runs in the page. Helpers are nested so Playwright can send this function
 * without the module's other functions.
 */
function describeVisibleSurface(element: Element): SurfaceDescription | null {
  const tag = element.tagName;
  if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") {
    return null;
  }
  const container = element.closest(".ui-select-container");
  const root =
    container !== null && container !== element
      ? container
      : element.parentElement;
  if (root === null) {
    return null;
  }
  const selectors = [
    ".ui-select-placeholder",
    ".ui-select-toggle",
    ".ui-select-match",
    "[role='combobox']",
    "[role='button']",
  ];
  for (const selector of selectors) {
    for (const node of root.querySelectorAll(selector)) {
      if (node === element) {
        continue;
      }
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      const view = node.ownerDocument.defaultView;
      const shown =
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.pointerEvents !== "none" &&
        Number(style.opacity) !== 0 &&
        node.getAttribute("aria-hidden") !== "true" &&
        !node.hasAttribute("hidden") &&
        rect.width >= 2 &&
        rect.height >= 2 &&
        view !== null &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < view.innerHeight &&
        rect.left < view.innerWidth;
      if (!shown) {
        continue;
      }
      const described: SurfaceDescription = {};
      if (node.id.length > 0) {
        described.css = `#${CSS.escape(node.id)}`;
      } else if (root.id.length > 0) {
        const classes = [...node.classList];
        const classSelector =
          classes.length > 0
            ? `${node.tagName.toLowerCase()}.${classes.map((name) => CSS.escape(name)).join(".")}`
            : node.tagName.toLowerCase();
        described.css = `#${CSS.escape(root.id)} ${classSelector}`;
      }
      const testId = node.getAttribute("data-testid")?.trim() ?? "";
      if (testId.length > 0) {
        described.testId = testId;
      }
      const role = node.getAttribute("role")?.trim() ?? "";
      const label = node.getAttribute("aria-label")?.trim() ?? "";
      if (role.length > 0 && label.length > 0) {
        described.role = role;
        described.name = label;
      }
      const text = node.textContent?.trim() ?? "";
      if (text.length > 0 && text.length <= 80) {
        described.text = text;
      }
      return described;
    }
  }
  return null;
}
