import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { QaError } from "../../../src/errors/qa-error.js";
import { interpolateFlow } from "../../../src/flows/interpolate.js";
import {
  parseFlowSpec,
  type Assertion,
  type FlowSpec,
} from "../../../src/flows/schema.js";
import { runAssertion } from "../../../src/playwright/assertions.js";
import {
  startBrowser,
  type BrowserSession,
} from "../../../src/playwright/runtime.js";

const LAUNCH_TIMEOUT_MS = 30_000;
const ASSERT_TIMEOUT_MS = 5_000;
const FAIL_TIMEOUT_MS = 1_000;
const PROJECT_NAME = "Northwind";

const fixturePath = new URL(
  "../../unit/flows/fixtures/archive-project.yml",
  import.meta.url,
);

let session: BrowserSession;

beforeAll(async () => {
  session = await startBrowser({
    headless: true,
    timeoutMs: LAUNCH_TIMEOUT_MS,
  });
});

afterEach(async () => {
  await session.page.unrouteAll({ behavior: "ignoreErrors" });
});

afterAll(async () => {
  await session?.close();
});

test("the archive not-visible assertion passes when the project name is absent", async () => {
  await show(`<!DOCTYPE html><html><body><h1>Archived</h1></body></html>`);

  await runAssertion(
    session.page,
    archiveAssertion("not-visible"),
    ASSERT_TIMEOUT_MS,
  );
});

test("the archive not-visible assertion fails when the project name is present", async () => {
  await show(
    `<!DOCTYPE html><html><body><p>${PROJECT_NAME}</p></body></html>`,
  );

  const pending = runAssertion(
    session.page,
    archiveAssertion("not-visible"),
    FAIL_TIMEOUT_MS,
  );

  await expect(pending).rejects.toBeInstanceOf(QaError);
  await expect(pending).rejects.toMatchObject({
    code: "ASSERTION_FAILED",
    recoveryAppropriate: false,
    stepId: "project-not-active",
  });
});

test("not-visible passes when the matching element is hidden", async () => {
  await show(
    `<!DOCTYPE html><html><body><p hidden>${PROJECT_NAME}</p></body></html>`,
  );

  await runAssertion(
    session.page,
    archiveAssertion("not-visible"),
    ASSERT_TIMEOUT_MS,
  );
});

test("a sequence reloads and then asserts the project name is not visible", async () => {
  await fulfillArchiveHost(
    `<!DOCTYPE html><html><body><h1>Archived</h1></body></html>`,
  );
  await session.page.goto("http://assertions.test/project", {
    waitUntil: "domcontentloaded",
  });
  await session.page.evaluate((name) => {
    const paragraph = document.createElement("p");
    paragraph.textContent = name;
    document.body.appendChild(paragraph);
  }, PROJECT_NAME);
  expect(
    await session.page.getByText(PROJECT_NAME, { exact: true }).isVisible(),
  ).toBe(true);

  await runAssertion(
    session.page,
    archiveAssertion("sequence"),
    ASSERT_TIMEOUT_MS,
  );

  expect(
    await session.page.getByText(PROJECT_NAME, { exact: true }).count(),
  ).toBe(0);
});

test("a sequence runs the nested action before the nested assertion", async () => {
  await show(`<!DOCTYPE html><html><body>
    <button type="button" id="archive">Archive</button>
    <p id="status" data-testid="status"></p>
  </body></html>`);
  await session.page.evaluate(() => {
    document.querySelector("#archive")?.addEventListener("click", () => {
      const status = document.querySelector("#status");
      if (status) {
        status.textContent = "Archived";
      }
    });
  });

  const assertion = {
    id: "click-then-text",
    type: "sequence",
    sequence: [
      {
        id: "archive",
        action: "click",
        locator: { type: "role", role: "button", name: "Archive" },
      },
      {
        id: "status",
        type: "text",
        locator: { type: "testid", name: "status" },
        text: "Archived",
      },
    ],
  } as Assertion;

  await runAssertion(session.page, assertion, ASSERT_TIMEOUT_MS);
  expect(await session.page.locator("#status").textContent()).toBe("Archived");
});

test("a failed expectation and a locator miss are distinguishable", async () => {
  await show(`<!DOCTYPE html><html><body><p hidden>Ready</p></body></html>`);
  const hidden = runAssertion(
    session.page,
    {
      id: "status-visible",
      type: "visible",
      locator: { type: "text", text: "Ready" },
    },
    FAIL_TIMEOUT_MS,
  );
  await expect(hidden).rejects.toBeInstanceOf(QaError);
  await expect(hidden).rejects.toMatchObject({
    code: "ASSERTION_FAILED",
    recoveryAppropriate: false,
    stepId: "status-visible",
  });

  await show(`<!DOCTYPE html><html><body><p>Other</p></body></html>`);
  const missing = runAssertion(
    session.page,
    {
      id: "status-visible",
      type: "visible",
      locator: { type: "text", text: "Ready" },
    },
    FAIL_TIMEOUT_MS,
  );
  await expect(missing).rejects.toBeInstanceOf(QaError);
  await expect(missing).rejects.toMatchObject({
    code: "LOCATOR_STALE",
    recoveryAppropriate: true,
    stepId: "status-visible",
  });
});

test("visible passes when the locator is visible", async () => {
  await show(
    `<!DOCTYPE html><html><body><button type="button">Archive project</button></body></html>`,
  );

  await runAssertion(
    session.page,
    {
      id: "archive-visible",
      type: "visible",
      locator: { type: "role", role: "button", name: "Archive project" },
    },
    ASSERT_TIMEOUT_MS,
  );
});

test("text passes only when the locator text equals the assertion text", async () => {
  await show(`<!DOCTYPE html><html><body><p id="status">Archived</p></body></html>`);

  await runAssertion(
    session.page,
    {
      id: "status-text",
      type: "text",
      locator: { type: "css", selector: "#status" },
      text: "Archived",
    },
    ASSERT_TIMEOUT_MS,
  );

  const mismatch = runAssertion(
    session.page,
    {
      id: "status-text",
      type: "text",
      locator: { type: "css", selector: "#status" },
      text: "Archive",
    },
    FAIL_TIMEOUT_MS,
  );
  await expect(mismatch).rejects.toMatchObject({
    code: "ASSERTION_FAILED",
    recoveryAppropriate: false,
    stepId: "status-text",
  });
});

test("a text assertion on a missing locator is LOCATOR_STALE", async () => {
  await show(`<!DOCTYPE html><html><body><p>Other</p></body></html>`);

  const pending = runAssertion(
    session.page,
    {
      id: "missing-text",
      type: "text",
      locator: { type: "css", selector: "#status" },
      text: "Archived",
    },
    FAIL_TIMEOUT_MS,
  );

  await expect(pending).rejects.toMatchObject({
    code: "LOCATOR_STALE",
    recoveryAppropriate: true,
    stepId: "missing-text",
  });
});

test("an ambiguous locator is LOCATOR_STALE", async () => {
  await show(
    `<!DOCTYPE html><html><body><p>Alpha</p><p>Alpha</p></body></html>`,
  );

  const pending = runAssertion(
    session.page,
    {
      id: "ambiguous",
      type: "visible",
      locator: { type: "text", text: "Alpha" },
    },
    FAIL_TIMEOUT_MS,
  );

  await expect(pending).rejects.toMatchObject({
    code: "LOCATOR_STALE",
    recoveryAppropriate: true,
    stepId: "ambiguous",
  });

  const hidden = runAssertion(
    session.page,
    {
      id: "ambiguous-hidden",
      type: "not-visible",
      locator: { type: "text", text: "Alpha" },
    },
    FAIL_TIMEOUT_MS,
  );
  await expect(hidden).rejects.toMatchObject({
    code: "LOCATOR_STALE",
    recoveryAppropriate: true,
    stepId: "ambiguous-hidden",
  });
});

test("url equals page.url() and a star matches one segment", async () => {
  await fulfillArchiveHost(`<!DOCTYPE html><html><body><p>ok</p></body></html>`);
  await session.page.goto(
    "http://assertions.test/projects/northwind/settings",
    { waitUntil: "domcontentloaded" },
  );
  expect(session.page.url()).toBe(
    "http://assertions.test/projects/northwind/settings",
  );

  await runAssertion(
    session.page,
    {
      id: "exact-url",
      type: "url",
      url: "http://assertions.test/projects/northwind/settings",
    },
    ASSERT_TIMEOUT_MS,
  );
  await runAssertion(
    session.page,
    {
      id: "wild-url",
      type: "url",
      url: "http://assertions.test/projects/*/settings",
    },
    ASSERT_TIMEOUT_MS,
  );

  await session.page.goto("http://assertions.test/projects/a/b/settings", {
    waitUntil: "domcontentloaded",
  });
  const pending = runAssertion(
    session.page,
    {
      id: "wild-url",
      type: "url",
      url: "http://assertions.test/projects/*/settings",
    },
    FAIL_TIMEOUT_MS,
  );
  await expect(pending).rejects.toMatchObject({
    code: "ASSERTION_FAILED",
    recoveryAppropriate: false,
    stepId: "wild-url",
  });
});

test("a url mismatch is ASSERTION_FAILED", async () => {
  await show(`<!DOCTYPE html><html><body><p>ok</p></body></html>`);

  const pending = runAssertion(
    session.page,
    {
      id: "url-mismatch",
      type: "url",
      url: "http://assertions.test/missing",
    },
    FAIL_TIMEOUT_MS,
  );

  await expect(pending).rejects.toMatchObject({
    code: "ASSERTION_FAILED",
    recoveryAppropriate: false,
    stepId: "url-mismatch",
  });
});

test("a nested sequence is rejected", async () => {
  const assertion = {
    id: "outer",
    type: "sequence",
    sequence: [
      {
        id: "inner",
        type: "sequence",
        sequence: [{ action: "reload" }],
      },
    ],
  } as unknown as Assertion;

  const pending = runAssertion(session.page, assertion, ASSERT_TIMEOUT_MS);

  await expect(pending).rejects.toBeInstanceOf(QaError);
  await expect(pending).rejects.toMatchObject({
    code: "FLOW_VALIDATION_FAILED",
    recoveryAppropriate: false,
    stepId: "inner",
  });
});

test("the assertion module has no LLM import and does not read semanticFallback", () => {
  const sourcePath = fileURLToPath(
    new URL("../../../src/playwright/assertions.ts", import.meta.url),
  );
  const source = readFileSync(sourcePath, "utf8");

  expect(source).not.toContain("semanticFallback");
  expect(source).not.toContain("@browserbasehq/stagehand");
  expect(source.toLowerCase()).not.toContain("stagehand");
  expect(source.toLowerCase()).not.toContain("openai");
  expect(source.toLowerCase()).not.toContain("llm");
  expect(importSpecifiers(source).sort()).toEqual([
    "../errors/qa-error.js",
    "../flows/schema.js",
    "../security/redaction.js",
    "./actions.js",
    "./errors.js",
    "./locators.js",
    "playwright",
    "playwright/test",
  ]);
});

function archiveFlow(): FlowSpec {
  return interpolateFlow(parseFlowSpec(parse(readFileSync(fixturePath, "utf8"))), {
    projectName: PROJECT_NAME,
  });
}

function archiveAssertion(type: "not-visible" | "sequence"): Assertion {
  const assertion = archiveFlow().assertions.find((item) => item.type === type);
  if (assertion === undefined) {
    throw new Error(`Archive sample is missing a ${type} assertion`);
  }
  return assertion;
}

async function show(html: string): Promise<void> {
  await session.page.setContent(html);
}

async function fulfillArchiveHost(html: string): Promise<void> {
  await session.page.route(
    (url) => url.hostname === "assertions.test",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: html,
      });
    },
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
