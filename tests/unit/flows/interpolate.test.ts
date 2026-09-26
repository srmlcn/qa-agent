import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { QaError } from "../../../src/errors/qa-error.js";
import { parseFlowSpec, type FlowSpec } from "../../../src/flows/schema.js";
import { parseFlow, stringifyFlow } from "../../../src/flows/serialize.js";
import { interpolateFlow } from "../../../src/flows/interpolate.js";

const fixturePath = new URL("./fixtures/archive-project.yml", import.meta.url);

function clickFlow(name: string, inputs: FlowSpec["inputs"] = {
  projectName: { type: "string", required: true },
}): FlowSpec {
  return parseFlowSpec({
    version: 1,
    id: "project.archive",
    name: "Archive an active project",
    objective: "Archive ${projectName}",
    inputs,
    steps: [
      {
        id: "open-project-options",
        intent: "Open options for ${projectName}",
        action: "click",
        semanticFallback: "Open the menu for ${projectName}.",
        locator: {
          type: "role",
          role: "button",
          name,
        },
      },
    ],
    assertions: [
      {
        id: "project-not-active",
        type: "not-visible",
        locator: {
          type: "text",
          text: "${projectName}",
        },
      },
    ],
  });
}

test("${projectName} inside a role name becomes the provided string", () => {
  const flow = parseFlow(readFileSync(fixturePath, "utf8"), "yaml");
  const result = interpolateFlow(flow, { projectName: "Northwind" });
  const step = result.steps[0];

  expect(step).toMatchObject({
    action: "click",
    intent: "Open the options menu for the target project.",
    locator: {
      type: "role",
      role: "button",
      name: "Options for Northwind",
    },
  });
  expect(step?.semanticFallback).toContain("Northwind");
  expect(step?.semanticFallback).not.toContain("${projectName}");
  expect(result.assertions[0]).toMatchObject({
    locator: { type: "text", text: "Northwind" },
  });
  expect(result.assertions[1]).toMatchObject({
    type: "sequence",
    sequence: [
      { action: "reload" },
      {
        type: "not-visible",
        locator: { type: "text", text: "Northwind" },
      },
    ],
  });
  expect(flow.steps[0]).toMatchObject({
    locator: { name: "Options for ${projectName}" },
  });
});

test("a value containing ${ that is not a declared input fails", () => {
  expectFlowValidation(() =>
    interpolateFlow(clickFlow("Cost is ${price}"), { projectName: "Northwind" }),
  );
  expectFlowValidation(() =>
    interpolateFlow(clickFlow("Cost is ${"), { projectName: "Northwind" }),
  );
  expectFlowValidation(() =>
    interpolateFlow(clickFlow("Cost is ${projectName|upper}"), {
      projectName: "Northwind",
    }),
  );
});

test("input values are inserted as literal text on the parsed object", () => {
  const injected = "foo\nbar: injected";
  const flow = clickFlow("Options for ${projectName}");
  const result = interpolateFlow(flow, { projectName: injected });
  const step = result.steps[0];

  expect(step).toMatchObject({
    locator: {
      type: "role",
      role: "button",
      name: `Options for ${injected}`,
    },
  });

  const yaml = stringifyFlow(result, "yaml");
  const again = parseFlow(yaml, "yaml");
  expect(again.steps[0]).toMatchObject({
    locator: { name: `Options for ${injected}` },
  });
  expect(again).not.toHaveProperty("bar");
  expect(JSON.stringify(again)).not.toContain('"bar"');
});

test("inserted text is not evaluated or interpolated again", () => {
  const flow = clickFlow("Options for ${projectName}");
  const result = interpolateFlow(flow, {
    projectName: "${admin} 1+1 $&",
  });

  expect(result.steps[0]).toMatchObject({
    locator: { name: "Options for ${admin} 1+1 $&" },
  });
  expect(result.objective).toBe("Archive ${projectName}");
});

test("a missing required input fails", () => {
  const flow = clickFlow("Options for ${projectName}");
  expectFlowValidation(() => interpolateFlow(flow, {}));
  expect(flow.steps[0]).toMatchObject({
    locator: { name: "Options for ${projectName}" },
  });
});

test("an input whose runtime type disagrees with the schema fails", () => {
  const flow = clickFlow("Options for ${projectName}");
  expectFlowValidation(() => interpolateFlow(flow, { projectName: 12 }));
  expectFlowValidation(() =>
    interpolateFlow(
      clickFlow("Count ${count}", {
        count: { type: "number", required: true },
      }),
      { count: "4" },
    ),
  );
  expectFlowValidation(() =>
    interpolateFlow(
      clickFlow("Flag ${flag}", {
        flag: { type: "boolean", required: true },
      }),
      { flag: "true" },
    ),
  );
});

test("declared optional inputs with a default are used when omitted", () => {
  const withDefault = clickFlow("Options for ${projectName}", {
    projectName: { type: "string", required: false, default: "Demo" },
  });
  const omittedRequired = clickFlow("Options for ${projectName}", {
    projectName: { type: "string", default: "Demo" },
  });

  expect(interpolateFlow(withDefault, {}).steps[0]).toMatchObject({
    locator: { name: "Options for Demo" },
    semanticFallback: "Open the menu for Demo.",
  });
  expect(interpolateFlow(omittedRequired, {}).steps[0]).toMatchObject({
    locator: { name: "Options for Demo" },
  });
  expect(interpolateFlow(withDefault, { projectName: "Live" }).steps[0]).toMatchObject({
    locator: { name: "Options for Live" },
  });
});

test("number and boolean inputs are inserted as literal text", () => {
  const flow = parseFlowSpec({
    version: 1,
    id: "project.archive",
    name: "Archive an active project",
    objective: "Archive a project",
    inputs: {
      count: { type: "number", required: true },
      flag: { type: "boolean", required: false, default: false },
    },
    steps: [
      {
        id: "open",
        intent: "Open the page",
        action: "goto",
        value: "/items?count=${count}&flag=${flag}",
      },
    ],
    assertions: [],
  });

  expect(interpolateFlow(flow, { count: 0 }).steps[0]).toMatchObject({
    value: "/items?count=0&flag=false",
  });
});

test("an optional input with no value fails only when referenced", () => {
  const referenced = clickFlow("Options for ${nickname}", {
    projectName: { type: "string", required: true },
    nickname: { type: "string", required: false },
  });
  const unused = clickFlow("Options for ${projectName}", {
    projectName: { type: "string", required: true },
    nickname: { type: "string", required: false },
  });

  expectFlowValidation(() =>
    interpolateFlow(referenced, { projectName: "Northwind" }),
  );
  expect(
    interpolateFlow(unused, { projectName: "Northwind" }).steps[0],
  ).toMatchObject({
    locator: { name: "Options for Northwind" },
  });
});

function expectFlowValidation(run: () => unknown): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(QaError);
    if (error instanceof QaError) {
      expect(error.code).toBe("FLOW_VALIDATION_FAILED");
      expect(error.flowId).toBe("project.archive");
      expect(error.recoveryAppropriate).toBe(false);
    }
    return;
  }
  throw new Error("expected FLOW_VALIDATION_FAILED");
}
