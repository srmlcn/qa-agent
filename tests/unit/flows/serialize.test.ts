import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { QaError } from "../../../src/errors/qa-error.js";
import { parseFlow, stringifyFlow } from "../../../src/flows/serialize.js";

const fixturePath = new URL("./fixtures/archive-project.yml", import.meta.url);

function readArchiveSample(): string {
  return readFileSync(fixturePath, "utf8");
}

test("the archive sample round-trips YAML without dropping semanticFallback", () => {
  const flow = parseFlow(readArchiveSample(), "yaml");
  const yaml = stringifyFlow(flow, "yaml");

  expect(yaml).toContain("semanticFallback");
  expect(yaml).toContain("${projectName}");
  expect(yaml).toContain(
    "Find and open the actions or options menu associated with",
  );

  const again = parseFlow(yaml, "yaml");
  expect(again).toEqual(flow);
  expect(again.steps.map((step) => step.semanticFallback)).toEqual(
    flow.steps.map((step) => step.semanticFallback),
  );
  for (const step of again.steps) {
    expect(step.semanticFallback).toEqual(expect.any(String));
    expect(step.semanticFallback?.length).toBeGreaterThan(0);
  }
});

test("the archive sample round-trips through JSON", () => {
  const flow = parseFlow(readArchiveSample(), "yaml");
  const json = stringifyFlow(flow, "json");
  const again = parseFlow(json, "json");

  expect(again).toEqual(flow);
  expect(parseFlow(stringifyFlow(again, "yaml"), "yaml")).toEqual(flow);
});

test("invalid flow text throws FLOW_VALIDATION_FAILED", () => {
  expectFlowValidation(() => parseFlow("{", "json"));
  expectFlowValidation(() => parseFlow("version: 2\n", "yaml"));
  expectFlowValidation(() =>
    stringifyFlow(
      {
        version: 1,
        id: "not a valid id",
        name: "Broken",
        objective: "Broken",
        state: "draft",
        inputs: {},
        steps: [],
        assertions: [],
      },
      "json",
    ),
  );
});

test("serializer sources do not evaluate strings or load a template engine", () => {
  assertNoEvaluation(new URL("../../../src/flows/serialize.ts", import.meta.url));
  assertNoEvaluation(
    new URL("../../../src/flows/interpolate.ts", import.meta.url),
  );
});

function expectFlowValidation(run: () => unknown): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(QaError);
    if (error instanceof QaError) {
      expect(error.code).toBe("FLOW_VALIDATION_FAILED");
      expect(error.recoveryAppropriate).toBe(false);
    }
    return;
  }
  throw new Error("expected FLOW_VALIDATION_FAILED");
}

function assertNoEvaluation(url: URL): void {
  const source = readFileSync(url, "utf8");
  const forbidden = [
    /\beval\s*\(/,
    /\bnew\s+Function\b/,
    /\bFunction\s*\(/,
    /handlebars/i,
    /mustache/i,
    /\bejs\b/,
    /nunjucks/i,
  ];
  for (const pattern of forbidden) {
    expect(source).not.toMatch(pattern);
  }
}
