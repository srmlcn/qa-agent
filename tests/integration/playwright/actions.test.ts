import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { QaError } from "../../../src/errors/qa-error.js";
import type { Step } from "../../../src/flows/schema.js";
import { runAction } from "../../../src/playwright/actions.js";
import {
  startBrowser,
  type BrowserSession,
} from "../../../src/playwright/runtime.js";

const LAUNCH_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 5_000;

const formHtml = `<!DOCTYPE html>
<html>
  <body>
    <button type="button" id="save">Save</button>
    <button type="button" id="secret">Find and open the secret menu</button>
    <label>
      Name
      <input id="name" />
    </label>
    <label>
      Note
      <input id="note" />
    </label>
    <label>
      Color
      <select id="color">
        <option value="red">Red</option>
        <option value="blue">Blue</option>
      </select>
    </label>
    <label>
      Agree
      <input id="agree" type="checkbox" />
    </label>
    <label>
      Notify
      <input id="notify" type="checkbox" checked />
    </label>
    <p id="later" hidden>Ready</p>
  </body>
</html>`;

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

test("goto waits for domcontentloaded on inline HTML", async () => {
  let releaseHang: (() => void) | undefined;
  const released = new Promise<void>((resolve) => {
    releaseHang = resolve;
  });

  await session.page.route(
    (url) => url.hostname === "actions.test",
    async (route) => {
      if (route.request().url().endsWith("/hang.png")) {
        await released;
        await route.abort().catch(() => undefined);
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<!DOCTYPE html><html><body><p id="marker">ready</p><img src="/hang.png"></body></html>`,
      });
    },
  );

  try {
    const started = Date.now();
    await runAction(
      session.page,
      {
        id: "open-page",
        intent: "Open the page",
        action: "goto",
        value: "http://actions.test/app",
      },
      ACTION_TIMEOUT_MS,
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(session.page.url()).toBe("http://actions.test/app");
    expect(await session.page.locator("#marker").textContent()).toBe("ready");
    expect(await session.page.evaluate(() => document.readyState)).toBe(
      "interactive",
    );
  } finally {
    releaseHang?.();
  }
});

test("reload restores the inline page", async () => {
  await session.page.route(
    (url) => url.hostname === "actions.test",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<!DOCTYPE html><html><body><p id="marker">original</p></body></html>`,
      });
    },
  );

  await session.page.goto("http://actions.test/reload", {
    waitUntil: "domcontentloaded",
  });
  await session.page.evaluate(() => {
    const marker = document.querySelector("#marker");
    if (marker) {
      marker.textContent = "changed";
    }
  });

  await runAction(
    session.page,
    {
      id: "reload-page",
      intent: "Reload the page",
      action: "reload",
    },
    ACTION_TIMEOUT_MS,
  );

  expect(await session.page.locator("#marker").textContent()).toBe("original");
});

test("click activates the located button", async () => {
  await showForm();
  await runAction(
    session.page,
    {
      id: "click-save",
      intent: "Save the form",
      action: "click",
      locator: { type: "role", role: "button", name: "Save" },
    },
    ACTION_TIMEOUT_MS,
  );
  expect(await clickedId()).toBe("save");
});

test("fill writes the step value into the located field", async () => {
  await showForm();
  await runAction(
    session.page,
    {
      id: "fill-name",
      intent: "Enter the name",
      action: "fill",
      locator: { type: "label", name: "Name" },
      value: "Ada",
    },
    ACTION_TIMEOUT_MS,
  );
  expect(await session.page.locator("#name").inputValue()).toBe("Ada");
});

test("press sends the step value to the located field", async () => {
  await showForm();
  await runAction(
    session.page,
    {
      id: "press-note",
      intent: "Type into the note",
      action: "press",
      locator: { type: "label", name: "Note" },
      value: "a",
    },
    ACTION_TIMEOUT_MS,
  );
  expect(await session.page.locator("#note").inputValue()).toBe("a");
});

test("select chooses the step value on the located control", async () => {
  await showForm();
  await runAction(
    session.page,
    {
      id: "select-color",
      intent: "Choose a color",
      action: "select",
      locator: { type: "label", name: "Color" },
      value: "blue",
    },
    ACTION_TIMEOUT_MS,
  );
  expect(await session.page.locator("#color").inputValue()).toBe("blue");
});

test("check sets the located checkbox", async () => {
  await showForm();
  await runAction(
    session.page,
    {
      id: "check-agree",
      intent: "Agree to the terms",
      action: "check",
      locator: { type: "role", role: "checkbox", name: "Agree" },
    },
    ACTION_TIMEOUT_MS,
  );
  expect(await session.page.locator("#agree").isChecked()).toBe(true);
});

test("uncheck clears the located checkbox", async () => {
  await showForm();
  await runAction(
    session.page,
    {
      id: "uncheck-notify",
      intent: "Turn off notifications",
      action: "uncheck",
      locator: { type: "role", role: "checkbox", name: "Notify" },
    },
    ACTION_TIMEOUT_MS,
  );
  expect(await session.page.locator("#notify").isChecked()).toBe(false);
});

test("waitFor waits until the located element is visible", async () => {
  await showForm();
  await session.page.evaluate(() => {
    setTimeout(() => {
      document.querySelector("#later")?.removeAttribute("hidden");
    }, 300);
  });

  const started = Date.now();
  await runAction(
    session.page,
    {
      id: "wait-ready",
      intent: "Wait until the status is visible",
      action: "waitFor",
      locator: { type: "text", text: "Ready" },
    },
    ACTION_TIMEOUT_MS,
  );

  expect(Date.now() - started).toBeGreaterThanOrEqual(200);
  expect(await session.page.locator("#later").isVisible()).toBe(true);
});

test("waitFor sleeps for an integer millisecond value when no locator is set", async () => {
  await showForm();
  const started = Date.now();
  await runAction(
    session.page,
    {
      id: "wait-briefly",
      intent: "Pause briefly",
      action: "waitFor",
      value: "300",
    },
    ACTION_TIMEOUT_MS,
  );
  const elapsed = Date.now() - started;
  expect(elapsed).toBeGreaterThanOrEqual(250);
  expect(elapsed).toBeLessThan(ACTION_TIMEOUT_MS);
});

test("a missing button becomes LOCATOR_STALE with the step id", async () => {
  await showForm();
  const pending = runAction(
    session.page,
    {
      id: "missing-save",
      intent: "Click a button that is not on the page",
      action: "click",
      locator: { type: "role", role: "button", name: "Missing" },
    },
    1_000,
  );

  await expect(pending).rejects.toBeInstanceOf(QaError);
  await expect(pending).rejects.toMatchObject({
    code: "LOCATOR_STALE",
    stepId: "missing-save",
  });
});

test("waitFor above 10 seconds is POLICY_BLOCKED and does not sleep", async () => {
  await showForm();
  const started = Date.now();
  const pending = runAction(
    session.page,
    {
      id: "wait-too-long",
      intent: "Pause longer than the cap",
      action: "waitFor",
      value: "10001",
    },
    ACTION_TIMEOUT_MS,
  );

  await expect(pending).rejects.toBeInstanceOf(QaError);
  await expect(pending).rejects.toMatchObject({
    code: "POLICY_BLOCKED",
    stepId: "wait-too-long",
  });
  expect(Date.now() - started).toBeLessThan(1_000);
});

test("a fallback string is ignored and the locator is used", async () => {
  await showForm();
  const step: Step = {
    id: "click-save-with-fallback",
    intent: "Save the form",
    action: "click",
    locator: { type: "role", role: "button", name: "Save" },
    semanticFallback: "Find and open the secret menu",
  };

  await runAction(session.page, step, ACTION_TIMEOUT_MS);
  expect(await clickedId()).toBe("save");
});

test("the action module has no fallback reader and no network client", () => {
  const sourcePath = fileURLToPath(
    new URL("../../../src/playwright/actions.ts", import.meta.url),
  );
  const source = readFileSync(sourcePath, "utf8");

  expect(source).not.toContain("semanticFallback");
  expect(source).not.toContain("fetch");
  expect(source).not.toContain("http");
  expect(source.toLowerCase()).not.toContain("stagehand");
  expect(importSpecifiers(source).sort()).toEqual([
    "../errors/qa-error.js",
    "../flows/schema.js",
    "./errors.js",
    "./locators.js",
    "playwright",
  ]);
});

async function showForm(): Promise<void> {
  await session.page.setContent(formHtml);
  await session.page.evaluate(() => {
    for (const button of document.querySelectorAll("button")) {
      button.addEventListener("click", () => {
        document.body.dataset.clicked = button.id;
      });
    }
  });
}

async function clickedId(): Promise<string | undefined> {
  return session.page.evaluate(() => document.body.dataset.clicked);
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
