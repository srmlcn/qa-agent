import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { afterAll, beforeAll, expect, test } from "vitest";
import { chromium, type Browser } from "playwright";
import { QaError } from "../../../src/errors/qa-error.js";
import { compile } from "../../../src/flows/compiler.js";
import type { DiscoveryAction } from "../../../src/stagehand/trajectory.js";
import { runAction } from "../../../src/playwright/actions.js";
import {
  resolveDiscoveryLocators,
  resolveTrajectoryLocators,
  toLocator,
} from "../../../src/playwright/locators.js";
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

test("a blank Playwright page resolves locators on the Stagehand browser", async () => {
  const port = await reservePort();
  let remote: Browser | undefined;
  const blankContext = await session.browser.newContext();
  const blank = await blankContext.newPage();
  try {
    remote = await chromium.launch({
      headless: true,
      args: [
        `--remote-debugging-port=${port}`,
        "--remote-debugging-address=127.0.0.1",
      ],
    });
    const page = await remote.newPage();
    const served = await serveHtml(hiddenSelectHtml);
    try {
      await page.goto(served.url);
    const version = await fetch(`http://127.0.0.1:${port}/json/version`);
    const body = (await version.json()) as { webSocketDebuggerUrl?: string };
    const connectUrl = body.webSocketDebuggerUrl;
    if (connectUrl === undefined) {
      throw new Error("expected a websocket debugger URL");
    }

    const resolved = await resolveDiscoveryLocators(
      blank,
      trajectory([
        clickAction({
          selector: "//input[@id='focusser']",
          urlBefore: served.url,
        }),
      ]),
      connectUrl,
    );
    const flow = compile(resolved, compileOptions);
    const step = flow.steps[0];
    if (step?.action !== "click") {
      throw new Error("expected a click");
    }
    expect(await toLocator(page, step.locator).evaluate((element) => element.id)).toBe(
      "visible-placeholder",
    );
    } finally {
      await served.close();
    }
  } finally {
    await blankContext.close();
    await remote?.close();
  }
});

test("a locator recorded on another page is not verified against this page", async () => {
  const served = await serveHtml(hiddenSelectHtml);
  try {
    await session.page.goto(served.url);
    const resolved = await resolveTrajectoryLocators(session.page, trajectory([
      clickAction({
        selector: "#visible-placeholder",
        urlBefore: "https://earlier.example/form",
      }),
      clickAction({
        selector: "#visible-placeholder",
        urlBefore: served.url,
      }),
    ]));

    expect(resolved.actions[0]?.resolvedLocator).toBeUndefined();
    expect(resolved.actions[1]?.resolvedLocator).toBeDefined();
    const verified = resolved.actions[1]?.resolvedLocator;
    if (verified === undefined) {
      throw new Error("expected the same-page locator to be verified");
    }
    expect(await toLocator(session.page, verified).evaluate((element) => element.id)).toBe(
      "visible-placeholder",
    );
  } finally {
    await served.close();
  }
});

test("a hash route is not the same page as another hash on that URL", async () => {
  const served = await serveHtml(hiddenSelectHtml);
  try {
    const list = `${served.url}#/invoices`;
    const edit = `${served.url}#/invoices/1/edit`;
    await session.page.goto(edit);
    const resolved = await resolveTrajectoryLocators(session.page, trajectory([
      clickAction({
        selector: "#visible-placeholder",
        urlBefore: list,
      }),
      clickAction({
        selector: "#visible-placeholder",
        urlBefore: edit,
      }),
    ]));

    expect(resolved.actions[0]?.resolvedLocator).toBeUndefined();
    expect(resolved.actions[1]?.resolvedLocator).toBeDefined();
    const verified = resolved.actions[1]?.resolvedLocator;
    if (verified === undefined) {
      throw new Error("expected the current hash route to be verified");
    }
    expect(await toLocator(session.page, verified).evaluate((element) => element.id)).toBe(
      "visible-placeholder",
    );
  } finally {
    await served.close();
  }
});

test("a return to the same hash route is not the earlier document", async () => {
  const served = await serveHtml(hiddenSelectHtml);
  try {
    const list = `${served.url}#/invoices`;
    const edit = `${served.url}#/invoices/1/edit`;
    await session.page.goto(list);
    const resolved = await resolveTrajectoryLocators(session.page, trajectory([
      {
        ...clickAction({
          selector: "#visible-placeholder",
          urlBefore: list,
        }),
        urlAfter: edit,
      },
      {
        ...clickAction({
          selector: "#visible-placeholder",
          urlBefore: edit,
        }),
        urlAfter: list,
      },
      clickAction({
        selector: "#visible-placeholder",
        urlBefore: list,
      }),
    ]));

    expect(resolved.actions[0]?.resolvedLocator).toBeUndefined();
    expect(resolved.actions[1]?.resolvedLocator).toBeUndefined();
    expect(resolved.actions[2]?.resolvedLocator).toBeDefined();
  } finally {
    await served.close();
  }
});

test("a return to the same URL is not the earlier document", async () => {
  const served = await serveHtml(hiddenSelectHtml);
  try {
    await session.page.goto(served.url);
    const resolved = await resolveTrajectoryLocators(session.page, trajectory([
      {
        ...clickAction({
          selector: "#visible-placeholder",
          urlBefore: served.url,
        }),
        urlAfter: "https://other.example/step",
      },
      {
        ...clickAction({
          selector: "#visible-placeholder",
          urlBefore: "https://other.example/step",
        }),
        urlAfter: served.url,
      },
      clickAction({
        selector: "#visible-placeholder",
        urlBefore: served.url,
      }),
    ]));

    expect(resolved.actions[0]?.resolvedLocator).toBeUndefined();
    expect(resolved.actions[1]?.resolvedLocator).toBeUndefined();
    expect(resolved.actions[2]?.resolvedLocator).toBeDefined();
  } finally {
    await served.close();
  }
});

test("a locator without a recorded page is not verified against the final page", async () => {
  const served = await serveHtml(hiddenSelectHtml);
  try {
    await session.page.goto(served.url);
    const resolved = await resolveTrajectoryLocators(session.page, trajectory([
      {
        ...clickAction({ selector: "#visible-placeholder" }),
        urlBefore: "",
        urlAfter: served.url,
      },
    ]));

    expect(resolved.actions[0]?.resolvedLocator).toBeUndefined();
  } finally {
    await served.close();
  }
});

test("a locator-backed wait whose target is gone stays recorded", async () => {
  await show(hiddenSelectHtml);
  const resolved = await resolveTrajectoryLocators(session.page, trajectory([
    {
      index: 0,
      kind: "wait",
      method: "waitFor",
      selector: "#missing",
      urlBefore: "about:blank",
      urlAfter: "about:blank",
      arguments: {},
    },
  ]));

  expect(resolved.actions[0]?.resolvedLocator).toBeUndefined();
});

test("a timer wait without a locator is not probed", async () => {
  await show(hiddenSelectHtml);
  const resolved = await resolveTrajectoryLocators(session.page, trajectory([
    {
      index: 0,
      kind: "wait",
      method: "waitFor",
      urlBefore: "about:blank",
      urlAfter: "about:blank",
      arguments: { value: "500" },
    },
  ]));

  expect(resolved.actions[0]?.resolvedLocator).toBeUndefined();
});

const duplicatePlaceholderHtml = `<!DOCTYPE html>
<html>
  <body>
    <div class="ui-select-container">
      <span class="ui-select-placeholder">Select an action</span>
      <span class="ui-select-placeholder">Select an action</span>
      <input id="focusser" class="ui-select-focusser"
        style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0" />
    </div>
  </body>
</html>`;

const looseInputHtml = `<!DOCTYPE html>
<html>
  <body>
    <button id="unrelated" role="button">Go</button>
    <input id="focusser" style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0" />
  </body>
</html>`;

const widgetClearHtml = `<!DOCTYPE html>
<html>
  <body>
    <div class="ui-select-container">
      <div id="combo" role="combobox">Pick</div>
      <button id="clear" role="button" aria-label="Clear">Clear</button>
      <input id="focusser" style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0" />
    </div>
  </body>
</html>`;

test("a hidden input outside a widget is not retargeted to a page button", async () => {
  await show(looseInputHtml);
  const pending = resolveTrajectoryLocators(session.page, trajectory([
    clickAction({ selector: "//input[@id='focusser']" }),
  ]));

  await expect(pending).rejects.toMatchObject({ code: "FLOW_COMPILE_FAILED" });
  await expect(pending).rejects.toThrow(/no visible surface/);
});

test("a widget clear button is not the hidden field surface", async () => {
  await show(widgetClearHtml);
  const pending = resolveTrajectoryLocators(session.page, trajectory([
    clickAction({ selector: "//input[@id='focusser']" }),
  ]));

  await expect(pending).rejects.toMatchObject({ code: "FLOW_COMPILE_FAILED" });
  await expect(pending).rejects.toThrow(/no visible surface/);
});

test("a reload starts a new document at the same URL", async () => {
  const served = await serveHtml(hiddenSelectHtml);
  try {
    await session.page.goto(served.url);
    const resolved = await resolveTrajectoryLocators(session.page, trajectory([
      clickAction({
        selector: "#visible-placeholder",
        urlBefore: served.url,
      }),
      {
        index: 1,
        kind: "reload",
        method: "reload",
        urlBefore: served.url,
        urlAfter: served.url,
        arguments: {},
      },
      clickAction({
        selector: "#visible-placeholder",
        urlBefore: served.url,
      }),
    ]));

    expect(resolved.actions[0]?.resolvedLocator).toBeUndefined();
    expect(resolved.actions[2]?.resolvedLocator).toBeDefined();
  } finally {
    await served.close();
  }
});

test("a hidden focusser without a unique surface fails compilation", async () => {
  await show(duplicatePlaceholderHtml);
  const pending = resolveTrajectoryLocators(session.page, trajectory([
    clickAction({ selector: "//input[@id='focusser']" }),
  ]));

  await expect(pending).rejects.toMatchObject({ code: "FLOW_COMPILE_FAILED" });
  await expect(pending).rejects.toThrow(/no visible surface/);
});

test("a click whose target is gone stays recorded", async () => {
  await show(hiddenSelectHtml);
  const resolved = await resolveTrajectoryLocators(session.page, trajectory([
    clickAction({ selector: "#missing" }),
  ]));

  expect(resolved.actions[0]?.resolvedLocator).toBeUndefined();
  const flow = compile(resolved, compileOptions);
  const step = flow.steps[0];
  if (step?.action !== "click") {
    throw new Error("expected a click");
  }
  expect(step.locator).toEqual({ type: "css", selector: "#missing" });
});

test("an edit control removed after the click is not required on the final page", async () => {
  await show(`<!DOCTYPE html>
<html>
  <body>
    <button id="edit" type="button">Edit</button>
  </body>
</html>`);
  await session.page.setContent(`<!DOCTYPE html>
<html>
  <body>
    <p id="paid">Paid</p>
  </body>
</html>`);

  const resolved = await resolveTrajectoryLocators(session.page, trajectory([
    clickAction({
      selector: 'role=button[name="Edit"]',
      arguments: { role: "button", name: "Edit" },
    }),
  ]));

  expect(resolved.actions[0]?.resolvedLocator).toBeUndefined();
  const flow = compile(resolved, compileOptions);
  const step = flow.steps[0];
  if (step?.action !== "click") {
    throw new Error("expected a click");
  }
  expect(step.locator).toEqual({ type: "role", role: "button", name: "Edit" });
});

test("a hidden focusser is not retargeted for fill", async () => {
  await show(hiddenSelectHtml);
  const resolved = await resolveTrajectoryLocators(session.page, trajectory([
    {
      index: 0,
      kind: "fill",
      method: "fill",
      selector: "//input[@id='focusser']",
      urlBefore: "about:blank",
      urlAfter: "about:blank",
      arguments: { value: "Ada" },
    },
  ]));
  const flow = compile(resolved, compileOptions);
  const step = flow.steps[0];
  if (step?.action !== "fill") {
    throw new Error("expected a fill");
  }
  expect(await elementId(step.locator)).toBe("focusser");
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
  urlBefore?: string;
}): DiscoveryAction {
  return {
    index: 0,
    kind: "click",
    method: "click",
    selector: input.selector,
    urlBefore: input.urlBefore ?? "about:blank",
    urlAfter: input.urlBefore ?? "about:blank",
    arguments: input.arguments ?? {},
  };
}

function serveHtml(html: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(html);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Could not bind the fixture page."));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}/`,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => {
              if (error) {
                fail(error);
                return;
              }
              done();
            });
          }),
      });
    });
  });
}

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a loopback port."));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function show(html: string): Promise<void> {
  await session.page.goto("about:blank");
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
