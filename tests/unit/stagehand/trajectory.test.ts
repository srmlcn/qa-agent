import { expect, test } from "vitest";
import { mapToolResultToActions } from "../../../node_modules/@browserbasehq/stagehand/dist/esm/lib/v3/agent/utils/actionMapping.js";
import { QaError } from "../../../src/errors/qa-error.js";
import { chooseLocator } from "../../../src/flows/rank.js";
import { fromAgentResult } from "../../../src/stagehand/trajectory.js";

const meta = {
  startedAt: "2026-09-26T19:00:00.000Z",
  endedAt: "2026-09-26T19:00:04.000Z",
};

const note = "Archived the active project.";

const agentResult = {
  success: true,
  message: note,
  completed: true,
  actions: [
    {
      type: "act",
      reasoning: "The options menu is in the project row.",
      taskCompleted: false,
      action: "click the project options menu",
      instruction: "Open the options menu for the project",
      playwrightArguments: {
        selector: "//button[@aria-label='Options for Atlas']",
        description: "Open the options menu for the project",
        method: "click",
        arguments: [],
      },
      pageUrl: "https://app.example/projects",
    },
    {
      type: "click",
      reasoning: "Archive is the second menu item.",
      taskCompleted: false,
      action: "click",
      coordinates: [180, 420],
      pageUrl: "https://app.example/projects",
      screenshotPath: "artifacts/discovery/click-archive.png",
    },
    {
      type: "done",
      reasoning: note,
      taskCompleted: true,
      pageUrl: "https://app.example/projects/archived",
    },
  ],
};

test("two tool actions and a final message yield two actions and a note", () => {
  const trajectory = fromAgentResult(agentResult, meta);

  expect(trajectory.actions).toHaveLength(2);
  expect(trajectory.note).toBe(note);
  expect(trajectory.success).toBe(true);
  expect(trajectory.startedAt).toBe(meta.startedAt);
  expect(trajectory.endedAt).toBe(meta.endedAt);
  expect(trajectory.actions.map((action) => action.index)).toEqual([0, 1]);
  expect(trajectory.actions[0]).toMatchObject({
    kind: "act",
    action: "click the project options menu",
    instruction: "Open the options menu for the project",
    method: "click",
    selector: "//button[@aria-label='Options for Atlas']",
    urlBefore: "https://app.example/projects",
    arguments: [],
  });
});

test("an action with an action name and no selector is preserved with an empty selector", () => {
  const trajectory = fromAgentResult(agentResult, meta);
  const click = trajectory.actions[1];

  expect(click?.action).toBe("click");
  expect(click?.selector).toBe("");
  expect(click?.kind).toBe("click");
  expect(click?.arguments).toEqual({ coordinates: [180, 420] });
});

test("the note is not present inside actions", () => {
  const trajectory = fromAgentResult(agentResult, meta);

  expect(trajectory.actions).not.toContainEqual(
    expect.objectContaining({ note }),
  );
  expect(JSON.stringify(trajectory.actions)).not.toContain(note);
});

test("success with zero concrete actions yields an empty action list", () => {
  const trajectory = fromAgentResult(
    {
      success: true,
      message: "The task looks complete.",
      actions: [{ type: "done", reasoning: "finished", taskCompleted: true }],
    },
    meta,
  );

  expect(trajectory.success).toBe(true);
  expect(trajectory.actions).toHaveLength(0);
  expect(trajectory.note).toBe("The task looks complete.");
});

test("top-level role, accessibleName, and aria-label survive on the action", () => {
  const trajectory = fromAgentResult(
    {
      success: true,
      actions: [
        {
          type: "click",
          method: "click",
          action: "click save",
          selector: "//button[1]",
          role: " button ",
          accessibleName: " Save draft ",
          "aria-label": " Save ",
        },
      ],
    },
    meta,
  );

  const action = trajectory.actions[0];

  expect(trajectory.actions).toHaveLength(1);
  expect(action).toMatchObject({
    role: "button",
    accessibleName: "Save draft",
    "aria-label": "Save",
  });
  expect(action && chooseLocator(action)).toEqual({
    type: "role",
    role: "button",
    name: "Save draft",
  });
});

test("role and accessible name that exist only as top-level hints rank as a role locator", () => {
  const trajectory = fromAgentResult(
    {
      success: true,
      actions: [
        {
          type: "click",
          method: "click",
          action: "click save",
          role: "button",
          accessibleName: "Save",
        },
      ],
    },
    meta,
  );

  const action = trajectory.actions[0];

  expect(action?.selector).toBe("");
  expect(action && chooseLocator(action)).toEqual({
    type: "role",
    role: "button",
    name: "Save",
  });
});

test("role and aria-label that exist only as top-level hints rank as a role locator", () => {
  const trajectory = fromAgentResult(
    {
      success: true,
      actions: [
        {
          type: "click",
          method: "click",
          action: "click close",
          selector: "//button",
          role: "button",
          "aria-label": "Close",
        },
      ],
    },
    meta,
  );

  const action = trajectory.actions[0];

  expect(action).toMatchObject({
    role: "button",
    "aria-label": "Close",
  });
  expect(action).not.toHaveProperty("accessibleName");
  expect(action && chooseLocator(action)).toEqual({
    type: "role",
    role: "button",
    name: "Close",
  });
});

test("blank ARIA hints are omitted from the normalized action", () => {
  const trajectory = fromAgentResult(
    {
      success: true,
      actions: [
        {
          type: "click",
          method: "click",
          action: "click",
          role: "  ",
          accessibleName: "",
          "aria-label": "   ",
        },
      ],
    },
    meta,
  );

  expect(trajectory.actions[0]).not.toHaveProperty("role");
  expect(trajectory.actions[0]).not.toHaveProperty("accessibleName");
  expect(trajectory.actions[0]).not.toHaveProperty("aria-label");
});

/**
 * Installed Stagehand 3.7.3 shapes.
 * `mapToolResultToActions` is what `agent.execute` stores on `AgentResult.actions`.
 * Tool-call envelopes are the AI SDK `TypedToolCall` (`type`, `toolName`, `input`)
 * and Stagehand `AgentToolCall` (`toolName`, `toolCallId`, `args`).
 */
const v3ActArguments = {
  selector: "xpath=/html/body/button[1]",
  description: "click the Invoices button",
  method: "click",
  arguments: [],
};

test("mapped stagehand v3 keys and goto records match the installed mapper", () => {
  expect(
    mapToolResultToActions({
      toolCallName: "keys",
      args: { method: "press", value: "Enter", repeat: 2 },
      toolResult: {
        type: "tool-result",
        toolCallId: "call_keys",
        toolName: "keys",
        input: { method: "press", value: "Enter", repeat: 2 },
        output: { success: true, method: "press", value: "Enter", times: 2 },
      },
      reasoning: "Submit the focused field.",
    }),
  ).toEqual([
    {
      type: "keys",
      reasoning: "Submit the focused field.",
      taskCompleted: false,
      method: "press",
      value: "Enter",
      repeat: 2,
      success: true,
      times: 2,
    },
  ]);

  expect(
    mapToolResultToActions({
      toolCallName: "goto",
      args: { url: "https://app.example/invoices" },
      toolResult: {
        type: "tool-result",
        toolCallId: "call_goto",
        toolName: "goto",
        input: { url: "https://app.example/invoices" },
        output: { success: true, url: "https://app.example/invoices" },
      },
    }),
  ).toEqual([
    {
      type: "goto",
      taskCompleted: false,
      url: "https://app.example/invoices",
      success: true,
    },
  ]);
});

test("a successful v3 tool-call run keeps a non-empty trajectory", () => {
  const trajectory = fromAgentResult(
    {
      success: true,
      completed: true,
      message: "Opened the invoice.",
      actions: [
        {
          type: "tool-call",
          toolCallId: "call_goto",
          toolName: "goto",
          input: { url: "https://app.example/invoices" },
        },
        {
          type: "tool-result",
          toolCallId: "call_act",
          toolName: "act",
          input: { action: "click the Invoices button" },
          output: {
            success: true,
            action: "click the Invoices button",
            playwrightArguments: v3ActArguments,
          },
        },
        {
          type: "tool-result",
          toolCallId: "call_type",
          toolName: "keys",
          input: { method: "type", value: "Ada", repeat: 1 },
          output: { success: true, method: "type", value: "Ada", times: 1 },
        },
        {
          toolName: "keys",
          toolCallId: "call_press",
          args: { method: "press", value: "Enter", repeat: 2 },
          result: { success: true, method: "press", value: "Enter", times: 2 },
        },
        {
          type: "tool-result",
          toolCallId: "call_wait",
          toolName: "wait",
          input: { timeMs: 500 },
          output: { success: true, waited: 500 },
        },
        {
          type: "tool-result",
          toolCallId: "call_click",
          toolName: "click",
          input: { describe: "the Save button", coordinates: [10, 20] },
          output: {
            success: true,
            describe: "the Save button",
            coordinates: [12, 22],
          },
        },
        {
          type: "tool-result",
          toolCallId: "call_fill",
          toolName: "fillForm",
          input: {
            fields: [{ action: "type ada@example.com into the email input" }],
          },
          output: {
            success: true,
            actions: [],
            playwrightArguments: [
              {
                selector: "xpath=/html/body/input[1]",
                description: "email input",
                method: "fill",
                arguments: ["ada@example.com"],
              },
            ],
          },
        },
      ],
    },
    meta,
  );

  expect(trajectory.success).toBe(true);
  expect(trajectory.actions.map((action) => action.method ?? action.kind)).toEqual([
    "goto",
    "click",
    "type",
    "press",
    "press",
    "waitFor",
    "click",
    "fill",
  ]);
  expect(trajectory.actions[0]).toMatchObject({
    kind: "goto",
    method: "goto",
    arguments: { url: "https://app.example/invoices" },
  });
  expect(trajectory.actions[1]).toMatchObject({
    method: "click",
    selector: "xpath=/html/body/button[1]",
    instruction: "click the Invoices button",
    action: "click the Invoices button",
  });
  expect(trajectory.actions[2]).toMatchObject({
    kind: "keys",
    method: "type",
    arguments: { value: "Ada", times: 1 },
  });
  expect(trajectory.actions[3]).toMatchObject({
    method: "press",
    arguments: { value: "Enter", times: 2 },
  });
  expect(trajectory.actions[4]).toMatchObject({
    method: "press",
    arguments: { value: "Enter", times: 2 },
  });
  expect(trajectory.actions[5]).toMatchObject({
    kind: "wait",
    method: "waitFor",
    arguments: { value: "500" },
  });
  expect(trajectory.actions[6]).toMatchObject({
    kind: "click",
    instruction: "the Save button",
    arguments: { coordinates: [12, 22] },
  });
  expect(trajectory.actions[6]?.method).toBeUndefined();
  expect(trajectory.actions[7]).toMatchObject({
    method: "fill",
    selector: "xpath=/html/body/input[1]",
    instruction: "email input",
    arguments: ["ada@example.com"],
  });
  expect(trajectory.note).toBe("Opened the invoice.");
});

test("mapped v3 goto, keys, and wait stay in the trajectory and scroll is named", () => {
  const [keys] = mapToolResultToActions({
    toolCallName: "keys",
    args: { method: "type", value: "Ada" },
    toolResult: {
      type: "tool-result",
      toolCallId: "call_keys",
      toolName: "keys",
      input: { method: "type", value: "Ada" },
      output: { success: true, method: "type", value: "Ada", times: 1 },
    },
    reasoning: "The field is focused.",
  });
  const [goto] = mapToolResultToActions({
    toolCallName: "goto",
    args: { url: "https://app.example/invoices" },
    toolResult: {
      type: "tool-result",
      toolCallId: "call_goto",
      toolName: "goto",
      input: { url: "https://app.example/invoices" },
      output: { success: true, url: "https://app.example/invoices" },
    },
  });
  const [wait] = mapToolResultToActions({
    toolCallName: "wait",
    args: { timeMs: 250 },
    toolResult: {
      type: "tool-result",
      toolCallId: "call_wait",
      toolName: "wait",
      input: { timeMs: 250 },
      output: { success: true, waited: 250 },
    },
  });
  const [scroll] = mapToolResultToActions({
    toolCallName: "scroll",
    args: { direction: "down", percentage: 80 },
    toolResult: {
      type: "tool-result",
      toolCallId: "call_scroll",
      toolName: "scroll",
      input: { direction: "down", percentage: 80 },
      output: {
        success: true,
        message: "Scrolled 80% down (640px)",
        scrolledPixels: 640,
      },
    },
  });

  const trajectory = fromAgentResult(
    {
      success: true,
      completed: true,
      message: "Reached the invoice.",
      actions: [goto, keys, wait, scroll],
    },
    meta,
  );

  expect(trajectory.actions.map((action) => action.method)).toEqual([
    "goto",
    "type",
    "waitFor",
  ]);
  expect(trajectory.actions[1]).toMatchObject({
    arguments: { value: "Ada", times: 1 },
  });
  expect(trajectory.note).toBe(
    'Reached the invoice. Skipped unsupported Stagehand tool "scroll".',
  );
});

test("unsupported v3 tools fail instead of an empty trajectory", () => {
  let error: unknown;
  try {
    fromAgentResult(
      {
        success: true,
        completed: true,
        actions: [
          {
            type: "scroll",
            direction: "down",
            percentage: 80,
            success: true,
            message: "Scrolled",
            scrolledPixels: 100,
          },
          {
            type: "think",
            reasoning: "the dropdown is closed",
            taskCompleted: false,
            acknowledged: true,
            message: "ok",
          },
          { type: "ariaTree", taskCompleted: false },
        ],
      },
      meta,
    );
  } catch (caught) {
    error = caught;
  }

  expect(error).toBeInstanceOf(QaError);
  if (!(error instanceof QaError)) {
    throw new Error("expected DISCOVERY_FAILED");
  }
  expect(error.code).toBe("DISCOVERY_FAILED");
  expect(error.message).toContain("unsupported Stagehand tools");
  expect(error.message).toContain("scroll");
  expect(error.message).toContain("think");
  expect(error.message).toContain("ariaTree");
  expect(error.message).not.toContain("Discovery stopped after 0 actions");
});

test("an unrecognized tool fails instead of an empty trajectory", () => {
  let error: unknown;
  try {
    fromAgentResult(
      {
        success: true,
        completed: true,
        actions: [{ type: "widget", payload: { id: "menu" } }],
      },
      meta,
    );
  } catch (caught) {
    error = caught;
  }

  expect(error).toBeInstanceOf(QaError);
  if (!(error instanceof QaError)) {
    throw new Error("expected DISCOVERY_FAILED");
  }
  expect(error.code).toBe("DISCOVERY_FAILED");
  expect(error.message).toContain("widget");
  expect(error.message).not.toContain("Discovery stopped after 0 actions");
});

test("keyboard text keeps surrounding spaces and urls stay trimmed", () => {
  const trajectory = fromAgentResult(
    {
      success: true,
      actions: [
        {
          type: "keys",
          method: "type",
          value: "  Ada  ",
          times: 1,
        },
        {
          type: "keys",
          method: "type",
          value: " ",
          times: 1,
        },
        {
          type: "goto",
          url: "  https://app.example/invoices  ",
        },
      ],
    },
    meta,
  );

  expect(trajectory.actions[0]?.arguments).toMatchObject({ value: "  Ada  " });
  expect(trajectory.actions[1]?.arguments).toMatchObject({ value: " " });
  expect(trajectory.actions[2]?.arguments).toMatchObject({
    url: "https://app.example/invoices",
  });
});

test("a keyboard repeat above maxSteps fails before expansion", () => {
  let error: unknown;
  try {
    fromAgentResult(
      {
        success: true,
        actions: [{ type: "keys", method: "press", value: "Enter", repeat: 1_000_000 }],
      },
      { ...meta, maxSteps: 2 },
    );
  } catch (caught) {
    error = caught;
  }

  expect(error).toBeInstanceOf(QaError);
  if (!(error instanceof QaError)) {
    throw new Error("expected DISCOVERY_FAILED");
  }
  expect(error.code).toBe("DISCOVERY_FAILED");
  expect(error.message).toContain("maxSteps is 2");
  expect(error.message).not.toContain("1000000");
});

test("a message alone does not become an action", () => {
  const trajectory = fromAgentResult(
    {
      success: true,
      message: "Nothing was clicked.",
    },
    meta,
  );

  expect(trajectory.actions).toHaveLength(0);
  expect(trajectory.note).toBe("Nothing was clicked.");
});
