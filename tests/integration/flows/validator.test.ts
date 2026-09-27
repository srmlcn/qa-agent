import { afterAll, beforeAll, expect, test } from "vitest";
import { QaError } from "../../../src/errors/qa-error.js";
import type { Assertion, FlowSpec } from "../../../src/flows/schema.js";
import { validateFlow } from "../../../src/flows/validator.js";
import {
  startBrowser,
  type BrowserSession,
} from "../../../src/playwright/runtime.js";

const LAUNCH_TIMEOUT_MS = 30_000;
const REPLAY_TIMEOUT_MS = 5_000;
const FAIL_TIMEOUT_MS = 1_000;

const pageHtml = `<!DOCTYPE html>
<html>
  <body>
    <button type="button" id="save">Save</button>
    <p id="status" data-testid="status">Idle</p>
  </body>
</html>`;

const saveVisible: Assertion = {
  id: "save-visible",
  type: "visible",
  locator: { type: "role", role: "button", name: "Save" },
};

const statusSaved: Assertion = {
  id: "status-saved",
  type: "text",
  locator: { type: "testid", name: "status" },
  text: "Saved",
};

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

test("a click on a real button and a visible assertion returns validated", async () => {
  await showPage();
  const flow = clickFlow("Save", saveVisible);
  const before = structuredClone(flow);

  const result = await validateFlow({
    flow,
    page: session.page,
    timeoutMs: REPLAY_TIMEOUT_MS,
  });

  expect(await clickedId()).toBe("save");
  expect(flow).toEqual(before);
  expect(flow.state).toBe("draft");
  expect(result).toEqual({
    ok: true,
    flow: { ...before, state: "validated" },
  });
  expect(result.ok && result.flow).not.toBe(flow);
});

test("a repaired flow validates through the same edge", async () => {
  await showPage();
  const flow = clickFlow("Save", saveVisible, "repaired");
  const before = structuredClone(flow);

  const result = await validateFlow({
    flow,
    page: session.page,
    timeoutMs: REPLAY_TIMEOUT_MS,
  });

  expect(flow).toEqual(before);
  expect(flow.state).toBe("repaired");
  expect(result).toEqual({
    ok: true,
    flow: { ...before, state: "validated" },
  });
});

test("a missing locator returns LOCATOR_STALE and leaves the flow draft", async () => {
  await showPage();
  const flow = clickFlow("Missing", saveVisible);
  const before = structuredClone(flow);

  const result = await validateFlow({
    flow,
    page: session.page,
    timeoutMs: FAIL_TIMEOUT_MS,
  });

  expect(await clickedId()).toBeUndefined();
  expect(flow).toEqual(before);
  expect(flow.state).toBe("draft");
  expect(result.ok).toBe(false);
  if (result.ok) {
    return;
  }
  expect(result.error).toBeInstanceOf(QaError);
  expect(result.error).toMatchObject({
    code: "LOCATOR_STALE",
    recoveryAppropriate: true,
    stepId: "click-save",
  });
});

test("a failed assertion returns ASSERTION_FAILED", async () => {
  await showPage();
  const flow = clickFlow("Save", statusSaved);
  const before = structuredClone(flow);

  const result = await validateFlow({
    flow,
    page: session.page,
    timeoutMs: FAIL_TIMEOUT_MS,
  });

  expect(await clickedId()).toBe("save");
  expect(flow).toEqual(before);
  expect(flow.state).toBe("draft");
  expect(result.ok).toBe(false);
  if (result.ok) {
    return;
  }
  expect(result.error).toBeInstanceOf(QaError);
  expect(result.error).toMatchObject({
    code: "ASSERTION_FAILED",
    recoveryAppropriate: false,
    stepId: "status-saved",
  });
});

test("a non-replay failure propagates and is not reported as success", async () => {
  const flow: FlowSpec = {
    version: 1,
    id: "button.wait",
    name: "Wait too long",
    objective: "A capped wait is not a successful validation",
    state: "draft",
    inputs: {},
    steps: [
      {
        id: "wait-too-long",
        intent: "Wait past the cap",
        action: "waitFor",
        value: "10001",
      },
    ],
    assertions: [],
  };

  await expect(
    validateFlow({
      flow,
      page: session.page,
      timeoutMs: FAIL_TIMEOUT_MS,
    }),
  ).rejects.toMatchObject({
    code: "POLICY_BLOCKED",
    recoveryAppropriate: false,
    stepId: "wait-too-long",
  });
  expect(flow.state).toBe("draft");
});

function clickFlow(
  buttonName: string,
  assertion: Assertion,
  state: FlowSpec["state"] = "draft",
): FlowSpec {
  return {
    version: 1,
    id: "button.save",
    name: "Save the draft",
    objective: "Click Save and confirm the button is visible",
    state,
    inputs: {},
    steps: [
      {
        id: "click-save",
        intent: "Click Save",
        action: "click",
        locator: { type: "role", role: "button", name: buttonName },
      },
    ],
    assertions: [assertion],
  };
}

async function showPage(): Promise<void> {
  await session.page.setContent(pageHtml);
  await session.page.evaluate(() => {
    document.querySelector("#save")?.addEventListener("click", () => {
      document.body.dataset.clicked = "save";
    });
  });
}

async function clickedId(): Promise<string | undefined> {
  return session.page.evaluate(() => document.body.dataset.clicked);
}
