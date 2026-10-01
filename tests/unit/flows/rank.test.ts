import { expect, test } from "vitest";
import { chooseLocator, rankCandidates } from "../../../src/flows/rank.js";
import type { Locator } from "../../../src/flows/schema.js";
import {
  fromAgentResult,
  type DiscoveryAction,
} from "../../../src/stagehand/trajectory.js";

const ordered: readonly Locator[] = [
  { type: "role", role: "button", name: "Save" },
  { type: "label", name: "Email" },
  { type: "placeholder", value: "Search" },
  { type: "text", text: "Submit" },
  { type: "testid", name: "submit" },
  { type: "attr", name: "data-testid", value: "submit" },
  { type: "css", selector: "#submit" },
  { type: "xpath", selector: "//button" },
];

function discovered(input: {
  selector?: string;
  arguments?: unknown;
  method?: string;
  instruction?: string;
  action?: string;
}): DiscoveryAction {
  const record: DiscoveryAction = {
    index: 0,
    kind: input.method ?? "click",
    selector: input.selector ?? "",
    urlBefore: "https://app.example/projects",
    urlAfter: "https://app.example/projects",
    arguments: input.arguments ?? {},
  };
  if (input.method !== undefined) {
    record.method = input.method;
  }
  if (input.instruction !== undefined) {
    record.instruction = input.instruction;
  }
  if (input.action !== undefined) {
    record.action = input.action;
  }
  return record;
}

test("role plus xpath yields role", () => {
  expect(
    rankCandidates([
      { type: "xpath", selector: "//button[1]" },
      { type: "role", role: "button", name: "Save" },
    ]),
  ).toEqual({ type: "role", role: "button", name: "Save" });
});

test("test id plus css yields test id", () => {
  expect(
    rankCandidates([
      { type: "css", selector: "#save" },
      { type: "testid", name: "save" },
    ]),
  ).toEqual({ type: "testid", name: "save" });
});

test("xpath alone yields xpath", () => {
  expect(
    rankCandidates([{ type: "xpath", selector: "//button[1]" }]),
  ).toEqual({ type: "xpath", selector: "//button[1]" });
});

test("a higher preference wins even when it is listed last", () => {
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const higher = ordered[index];
    const lower = ordered.slice(index + 1);
    expect(rankCandidates([...lower].reverse().concat([higher]))).toEqual(
      higher,
    );
  }
});

test("a data-* attribute ranks below an explicit test id and above css", () => {
  const attribute: Locator = { type: "attr", name: "data-qa", value: "save" };
  const css: Locator = { type: "css", selector: "button" };
  const testId: Locator = { type: "testid", name: "save" };

  expect(rankCandidates([css, attribute])).toEqual(attribute);
  expect(rankCandidates([attribute, testId])).toEqual(testId);
  expect(
    rankCandidates([
      { type: "attr", name: "data-testid", value: "save" },
      testId,
    ]),
  ).toEqual(testId);
});

test("an attribute that is not data-* does not outrank css or xpath", () => {
  const attribute: Locator = { type: "attr", name: "id", value: "save" };

  expect(
    rankCandidates([attribute, { type: "css", selector: "button" }]),
  ).toEqual({ type: "css", selector: "button" });
  expect(
    rankCandidates([attribute, { type: "xpath", selector: "//button" }]),
  ).toEqual({ type: "xpath", selector: "//button" });
});

test("a role without an accessible name does not outrank xpath", () => {
  expect(
    rankCandidates([
      { type: "role", role: "button", name: "  " },
      { type: "xpath", selector: "//button" },
    ]),
  ).toEqual({ type: "xpath", selector: "//button" });
});

test("equal preference keeps the first candidate", () => {
  const first: Locator = { type: "css", selector: "#first" };
  const second: Locator = { type: "css", selector: "#second" };
  expect(rankCandidates([first, second])).toEqual(first);
});

test("rankCandidates rejects a list with no rankable locator", () => {
  expect(() => rankCandidates([])).toThrow(/rankable/);
  expect(() =>
    rankCandidates([{ type: "attr", name: "id", value: "save" }]),
  ).toThrow(/rankable/);
});

test("chooseLocator ranks role hints copied from an agent record", () => {
  const trajectory = fromAgentResult(
    {
      success: true,
      actions: [
        {
          type: "click",
          method: "click",
          action: "click save",
          selector: "xpath=//button[1]",
          role: "button",
          accessibleName: "Save",
          "aria-label": "Save button",
        },
      ],
    },
    {
      startedAt: "2026-09-26T19:00:00.000Z",
      endedAt: "2026-09-26T19:00:04.000Z",
    },
  );
  const action = trajectory.actions[0];

  expect(action).toMatchObject({
    role: "button",
    accessibleName: "Save",
    "aria-label": "Save button",
  });
  expect(action && chooseLocator(action)).toEqual({
    type: "role",
    role: "button",
    name: "Save",
  });
});

test("chooseLocator prefers role when the action also has xpath", () => {
  expect(
    chooseLocator(
      discovered({
        selector: "xpath=//button[1]",
        arguments: { role: "button", name: "Save" },
      }),
    ),
  ).toEqual({ type: "role", role: "button", name: "Save" });
});

test("chooseLocator prefers test id when the action also has css", () => {
  expect(
    chooseLocator(
      discovered({
        selector: "#save",
        arguments: { testid: "save" },
      }),
    ),
  ).toEqual({ type: "testid", name: "save" });
});

test("chooseLocator keeps xpath when it is the only candidate", () => {
  expect(
    chooseLocator(
      discovered({
        selector: "xpath=//button[@aria-label='Options']",
      }),
    ),
  ).toEqual({
    type: "xpath",
    selector: "//button[@aria-label='Options']",
  });
});

test("chooseLocator reads a role selector and accessible name fields", () => {
  expect(
    chooseLocator(
      discovered({ selector: 'internal:role=button[name="Save"i]' }),
    ),
  ).toEqual({ type: "role", role: "button", name: "Save" });

  const record = discovered({ selector: "//button" });
  record.role = "button";
  record.accessibleName = "Save";
  expect(chooseLocator(record)).toEqual({
    type: "role",
    role: "button",
    name: "Save",
  });

  const labeled = discovered({ selector: "//button" });
  labeled.role = "button";
  labeled["aria-label"] = "Close";
  expect(chooseLocator(labeled)).toEqual({
    type: "role",
    role: "button",
    name: "Close",
  });

  expect(
    chooseLocator(
      discovered({
        selector: "role=button[name='Save']",
        arguments: { role: "link" },
      }),
    ),
  ).toEqual({ type: "role", role: "link", name: "Save" });

  expect(
    chooseLocator(
      discovered({
        selector: "//button",
        arguments: { role: "button", "aria-label": "Close" },
      }),
    ),
  ).toEqual({ type: "role", role: "button", name: "Close" });
});

test("chooseLocator ranks label, placeholder, and text above lower selectors", () => {
  expect(
    chooseLocator(
      discovered({
        selector: "text=Submit",
        arguments: { label: "Email", placeholder: "you@example.com" },
      }),
    ),
  ).toEqual({ type: "label", name: "Email" });

  expect(
    chooseLocator(
      discovered({
        selector: "text=Submit",
        arguments: { placeholder: "Search" },
      }),
    ),
  ).toEqual({ type: "placeholder", value: "Search" });

  expect(chooseLocator(discovered({ selector: 'text="Submit"' }))).toEqual({
    type: "text",
    text: "Submit",
  });
});

test("chooseLocator ranks a data-* attribute below test id and above css", () => {
  expect(
    chooseLocator(
      discovered({
        selector: '[data-testid="save"]',
        arguments: { css: "button.save" },
      }),
    ),
  ).toEqual({ type: "attr", name: "data-testid", value: "save" });

  expect(
    chooseLocator(
      discovered({
        selector: "button.save",
        arguments: { "data-qa": "save" },
      }),
    ),
  ).toEqual({ type: "attr", name: "data-qa", value: "save" });

  expect(
    chooseLocator(
      discovered({
        selector: '[data-testid="save"]',
        arguments: { testId: "save-button" },
      }),
    ),
  ).toEqual({ type: "testid", name: "save-button" });

  expect(
    chooseLocator(
      discovered({
        selector: "data-testid=save-button",
        arguments: { attr: { name: "data-testid", value: "save" } },
      }),
    ),
  ).toEqual({ type: "testid", name: "save-button" });
});

test("chooseLocator keeps css ahead of xpath and ignores unsupported engines", () => {
  expect(
    chooseLocator(
      discovered({
        selector: "//button",
        arguments: { css: "#submit" },
      }),
    ),
  ).toEqual({ type: "css", selector: "#submit" });

  expect(chooseLocator(discovered({ selector: "id=submit" }))).toBeUndefined();
  expect(chooseLocator(discovered({ selector: "nth=0" }))).toBeUndefined();
  expect(chooseLocator(discovered({ selector: "visible=true" }))).toBeUndefined();
  expect(chooseLocator(discovered({ selector: "role=button" }))).toBeUndefined();
});

test("chooseLocator does not treat the instruction as a locator", () => {
  expect(
    chooseLocator(
      discovered({
        selector: "//button",
        instruction: "Submit the form",
        action: "click Submit",
      }),
    ),
  ).toEqual({ type: "xpath", selector: "//button" });
});

test("chooseLocator returns undefined when the action has no locator", () => {
  expect(
    chooseLocator(
      discovered({
        arguments: { coordinates: [180, 420] },
      }),
    ),
  ).toBeUndefined();
});

test("a page-resolved locator wins over a higher-ranked recorded hint", () => {
  const action = discovered({
    method: "click",
    selector: "//input[@id='focusser']",
    arguments: { placeholder: "Select an action" },
  });
  action.resolvedLocator = {
    type: "css",
    selector: "#visible-placeholder",
  };

  expect(chooseLocator(action)).toEqual({
    type: "css",
    selector: "#visible-placeholder",
  });
});
