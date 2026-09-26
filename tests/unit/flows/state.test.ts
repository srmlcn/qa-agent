import { expect, test } from "vitest";
import { QaError } from "../../../src/errors/qa-error.js";
import {
  transition,
  type FlowEvent,
  type FlowState,
} from "../../../src/flows/state.js";
import type { FlowSpec } from "../../../src/flows/schema.js";

const EDGES: readonly {
  from: FlowState;
  event: FlowEvent;
  to: FlowState;
}[] = [
  { from: "draft", event: "validate", to: "validated" },
  { from: "validated", event: "mark-stable", to: "stable" },
  { from: "stable", event: "mark-stale", to: "stale" },
  { from: "stale", event: "mark-repaired", to: "repaired" },
  { from: "repaired", event: "validate", to: "validated" },
  { from: "validated", event: "mark-stale", to: "stale" },
];

const ILLEGAL: readonly { from: FlowState; event: FlowEvent }[] = [
  { from: "draft", event: "mark-stable" },
  { from: "draft", event: "mark-stale" },
  { from: "draft", event: "mark-repaired" },
  { from: "validated", event: "validate" },
  { from: "validated", event: "mark-repaired" },
  { from: "stable", event: "validate" },
  { from: "stable", event: "mark-stable" },
  { from: "stable", event: "mark-repaired" },
  { from: "stale", event: "validate" },
  { from: "stale", event: "mark-stable" },
  { from: "stale", event: "mark-stale" },
  { from: "repaired", event: "mark-stable" },
  { from: "repaired", event: "mark-stale" },
  { from: "repaired", event: "mark-repaired" },
];

function sampleFlow(state: FlowState): FlowSpec {
  return {
    version: 1,
    id: "project.archive",
    name: "Archive an active project",
    objective: "Archive a project and confirm it stays archived",
    state,
    authProfile: "project-owner",
    inputs: {
      projectName: { type: "string", required: true },
    },
    steps: [
      {
        id: "open-project-options",
        intent: "Open the options menu",
        semanticFallback: "Open options for ${projectName}",
        action: "click",
        locator: {
          type: "role",
          role: "button",
          name: "Options for ${projectName}",
        },
      },
      {
        id: "confirm-archive",
        intent: "Confirm archive",
        action: "click",
        locator: {
          type: "testid",
          name: "confirm-archive",
        },
      },
    ],
    assertions: [
      {
        id: "project-hidden",
        type: "not-visible",
        locator: {
          type: "text",
          text: "${projectName}",
        },
      },
    ],
  };
}

function expectIllegal(flow: FlowSpec, event: FlowEvent): void {
  const before = JSON.stringify(flow);
  let thrown: unknown;
  try {
    transition(flow, event);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(QaError);
  if (!(thrown instanceof QaError)) {
    return;
  }
  expect(thrown.code).toBe("FLOW_VALIDATION_FAILED");
  expect(thrown.flowId).toBe(flow.id);
  expect(thrown.message).toContain(flow.state);
  expect(thrown.message).toContain(event);
  expect(JSON.stringify(flow)).toBe(before);
}

for (const edge of EDGES) {
  test(`${edge.from} --${edge.event}--> ${edge.to}`, () => {
    const flow = sampleFlow(edge.from);
    const next = transition(flow, edge.event);

    expect(next).not.toBe(flow);
    expect(next.state).toBe(edge.to);
    expect(flow.state).toBe(edge.from);
    expect({ ...next, state: flow.state }).toEqual(flow);
  });
}

test("rejects draft to stale", () => {
  expectIllegal(sampleFlow("draft"), "mark-stale");
});

test("rejects stale to validated without mark-repaired", () => {
  expectIllegal(sampleFlow("stale"), "validate");
});

test("mark-stale preserves step JSON exactly", () => {
  const flow = sampleFlow("validated");
  const stepJson = JSON.stringify(flow.steps);
  const assertionJson = JSON.stringify(flow.assertions);
  const next = transition(flow, "mark-stale");

  expect(next.state).toBe("stale");
  expect(JSON.stringify(next.steps)).toBe(stepJson);
  expect(JSON.stringify(next.assertions)).toBe(assertionJson);
  expect(next.steps).toEqual(flow.steps);
  expect(next.steps[0]?.locator).toEqual({
    type: "role",
    role: "button",
    name: "Options for ${projectName}",
  });
  expect(next.steps[1]?.locator).toEqual({
    type: "testid",
    name: "confirm-archive",
  });
  expect(next.assertions).toEqual(flow.assertions);
});

for (const pair of ILLEGAL) {
  test(`rejects ${pair.from} on ${pair.event}`, () => {
    expectIllegal(sampleFlow(pair.from), pair.event);
  });
}
