import { expect, test } from "vitest";
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
