import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { expect, test } from "vitest";
import { parseFlowSpec } from "../../../src/flows/schema.js";

const fixturePath = new URL("./fixtures/archive-project.yml", import.meta.url);

function readArchiveSample(): unknown {
  return parse(readFileSync(fixturePath, "utf8"));
}

function flowWithSteps(steps: unknown[]): Record<string, unknown> {
  return {
    version: 1,
    id: "project.archive",
    name: "Archive an active project",
    objective: "Archive a project",
    inputs: {},
    steps,
    assertions: [],
  };
}

test("parses the section 3.5 archive sample", () => {
  const flow = parseFlowSpec(readArchiveSample());

  expect(flow.version).toBe(1);
  expect(flow.id).toBe("project.archive");
  expect(flow.name).toBe("Archive an active project");
  expect(flow.objective).toContain("archived state persists after reload");
  expect(flow.state).toBe("draft");
  expect(flow.authProfile).toBe("project-owner");
  expect(flow.inputs.projectName).toEqual({
    type: "string",
    required: true,
  });
  expect(flow.steps).toHaveLength(3);
  expect(flow.steps[0]).toMatchObject({
    id: "open-project-options",
    action: "click",
    locator: {
      type: "role",
      role: "button",
      name: "Options for ${projectName}",
    },
  });
  expect(flow.steps[0]?.semanticFallback).toContain("${projectName}");
  expect(flow.assertions.map((assertion) => assertion.type)).toEqual([
    "not-visible",
    "sequence",
  ]);
  expect(flow.assertions[1]).toEqual({
    id: "persists-after-reload",
    type: "sequence",
    sequence: [
      { action: "reload" },
      {
        type: "not-visible",
        locator: {
          type: "text",
          text: "${projectName}",
        },
      },
    ],
  });
  expect(flow.evidence).toEqual({
    screenshots: [{ after: "confirm-archive" }],
    network: true,
    console: { errors: true },
    trace: "on-failure",
  });
  expect(parseFlowSpec(flow)).toEqual(flow);
});

test("defaults omitted state to draft on output", () => {
  const flow = parseFlowSpec(
    flowWithSteps([
      {
        id: "open",
        intent: "Open the page",
        action: "goto",
        value: "/projects/${projectName}",
      },
    ]),
  );

  expect(flow.state).toBe("draft");
  expect(flow.steps[0]).toMatchObject({
    action: "goto",
    value: "/projects/${projectName}",
  });
});

test("rejects an unknown action", () => {
  expect(() =>
    parseFlowSpec(
      flowWithSteps([
        {
          id: "open",
          intent: "Open the menu",
          action: "hover",
        },
      ]),
    ),
  ).toThrow();
});

test("rejects a click without a locator", () => {
  expect(() =>
    parseFlowSpec(
      flowWithSteps([
        {
          id: "open",
          intent: "Open the menu",
          action: "click",
        },
      ]),
    ),
  ).toThrow();
});

test("allows a focused fill and press without a locator", () => {
  const flow = parseFlowSpec(
    flowWithSteps([
      {
        id: "type-name",
        intent: "Type the name",
        action: "fill",
        value: "Ada",
      },
      {
        id: "press-enter",
        intent: "Press Enter",
        action: "press",
        value: "Enter",
      },
    ]),
  );

  expect(flow.steps[0]).toMatchObject({ action: "fill", value: "Ada" });
  expect(flow.steps[0]).not.toHaveProperty("locator");
  expect(flow.steps[1]).toMatchObject({ action: "press", value: "Enter" });
  expect(flow.steps[1]).not.toHaveProperty("locator");
});

test("rejects a css locator without selector", () => {
  expect(() =>
    parseFlowSpec(
      flowWithSteps([
        {
          id: "open",
          intent: "Open the menu",
          action: "click",
          locator: { type: "css" },
        },
      ]),
    ),
  ).toThrow();
});

test("rejects a nested sequence assertion", () => {
  expect(() =>
    parseFlowSpec({
      ...flowWithSteps([]),
      assertions: [
        {
          id: "nested",
          type: "sequence",
          sequence: [
            {
              type: "custom-sequence",
              sequence: [{ action: "reload" }],
            },
          ],
        },
      ],
    }),
  ).toThrow();
});
