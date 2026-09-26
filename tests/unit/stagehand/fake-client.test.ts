import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import { QaError } from "../../../src/errors/qa-error.js";
import {
  createFakeClient,
  type FakeScriptAction,
} from "../../../src/stagehand/fake-client.js";
import { fromAgentResult } from "../../../src/stagehand/trajectory.js";

const objective = "Archive the active project";

const meta = {
  startedAt: "2026-09-26T19:00:00.000Z",
  endedAt: "2026-09-26T19:00:02.000Z",
};

const script: readonly FakeScriptAction[] = [
  {
    method: "click",
    selector: "//button[@aria-label='Archive']",
    description: "Archive the project",
    arguments: [],
  },
  {
    method: "fill",
    selector: "//input[@name='reason']",
    description: "Enter the archive reason",
    arguments: ["obsolete"],
  },
];

test("a two-step script yields two actions in order", async () => {
  const client = createFakeClient(script);
  const result = await client.run(objective);
  const trajectory = fromAgentResult(result, meta);

  expect(result.actions.map((action) => action.method)).toEqual([
    "click",
    "fill",
  ]);
  expect(result.actions.map((action) => action.description)).toEqual([
    "Archive the project",
    "Enter the archive reason",
  ]);
  expect(trajectory.actions).toHaveLength(2);
  expect(trajectory.actions.map((action) => action.index)).toEqual([0, 1]);
  expect(trajectory.actions[0]).toEqual({
    index: 0,
    kind: "act",
    instruction: "Archive the project",
    action: "Archive the project",
    selector: "//button[@aria-label='Archive']",
    method: "click",
    urlBefore: "",
    urlAfter: "",
    arguments: [],
  });
  expect(trajectory.actions[1]).toEqual({
    index: 1,
    kind: "act",
    instruction: "Enter the archive reason",
    action: "Enter the archive reason",
    selector: "//input[@name='reason']",
    method: "fill",
    urlBefore: "",
    urlAfter: "",
    arguments: ["obsolete"],
  });
  expect(trajectory.success).toBe(true);
  expect(trajectory.note).toBe(objective);
  expect(JSON.stringify(trajectory.actions)).not.toContain(objective);
});

test("no fetch is called", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("fetch was called");
  });

  try {
    const client = createFakeClient(script);
    await client.run(objective);
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
  }
});

test("the rate-limit script throws LLM_RATE_LIMITED", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("fetch was called");
  });

  try {
    const client = createFakeClient(() => {
      throw "rate-limit";
    });

    await expect(client.run(objective)).rejects.toBeInstanceOf(QaError);
    await expect(client.run(objective)).rejects.toMatchObject({
      code: "LLM_RATE_LIMITED",
      recoveryAppropriate: false,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
  }
});

test("the module does not import a real provider key", () => {
  const source = readFileSync(
    new URL("../../../src/stagehand/fake-client.ts", import.meta.url),
    "utf8",
  );
  const importLines = source
    .split("\n")
    .filter((line) => line.trimStart().startsWith("import"));

  expect(importLines.join("\n")).not.toMatch(
    /openai|anthropic|browserbase|api[_-]?key|process\.env/i,
  );
  expect(source).not.toMatch(/process\.env/);
  expect(source).not.toMatch(
    /OPENAI_API_KEY|ANTHROPIC_API_KEY|BROWSERBASE_API_KEY|COMPANY_LLM_API_KEY/,
  );
});
