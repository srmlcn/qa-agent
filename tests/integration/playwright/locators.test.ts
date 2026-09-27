import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Locator } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { QaError } from "../../../src/errors/qa-error.js";
import type { Locator as FlowLocator } from "../../../src/flows/schema.js";
import { toLocator } from "../../../src/playwright/locators.js";
import {
  startBrowser,
  type BrowserSession,
} from "../../../src/playwright/runtime.js";

const LAUNCH_TIMEOUT_MS = 30_000;

const quotedAttributeName = 'data-x"],button,[data-y';

const pageHtml = `<!DOCTYPE html>
<html>
  <body>
    <button type="button" id="archive" data-testid="archive-project">Archive project</button>
    <button type="button" id="archive-projects">Archive projects</button>
    <button type="button" id="save">Save draft</button>
    <button type="button" id="paren">Archive (project)</button>
    <button type="button" id="regex-decoy">Archive Xproject)</button>
    <label>
      Project name
      <input id="project-name" />
    </label>
    <input id="search" placeholder="Find a project" />
    <p id="status">Archived</p>
    <p id="status-note">Archived yesterday</p>
    <span id="star-text">A*B</span>
    <span id="axb">AXB</span>
    <button type="button" id="quoted" data-label="say &quot;hi&quot;">Quoted</button>
    <button type="button" id="say" data-label="say">Say</button>
    <button type="button" id="hi" data-label="hi">Hi</button>
    <button type="button" id="breakout" data-label='hello"], [id="decoy'>Breakout</button>
    <button type="button" id="decoy">Decoy</button>
    <button type="button" id="hello" data-label="hello">Hello</button>
    <span id="css-target" class="panel">Panel</span>
    <span id="xpath-target">XPath target</span>
  </body>
</html>`;

let session: BrowserSession;

beforeAll(async () => {
  session = await startBrowser({
    headless: true,
    timeoutMs: LAUNCH_TIMEOUT_MS,
  });
  await session.page.setContent(pageHtml);
  await session.page.evaluate((name) => {
    const element = document.createElement("button");
    element.id = "weird-name";
    element.textContent = "Weird";
    element.setAttribute(name, "1");
    document.body.appendChild(element);
  }, quotedAttributeName);
});

afterAll(async () => {
  await session?.close();
});

test("finds Archive project by role and by test id", async () => {
  const byRole = toLocator(session.page, {
    type: "role",
    role: "button",
    name: "Archive project",
  });
  const byTestId = toLocator(session.page, {
    type: "testid",
    name: "archive-project",
  });

  expect(await matchedIds(byRole)).toEqual(["archive"]);
  expect(await matchedIds(byTestId)).toEqual(["archive"]);
  expect(await sameElement(byRole, byTestId)).toBe(true);
});

test("matches a role name exactly unless it contains a wildcard", async () => {
  expect(
    await matchedIds(
      toLocator(session.page, {
        type: "role",
        role: "button",
        name: "Archive project",
      }),
    ),
  ).toEqual(["archive"]);

  expect(
    await matchedIds(
      toLocator(session.page, {
        type: "role",
        role: "button",
        name: "archive project",
      }),
    ),
  ).toEqual([]);

  expect(
    await matchedIds(
      toLocator(session.page, {
        type: "role",
        role: "button",
        name: "Archive",
      }),
    ),
  ).toEqual([]);

  expect(
    await matchedIds(
      toLocator(session.page, {
        type: "role",
        role: "button",
        name: "save*",
      }),
    ),
  ).toEqual(["save"]);

  expect(
    await matchedIds(
      toLocator(session.page, {
        type: "role",
        role: "button",
        name: "S*aft",
      }),
    ),
  ).toEqual(["save"]);
});

test("does not treat a role name as a regular expression", async () => {
  expect(
    await matchedIds(
      toLocator(session.page, {
        type: "role",
        role: "button",
        name: "Archive (project)",
      }),
    ),
  ).toEqual(["paren"]);
});

test("resolves label, placeholder, and exact text", async () => {
  expect(
    await matchedIds(
      toLocator(session.page, { type: "label", name: "Project name" }),
    ),
  ).toEqual(["project-name"]);

  expect(
    await matchedIds(
      toLocator(session.page, {
        type: "placeholder",
        value: "Find a project",
      }),
    ),
  ).toEqual(["search"]);

  expect(
    await matchedIds(
      toLocator(session.page, { type: "text", text: "Archived" }),
    ),
  ).toEqual(["status"]);

  expect(
    await matchedIds(toLocator(session.page, { type: "text", text: "A*B" })),
  ).toEqual(["star-text"]);
});

test("escapes attribute quotes so the selector stays exact", async () => {
  expect(
    await matchedIds(
      toLocator(session.page, {
        type: "attr",
        name: "data-label",
        value: 'say "hi"',
      }),
    ),
  ).toEqual(["quoted"]);

  expect(
    await matchedIds(
      toLocator(session.page, {
        type: "attr",
        name: "data-label",
        value: 'hello"], [id="decoy',
      }),
    ),
  ).toEqual(["breakout"]);

  expect(
    await matchedIds(
      toLocator(session.page, {
        type: "attr",
        name: quotedAttributeName,
        value: "1",
      }),
    ),
  ).toEqual(["weird-name"]);
});

test("resolves css and xpath selectors", async () => {
  expect(
    await matchedIds(
      toLocator(session.page, { type: "css", selector: "span.panel" }),
    ),
  ).toEqual(["css-target"]);

  expect(
    await matchedIds(
      toLocator(session.page, {
        type: "xpath",
        selector: '//*[@id="xpath-target"]',
      }),
    ),
  ).toEqual(["xpath-target"]);
});

test("rejects an unsupported locator type", () => {
  const unsupported = { type: "class", name: "button" } as FlowLocator;
  expect(() => toLocator(session.page, unsupported)).toThrow(QaError);
  expect(() => toLocator(session.page, unsupported)).toThrow(
    /Unsupported locator type "class"/,
  );
  try {
    toLocator(session.page, unsupported);
  } catch (error) {
    expect(error).toMatchObject({
      code: "FLOW_VALIDATION_FAILED",
      recoveryAppropriate: false,
    });
  }
});

test("does not import an LLM or Stagehand", () => {
  const sourcePath = fileURLToPath(
    new URL("../../../src/playwright/locators.ts", import.meta.url),
  );
  const source = readFileSync(sourcePath, "utf8");
  expect(source).not.toContain("import(");
  expect(source.toLowerCase()).not.toContain("stagehand");
  expect(importSpecifiers(source).sort()).toEqual([
    "../errors/qa-error.js",
    "../flows/schema.js",
    "playwright",
  ]);
});

async function matchedIds(locator: Locator): Promise<string[]> {
  const ids = await locator.evaluateAll((elements) =>
    elements.map((element) => element.id),
  );
  return ids.sort();
}

async function sameElement(left: Locator, right: Locator): Promise<boolean> {
  const [leftElement, rightElement] = await Promise.all([
    left.elementHandle(),
    right.elementHandle(),
  ]);
  if (leftElement === null || rightElement === null) {
    return false;
  }
  return leftElement.evaluate(
    (element, other) => element === other,
    rightElement,
  );
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const fromPattern = /\bfrom\s+["']([^"']+)["']/g;
  const sideEffectPattern = /\bimport\s+["']([^"']+)["']/g;
  for (const pattern of [fromPattern, sideEffectPattern]) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) {
        specifiers.push(specifier);
      }
    }
  }
  return specifiers;
}
