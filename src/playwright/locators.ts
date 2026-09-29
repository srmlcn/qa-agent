import type { Locator, Page } from "playwright";
import { QaError } from "../errors/qa-error.js";
import type { Locator as FlowLocator } from "../flows/schema.js";

type AriaRole = Parameters<Page["getByRole"]>[0];

/**
 * Turns a stored FlowSpec locator into a Playwright locator.
 * The flow already chose the locator. This module does not rank candidates.
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
