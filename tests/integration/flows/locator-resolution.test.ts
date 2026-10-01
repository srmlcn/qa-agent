import { afterAll, beforeAll, expect, test } from "vitest";
import { QaError } from "../../../src/errors/qa-error.js";
import { compile } from "../../../src/flows/compiler.js";
import type { DiscoveryAction } from "../../../src/stagehand/trajectory.js";
import { runAction } from "../../../src/playwright/actions.js";
import { resolveTrajectoryLocators, toLocator } from "../../../src/playwright/locators.js";
import {
  startBrowser,
  type BrowserSession,
} from "../../../src/playwright/runtime.js";

const LAUNCH_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 2_000;

const hiddenSelectHtml = `<!DOCTYPE html>
<html>
  <body>
    <div id="agent-type" class="ui-select-container">
      <span id="visible-placeholder" class="ui-select-placeholder">Select an action</span>
      <input id="focusser" class="ui-select-focusser" placeholder="Select an action"
        style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0" />
    </div>
  </body>
</html>`;

let session: BrowserSession;

beforeAll(async () => {
  session = await startBrowser({
    headless: true,
    timeoutMs: LAUNCH_TIMEOUT_MS,
  });
});

afterAll(async () => {
  await session?.close();
});

test("a hidden placeholder does not beat the visible ui-select control", async () => {
  await show(hiddenSelectHtml);
  const resolved = await resolveTrajectoryLocators(session.page, trajectory([
    clickAction({
      selector: "#visible-placeholder",
      arguments: { placeholder: "Select an action" },
    }),
  ]));
  const flow = compile(resolved, compileOptions);
  const step = flow.steps[0];
  expect(step?.action).toBe("click");
  if (step?.action !== "click") {
    throw new Error("expected a click");
  }

  expect(await elementId(step.locator)).toBe("visible-placeholder");
  const started = Date.now();
  await runAction(session.page, step, ACTION_TIMEOUT_MS);
  expect(Date.now() - started).toBeLessThan(1_500);
  expect(await clickedId()).toBe("visible-placeholder");
});

test("a hidden ui-select focusser is retargeted to the visible placeholder", async () => {
  await show(hiddenSelectHtml);
  const resolved = await resolveTrajectoryLocators(session.page, trajectory([
    clickAction({
      selector: "//input[@id='focusser']",
    }),
  ]));
  const flow = compile(resolved, compileOptions);
  const step = flow.steps[0];
  if (step?.action !== "click") {
    throw new Error("expected a click");
  }

  expect(await elementId(step.locator)).toBe("visible-placeholder");
  const started = Date.now();
  await runAction(session.page, step, ACTION_TIMEOUT_MS);
  expect(Date.now() - started).toBeLessThan(1_500);
  expect(await clickedId()).toBe("visible-placeholder");
});

const duplicateTextHtml = `<!DOCTYPE html>
<html>
  <body>
    <div id="registered-agent" class="ui-select-container">
      <ul class="ui-select-choices">
        <li id="choice-change" class="ui-select-choices-row">Change registered agent</li>
      </ul>
    </div>
    <div id="mailing-agent" class="ui-select-container">
      <ul class="ui-select-choices">
        <li id="choice-mail" class="ui-select-choices-row">Change registered agent</li>
      </ul>
    </div>
  </body>
</html>`;

test("duplicate exact text is saved as the unique intended row", async () => {
  await show(duplicateTextHtml);
  await session.page.evaluate(() => {
    for (const id of ["choice-change", "choice-mail"]) {
      document.getElementById(id)?.addEventListener("click", () => {
        document.body.dataset.clicked = id;
      });
    }
  });
  const resolved = await resolveTrajectoryLocators(session.page, trajectory([
    clickAction({
      selector: "text=Change registered agent",
      arguments: {
        selector: "//div[@id='registered-agent']//li[@id='choice-change']",
      },
    }),
  ]));
  const flow = compile(resolved, compileOptions);
  const step = flow.steps[0];
  if (step?.action !== "click") {
    throw new Error("expected a click");
  }

  const matches = await toLocator(session.page, step.locator).evaluateAll((elements) =>
    elements.map((element) => element.id),
  );
  expect(matches).toEqual(["choice-change"]);
  await runAction(session.page, step, ACTION_TIMEOUT_MS);
  expect(await clickedId()).toBe("choice-change");
});

test("an irrecoverable duplicate text locator fails compilation", async () => {
  await show(duplicateTextHtml);
  const pending = resolveTrajectoryLocators(session.page, trajectory([
    clickAction({ selector: "text=Change registered agent" }),
  ]));

  await expect(pending).rejects.toBeInstanceOf(QaError);
  await expect(pending).rejects.toMatchObject({
    code: "FLOW_COMPILE_FAILED",
  });
  await expect(pending).rejects.toThrow(/matched multiple elements/);
  await expect(pending).rejects.toThrow(/Change registered agent/);
});

const compileOptions = {
  id: "invoice.agent",
  name: "Choose an agent action",
  objective: "Choose the visible agent control.",
};

function trajectory(actions: DiscoveryAction[]) {
  return {
    actions,
    startedAt: "2026-09-26T19:00:00.000Z",
    endedAt: "2026-09-26T19:00:04.000Z",
    success: true,
  };
}

function clickAction(input: {
  selector: string;
  arguments?: unknown;
}): DiscoveryAction {
  return {
    index: 0,
    kind: "click",
    method: "click",
    selector: input.selector,
    urlBefore: "about:blank",
    urlAfter: "about:blank",
    arguments: input.arguments ?? {},
  };
}

async function show(html: string): Promise<void> {
  await session.page.setContent(html);
  await session.page.evaluate(() => {
    document.getElementById("visible-placeholder")?.addEventListener("click", () => {
      document.body.dataset.clicked = "visible-placeholder";
    });
  });
}

async function elementId(locator: Parameters<typeof toLocator>[1]): Promise<string> {
  return toLocator(session.page, locator).evaluate((element) => element.id);
}

async function clickedId(): Promise<string | undefined> {
  return session.page.evaluate(() => document.body.dataset.clicked);
}
