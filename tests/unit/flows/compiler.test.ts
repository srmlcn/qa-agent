import { expect, test } from "vitest";
import { QaError } from "../../../src/errors/qa-error.js";
import { compile } from "../../../src/flows/compiler.js";
import { parseFlowSpec, type Locator } from "../../../src/flows/schema.js";
import {
  fromAgentResult,
  type DiscoveryAction,
  type DiscoveryTrajectory,
} from "../../../src/stagehand/trajectory.js";

const startedAt = "2026-09-26T19:00:00.000Z";
const endedAt = "2026-09-26T19:00:04.000Z";
const note = "Archived the active project.";

const options = {
  id: "project.archive",
  name: "Archive an active project",
  objective:
    "A signed-in project owner can archive an active project and the archived state persists after reload.",
  authProfile: "project-owner",
};

type ActionInput = {
  method?: string;
  action?: string;
  instruction?: string;
  selector?: string;
  arguments?: unknown;
  kind?: string;
  urlBefore?: string;
  urlAfter?: string;
};

function trajectory(
  inputs: ActionInput[],
  trajectoryNote?: string,
): DiscoveryTrajectory {
  const result: DiscoveryTrajectory = {
    actions: inputs.map((input, index) => actionAt(input, index)),
    startedAt,
    endedAt,
    success: true,
  };
  if (trajectoryNote !== undefined) {
    result.note = trajectoryNote;
  }
  return result;
}

function actionAt(input: ActionInput, index: number): DiscoveryAction {
  const record: DiscoveryAction = {
    index,
    kind: input.kind ?? input.method ?? "action",
    selector: input.selector ?? "",
    urlBefore: input.urlBefore ?? "https://app.example/projects",
    urlAfter: input.urlAfter ?? "https://app.example/projects",
    arguments: input.arguments ?? [],
  };
  if (input.method !== undefined) {
    record.method = input.method;
  }
  if (input.action !== undefined) {
    record.action = input.action;
  }
  if (input.instruction !== undefined) {
    record.instruction = input.instruction;
  }
  return record;
}

function compileError(run: () => void): QaError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(QaError);
    if (!(error instanceof QaError)) {
      throw error;
    }
    return error;
  }
  throw new Error("expected compile to throw");
}

const twoClicks = trajectory(
  [
    {
      method: "click",
      action: "click the project options menu",
      instruction: "Open the options menu for the project",
      selector: 'role=button[name="Options for Atlas"]',
    },
    {
      method: "click",
      action: "click archive",
      instruction: "Choose the archive operation",
      selector: "#archive-project",
    },
  ],
  note,
);

test("two click actions become two steps with distinct ids", () => {
  const flow = compile(twoClicks, options);

  expect(flow.steps).toHaveLength(2);
  expect(flow.steps.map((step) => step.action)).toEqual(["click", "click"]);
  expect(flow.steps.map((step) => step.id)).toEqual([
    "click-the-project-options-menu",
    "click-archive",
  ]);
  expect(new Set(flow.steps.map((step) => step.id)).size).toBe(2);
  expect(parseFlowSpec(flow)).toEqual(flow);
});

test("each step has semanticFallback", () => {
  const flow = compile(twoClicks, options);

  expect(flow.steps.map((step) => step.semanticFallback)).toEqual([
    "Open the options menu for the project",
    "Choose the archive operation",
  ]);
  for (const step of flow.steps) {
    expect(step.semanticFallback).toEqual(expect.any(String));
    expect(step.semanticFallback?.trim().length).toBeGreaterThan(0);
  }
});

test("state is draft and assertions is empty", () => {
  const flow = compile(twoClicks, options);

  expect(flow.version).toBe(1);
  expect(flow.id).toBe(options.id);
  expect(flow.name).toBe(options.name);
  expect(flow.objective).toBe(options.objective);
  expect(flow.state).toBe("draft");
  expect(flow.assertions).toEqual([]);
  expect(flow.inputs).toEqual({});
  expect(flow.authProfile).toBe("project-owner");
  expect(flow.evidence).toBeUndefined();
});

test("an empty trajectory throws FLOW_COMPILE_FAILED", () => {
  const error = compileError(() =>
    compile(
      {
        actions: [],
        startedAt,
        endedAt,
        success: true,
        note: "The task looks complete.",
      },
      options,
    ),
  );

  expect(error.code).toBe("FLOW_COMPILE_FAILED");
  expect(error.recoveryAppropriate).toBe(false);
  expect(error.flowId).toBe(options.id);
});

test("the final agent message is not a step", () => {
  const flow = compile(twoClicks, options);

  expect(flow.steps).toHaveLength(twoClicks.actions.length);
  expect(flow.steps.map((step) => step.intent)).not.toContain(note);
  expect(flow.steps.map((step) => step.semanticFallback)).not.toContain(note);
  expect(JSON.stringify(flow.steps)).not.toContain(note);
  expect(JSON.stringify(flow.assertions)).not.toContain(note);
});

test("maps known methods onto the action vocabulary", () => {
  const flow = compile(
    trajectory([
      {
        method: "click",
        action: "Open archive",
        selector: "button.archive",
      },
      {
        method: "fill",
        selector: "#email",
        arguments: ["ada@example.com"],
      },
      { method: "type", selector: "#name", arguments: ["Ada"] },
      { method: "press", selector: "#search", arguments: ["Enter"] },
      {
        method: "select",
        selector: "select.status",
        arguments: ["archived"],
      },
      { method: "check", selector: "#confirm" },
      { method: "uncheck", selector: "#notify" },
      {
        method: "goto",
        arguments: ["https://app.example/projects"],
      },
      { method: "reload" },
      { method: "waitFor", selector: ".ready" },
    ]),
    options,
  );

  expect(flow.steps.map((step) => step.action)).toEqual([
    "click",
    "fill",
    "fill",
    "press",
    "select",
    "check",
    "uncheck",
    "goto",
    "reload",
    "waitFor",
  ]);
  expect(flow.steps[1]).toMatchObject({
    action: "fill",
    value: "ada@example.com",
    locator: { type: "css", selector: "#email" },
  });
  expect(flow.steps[2]).toMatchObject({ action: "fill", value: "Ada" });
  expect(flow.steps[3]).toMatchObject({ action: "press", value: "Enter" });
  expect(flow.steps[4]).toMatchObject({
    action: "select",
    value: "archived",
  });
  expect(flow.steps[7]).toMatchObject({
    action: "goto",
    value: "https://app.example/projects",
  });
  expect(flow.steps[7]).not.toHaveProperty("locator");
  expect(flow.steps[8]).toEqual({
    id: "reload-the-page",
    intent: "Reload the page",
    semanticFallback: "Reload the page",
    action: "reload",
  });
  expect(flow.steps[9]).toMatchObject({
    action: "waitFor",
    locator: { type: "css", selector: ".ready" },
    semanticFallback: "Wait for .ready",
  });
  expect(flow.steps[9]).not.toHaveProperty("value");
  expect(flow.assertions).toEqual([]);
});

test("an unknown method throws FLOW_COMPILE_FAILED", () => {
  const error = compileError(() =>
    compile(
      trajectory([
        {
          method: "click",
          action: "Open archive",
          selector: "button.archive",
        },
        { method: "hover", selector: "#menu", action: "hover the menu" },
      ]),
      options,
    ),
  );

  expect(error.code).toBe("FLOW_COMPILE_FAILED");
  expect(error.message).toContain("hover");
  expect(error.recoveryAppropriate).toBe(false);
});

test("uses the instruction as semanticFallback and the description as intent", () => {
  const flow = compile(
    trajectory([
      {
        method: "click",
        action: "Open the options menu",
        instruction: "Find and open the actions menu",
        selector: "role=button[name='Options']",
      },
    ]),
    options,
  );

  expect(flow.steps[0]).toMatchObject({
    intent: "Open the options menu",
    semanticFallback: "Find and open the actions menu",
    locator: { type: "role", role: "button", name: "Options" },
  });
});

test("copies intent into semanticFallback when the action has no instruction", () => {
  const flow = compile(
    trajectory([
      {
        method: "click",
        action: "Open the options menu",
        selector: "#options",
      },
    ]),
    options,
  );

  expect(flow.steps[0]?.intent).toBe("Open the options menu");
  expect(flow.steps[0]?.semanticFallback).toBe(flow.steps[0]?.intent);
});

test("intent uses the label, placeholder, text, test id, or attribute value", () => {
  const flow = compile(
    trajectory([
      { method: "click", selector: "label=Email" },
      {
        method: "fill",
        selector: "placeholder=Search projects",
        arguments: ["atlas"],
      },
      { method: "click", selector: "text=Archive project" },
      { method: "click", selector: "testid=save-button" },
      { method: "click", selector: '[data-qa="archive"]' },
    ]),
    options,
  );

  expect(flow.steps.map((step) => step.intent)).toEqual([
    "Click Email",
    "Fill Search projects",
    "Click Archive project",
    "Click save-button",
    "Click archive",
  ]);
  expect(flow.steps.map((step) => step.semanticFallback)).toEqual(
    flow.steps.map((step) => step.intent),
  );
  expect(flow.steps.map((step) => step.id)).toEqual([
    "click-email",
    "fill-search-projects",
    "click-archive-project",
    "click-save-button",
    "click-archive",
  ]);
  expect(flow.steps.map((step) => step.locator)).toEqual([
    { type: "label", name: "Email" },
    { type: "placeholder", value: "Search projects" },
    { type: "text", text: "Archive project" },
    { type: "testid", name: "save-button" },
    { type: "attr", name: "data-qa", value: "archive" },
  ]);
});

test("builds a short intent from the method and target", () => {
  const flow = compile(
    trajectory([
      {
        method: "click",
        arguments: { role: "button", name: "Archive" },
        selector: "//button[1]",
      },
    ]),
    options,
  );

  expect(flow.steps[0]).toMatchObject({
    action: "click",
    intent: "Click Archive",
    semanticFallback: "Click Archive",
    locator: { type: "role", role: "button", name: "Archive" },
  });
});

test("emits role when the action carries both role and xpath", () => {
  const flow = compile(
    trajectory([
      {
        method: "click",
        action: "click the project options menu",
        instruction: "Open the options menu for the project",
        selector: "xpath=//button[@id='options']",
        arguments: { role: "button", name: "Options for Atlas" },
      },
    ]),
    options,
  );

  expect(flow.state).toBe("draft");
  expect(flow.assertions).toEqual([]);
  expect(flow.steps).toHaveLength(1);
  expect(flow.steps[0]).toMatchObject({
    id: "click-the-project-options-menu",
    intent: "click the project options menu",
    semanticFallback: "Open the options menu for the project",
    action: "click",
    locator: { type: "role", role: "button", name: "Options for Atlas" },
  });
});

test("keeps xpath only when role and css are absent", () => {
  const flow = compile(
    trajectory([
      {
        method: "click",
        action: "Open options",
        selector: "xpath=//button[@aria-label='Options']",
      },
    ]),
    options,
  );

  expect(flow.steps[0]).toMatchObject({
    locator: {
      type: "xpath",
      selector: "//button[@aria-label='Options']",
    },
  });
});

const acceptedLocatorKinds = {
  role: "role",
  label: "label",
  placeholder: "placeholder",
  text: "text",
  testid: "testid",
  attr: "attr",
  css: "css",
  xpath: "xpath",
} as const satisfies Record<Locator["type"], string>;

test("a missing locator names every kind the compiler accepts", () => {
  const error = compileError(() =>
    compile(
      trajectory([
        {
          method: "click",
          arguments: { coordinates: [180, 420] },
        },
      ]),
      options,
    ),
  );

  const kinds = Object.keys(acceptedLocatorKinds);
  const last = kinds[kinds.length - 1];
  const listed = `${kinds.slice(0, -1).join(", ")}, or ${last}`;

  expect(error.code).toBe("FLOW_COMPILE_FAILED");
  expect(error.stepId).toBe("click-the-target");
  expect(error.message).toBe(
    `Action at index 0 has no ${listed} locator.`,
  );
  for (const kind of kinds) {
    expect(error.message).toContain(kind);
  }
});

test("a click with an empty selector throws FLOW_COMPILE_FAILED", () => {
  const error = compileError(() =>
    compile(
      trajectory([
        {
          method: "click",
          action: "Open the menu",
          arguments: { coordinates: [180, 420] },
        },
      ]),
      options,
    ),
  );

  expect(error.code).toBe("FLOW_COMPILE_FAILED");
  expect(error.stepId).toBe("open-the-menu");
  expect(error.flowId).toBe(options.id);
});

test("a fill without a value throws FLOW_COMPILE_FAILED", () => {
  const error = compileError(() =>
    compile(
      trajectory([{ method: "fill", selector: "#email", arguments: [] }]),
      options,
    ),
  );

  expect(error.code).toBe("FLOW_COMPILE_FAILED");
});

test("duplicate intents still receive distinct step ids", () => {
  const flow = compile(
    trajectory([
      { method: "click", action: "Open the menu", selector: "#menu" },
      { method: "click", action: "Open the menu", selector: "#menu-2" },
    ]),
    options,
  );

  expect(flow.steps.map((step) => step.id)).toEqual([
    "open-the-menu",
    "open-the-menu-2",
  ]);
});

test("uses a bare action name when method is absent", () => {
  const flow = compile(
    trajectory([
      {
        action: "click",
        kind: "click",
        selector: "button.archive",
      },
    ]),
    options,
  );

  expect(flow.steps[0]).toMatchObject({
    action: "click",
    intent: "Click button.archive",
    locator: { type: "css", selector: "button.archive" },
  });
});

test("goto uses the destination url when arguments omit it", () => {
  const flow = compile(
    trajectory([
      {
        method: "goto",
        urlBefore: "https://app.example/login",
        urlAfter: "https://app.example/projects",
      },
    ]),
    options,
  );

  expect(flow.steps[0]).toMatchObject({
    action: "goto",
    value: "https://app.example/projects",
    intent: "Go to https://app.example/projects",
    semanticFallback: "Go to https://app.example/projects",
  });
});

test("omits authProfile when the caller does not provide one", () => {
  const flow = compile(twoClicks, {
    id: options.id,
    name: options.name,
    objective: options.objective,
  });

  expect(flow.authProfile).toBeUndefined();
  expect(flow.state).toBe("draft");
});

test("focused keys type and press compile without locators", () => {
  const discovered = fromAgentResult(
    {
      success: true,
      actions: [
        {
          type: "keys",
          method: "type",
          value: "Ada",
          times: 1,
          success: true,
          taskCompleted: false,
        },
        {
          type: "keys",
          method: "press",
          value: "Tab",
          times: 2,
          success: true,
          taskCompleted: false,
        },
      ],
    },
    { startedAt, endedAt },
  );
  const flow = compile(discovered, options);

  expect(flow.steps.map((step) => step.action)).toEqual([
    "fill",
    "press",
    "press",
  ]);
  expect(flow.steps.map((step) => ("value" in step ? step.value : ""))).toEqual([
    "Ada",
    "Tab",
    "Tab",
  ]);
  for (const step of flow.steps) {
    expect(step).not.toHaveProperty("locator");
  }
  expect(flow.steps[1]).toMatchObject({ intent: "Press Tab" });
  expect(parseFlowSpec(flow)).toEqual(flow);
});

test("a type that already has a locator still fills that locator", () => {
  const flow = compile(
    trajectory([
      { method: "type", selector: "#name", arguments: ["Ada"] },
    ]),
    options,
  );

  expect(flow.steps[0]).toMatchObject({
    action: "fill",
    value: "Ada",
    locator: { type: "css", selector: "#name" },
  });
});

test("a locator fill without a locator throws FLOW_COMPILE_FAILED", () => {
  const error = compileError(() =>
    compile(
      trajectory([{ method: "fill", arguments: { value: "Ada" } }]),
      options,
    ),
  );

  expect(error.code).toBe("FLOW_COMPILE_FAILED");
  expect(error.message).toContain("locator");
});

test("a keys-kind press with no locator compiles to a focused keyboard press", () => {
  const flow = compile(
    trajectory([{ method: "press", kind: "keys", arguments: ["Enter"] }]),
    options,
  );

  expect(flow.steps).toHaveLength(1);
  expect(flow.steps[0]).toMatchObject({
    action: "press",
    value: "Enter",
    intent: "Press Enter",
  });
  expect(flow.steps[0]).not.toHaveProperty("locator");
  expect(parseFlowSpec(flow)).toEqual(flow);
});

test("an act-kind press without a locator throws FLOW_COMPILE_FAILED", () => {
  const error = compileError(() =>
    compile(
      trajectory([{ method: "press", kind: "act", arguments: ["Enter"] }]),
      options,
    ),
  );

  expect(error.code).toBe("FLOW_COMPILE_FAILED");
  expect(error.message).toContain("locator");
});

test("click, hover, check, and select still require a locator", () => {
  for (const method of ["click", "hover", "check", "select"] as const) {
    const error = compileError(() =>
      compile(
        trajectory([
          {
            method,
            ...(method === "select" ? { arguments: { value: "blue" } } : {}),
          },
        ]),
        options,
      ),
    );
    expect(error.code).toBe("FLOW_COMPILE_FAILED");
    if (method === "hover") {
      expect(error.message).toContain("hover");
    } else {
      expect(error.message).toContain("locator");
    }
  }
});
