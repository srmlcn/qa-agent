import type { Page } from "playwright";
import { expect, test } from "vitest";
import { toLocator } from "../../../src/playwright/locators.js";

test("escapes backslash, quotes, and CSS string controls", () => {
  expect(attributeSelector("data-note", "a\\b")).toBe('[data-note="a\\\\b"]');
  expect(attributeSelector("data-note", 'say "hi"')).toBe(
    '[data-note="say \\"hi\\""]',
  );
  expect(attributeSelector("data-note", "a\nb")).toBe('[data-note="a\\a b"]');
  expect(attributeSelector("data-note", "a\rb")).toBe('[data-note="a\\d b"]');
  expect(attributeSelector("data-note", "a\fb")).toBe('[data-note="a\\c b"]');
  expect(attributeSelector("data-note", "a\0b")).toBe(
    '[data-note="a\uFFFDb"]',
  );
  expect(attributeSelector("data-note", "\n0")).toBe('[data-note="\\a 0"]');
});

test("keeps a hostile attribute value inside one CSS string", () => {
  const value = 'say "hi"\\\n\r\f\0tail';
  const selector = attributeSelector("data-note", value);

  expect(selector).toBe('[data-note="say \\"hi\\"\\\\\\a \\d \\c \uFFFDtail"]');
  expect(selector).not.toContain("\n");
  expect(selector).not.toContain("\r");
  expect(selector).not.toContain("\f");
  expect(selector).not.toContain("\0");
  expect(readCssString(selector)).toBe(value.replaceAll("\0", "\uFFFD"));
});

function attributeSelector(name: string, value: string): string {
  let selector = "";
  const page = {
    locator(next: string) {
      selector = next;
      return undefined;
    },
  } as unknown as Page;
  toLocator(page, { type: "attr", name, value });
  return selector;
}

/** Reads the single double-quoted string in an attribute selector. */
function readCssString(selector: string): string {
  const open = selector.indexOf('="');
  if (!selector.startsWith("[") || open < 0 || !selector.endsWith("]")) {
    throw new Error(`not an attribute selector: ${JSON.stringify(selector)}`);
  }

  let index = open + 2;
  let value = "";
  while (index < selector.length) {
    const current = selector.charAt(index);
    if (current === '"') {
      if (selector.slice(index) !== '"]') {
        throw new Error(
          `selector continues after the string: ${JSON.stringify(selector)}`,
        );
      }
      return value;
    }
    if (current === "\\") {
      const next = selector.charAt(index + 1);
      if (/^[0-9a-fA-F]$/.test(next)) {
        let hex = "";
        let cursor = index + 1;
        while (
          hex.length < 6 &&
          cursor < selector.length &&
          /^[0-9a-fA-F]$/.test(selector.charAt(cursor))
        ) {
          hex += selector.charAt(cursor);
          cursor += 1;
        }
        if (selector.charAt(cursor) === " ") {
          cursor += 1;
        }
        const code = Number.parseInt(hex, 16);
        value += code === 0 ? "\uFFFD" : String.fromCodePoint(code);
        index = cursor;
        continue;
      }
      value += next;
      index += 2;
      continue;
    }
    value += current;
    index += 1;
  }
  throw new Error(`unterminated CSS string: ${JSON.stringify(selector)}`);
}
