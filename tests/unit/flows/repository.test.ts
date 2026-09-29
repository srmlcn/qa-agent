import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { QaError } from "../../../src/errors/qa-error.js";
import { list, read, save } from "../../../src/flows/repository.js";
import { parseFlowSpec, type FlowSpec } from "../../../src/flows/schema.js";
import { stringifyFlow } from "../../../src/flows/serialize.js";

let scratch: string;
let projectRoot: string;
let tempHome: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.AUTONOMOUS_QA_HOME;
  scratch = mkdtempSync(join(tmpdir(), "aqa-flows-"));
  projectRoot = join(scratch, "project");
  tempHome = join(scratch, "home");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(tempHome, { recursive: true });
  process.env.AUTONOMOUS_QA_HOME = tempHome;
});

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.AUTONOMOUS_QA_HOME;
  } else {
    process.env.AUTONOMOUS_QA_HOME = previousHome;
  }
  rmSync(scratch, { recursive: true, force: true });
});

test("save then list then read returns the same steps", () => {
  const flow = sampleFlow();
  save(projectRoot, flow);

  const flowsDir = homeFlowsDir();
  const filePath = join(flowsDir, "project--archive.yml");
  expect(existsSync(join(projectRoot, ".autonomous-qa"))).toBe(false);
  expect(readFileSync(filePath, "utf8")).toBe(stringifyFlow(flow, "yaml"));
  expect(existsSync(join(flowsDir, "project.archive.yml"))).toBe(false);
  expect(existsSync(join(flowsDir, "project", "archive.yml"))).toBe(false);

  const listed = list(projectRoot);
  expect(listed).toEqual([
    {
      id: "project.archive",
      name: "Archive an active project",
      state: "validated",
      authProfile: "project-owner",
    },
  ]);
  expect(listed[0]).not.toHaveProperty("steps");
  expect(JSON.stringify(listed)).not.toContain("steps");

  const loaded = read(projectRoot, flow.id);
  expect(loaded.steps).toEqual(flow.steps);
  expect(loaded).toEqual(flow);
  expect(existsSync(join(tempHome, "auth"))).toBe(false);
  expect(existsSync(join(homedir(), ".autonomous-qa", "auth", "project--archive.yml"))).toBe(
    false,
  );
});

test("dotted and hyphenated flow ids round-trip in distinct files", () => {
  const dotted = sampleFlow({ id: "a.b.c", name: "Dotted id" });
  const hyphenated = sampleFlow({ id: "a.b--c", name: "Hyphenated id" });
  save(projectRoot, dotted);
  save(projectRoot, hyphenated);

  const flowsDir = homeFlowsDir();
  expect(readdirSync(flowsDir).sort()).toEqual(["a--b--c.yml", "a--b__c.yml"]);
  expect(readFileSync(join(flowsDir, "a--b--c.yml"), "utf8")).toBe(
    stringifyFlow(dotted, "yaml"),
  );
  expect(readFileSync(join(flowsDir, "a--b__c.yml"), "utf8")).toBe(
    stringifyFlow(hyphenated, "yaml"),
  );
  expect(read(projectRoot, dotted.id)).toEqual(dotted);
  expect(read(projectRoot, hyphenated.id)).toEqual(hyphenated);
  expect(list(projectRoot).map((item) => item.id).sort()).toEqual([
    "a.b--c",
    "a.b.c",
  ]);
});

test("a legacy hyphenated filename is listed, read, and rewritten on save", () => {
  const flow = sampleFlow({ id: "a.b-c", name: "Legacy hyphen" });
  const flowsDir = join(projectRoot, ".autonomous-qa", "flows");
  mkdirSync(flowsDir, { recursive: true });
  const legacyPath = join(flowsDir, "a--b-c.yml");
  writeFileSync(legacyPath, stringifyFlow(flow, "yaml"));

  expect(read(projectRoot, flow.id)).toEqual(flow);
  expect(list(projectRoot).map((item) => item.id)).toEqual(["a.b-c"]);

  const updated = sampleFlow({ id: "a.b-c", name: "Rewritten hyphen" });
  save(projectRoot, updated);

  expect(existsSync(legacyPath)).toBe(false);
  expect(readdirSync(flowsDir)).toEqual(["a--b_c.yml"]);
  expect(read(projectRoot, flow.id)).toEqual(updated);
  expect(readFileSync(join(flowsDir, "a--b_c.yml"), "utf8")).toBe(
    stringifyFlow(updated, "yaml"),
  );
});

test("list payloads have no steps key", () => {
  save(projectRoot, sampleFlow());
  save(projectRoot, sampleFlow({ id: "project.create", name: "Create a project" }));

  const listed = list(projectRoot);
  expect(listed.map((item) => item.id)).toEqual([
    "project.archive",
    "project.create",
  ]);
  for (const item of listed) {
    expect(Object.keys(item).sort()).toEqual(
      ["authProfile", "id", "name", "state"].sort(),
    );
    expect(item).not.toHaveProperty("steps");
    expect(item).not.toHaveProperty("assertions");
    expect(item).not.toHaveProperty("inputs");
  }
  expect(list(join(scratch, "empty"))).toEqual([]);
});

test("a path traversal in the id does not create a file outside flows", () => {
  const outside = join(scratch, "outside.yml");
  const flow = sampleFlow();
  const traversals = [
    "../outside",
    "..",
    ".",
    "foo/bar",
    "foo/../../../outside",
    "project.archive/../../outside",
    "..\\..\\outside",
    "/tmp/outside",
    "Project.Archive",
  ];

  for (const id of traversals) {
    expect(() => save(projectRoot, { ...flow, id })).toThrow(QaError);
    expect(() => read(projectRoot, id)).toThrow(QaError);
    try {
      save(projectRoot, { ...flow, id });
    } catch (error) {
      expect(error).toBeInstanceOf(QaError);
      if (error instanceof QaError) {
        expect(error.code).toBe("FLOW_VALIDATION_FAILED");
      }
    }
  }

  expect(existsSync(outside)).toBe(false);
  expect(existsSync(join(projectRoot, "outside.yml"))).toBe(false);
  expect(existsSync(join(projectRoot, ".autonomous-qa", "outside.yml"))).toBe(
    false,
  );
  expect(filesUnder(scratch)).toEqual([]);
  expect(existsSync(join(tempHome, "auth"))).toBe(false);
});

test("an existing file is replaced without leaving a temp file", () => {
  const flow = sampleFlow();
  save(projectRoot, flow);
  const updated = sampleFlow({ name: "Archive renamed" });
  save(projectRoot, updated);

  const flowsDir = homeFlowsDir();
  expect(readdirSync(flowsDir)).toEqual(["project--archive.yml"]);
  expect(filesUnder(projectRoot).some((file) => file.endsWith(".tmp"))).toBe(
    false,
  );
  expect(read(projectRoot, flow.id).name).toBe("Archive renamed");
  expect(read(projectRoot, flow.id).steps).toEqual(updated.steps);
  expect(readFileSync(join(flowsDir, "project--archive.yml"), "utf8")).toBe(
    stringifyFlow(updated, "yaml"),
  );
});

test("a missing flow throws FLOW_VALIDATION_FAILED with the id", () => {
  let caught: unknown;
  try {
    read(projectRoot, "project.missing");
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(QaError);
  if (!(caught instanceof QaError)) {
    return;
  }
  expect(caught.code).toBe("FLOW_VALIDATION_FAILED");
  expect(caught.message).toContain("project.missing");
  expect(caught).not.toMatchObject({ code: "ENOENT" });
});

test("an existing .autonomous-qa directory keeps flows in the repo", () => {
  mkdirSync(join(projectRoot, ".autonomous-qa"));
  const flow = sampleFlow();
  save(projectRoot, flow);

  const flowsDir = join(projectRoot, ".autonomous-qa", "flows");
  expect(existsSync(join(flowsDir, "project--archive.yml"))).toBe(true);
  expect(existsSync(homeFlowsDir())).toBe(false);
  expect(read(projectRoot, flow.id)).toEqual(flow);
});

test("a symlinked home project directory is refused", () => {
  const outside = join(scratch, "outside-flows");
  mkdirSync(outside, { recursive: true });
  const projectState = join(tempHome, "projects", "project");
  mkdirSync(join(tempHome, "projects"), { recursive: true });
  symlinkSync(outside, projectState);

  expect(() => save(projectRoot, sampleFlow())).toThrow(QaError);
  expect(readdirSync(outside)).toEqual([]);
  expect(existsSync(join(projectRoot, ".autonomous-qa"))).toBe(false);
});

test("save refuses a project root inside the auth directory", () => {
  const authProject = join(tempHome, "auth", "proj");
  mkdirSync(authProject, { recursive: true });

  expect(() => save(authProject, sampleFlow())).toThrow(QaError);
  expect(existsSync(join(authProject, ".autonomous-qa"))).toBe(false);
  expect(filesUnder(join(tempHome, "auth"))).toEqual([]);
});

function homeFlowsDir(): string {
  return join(tempHome, "projects", "project", "flows");
}

function sampleFlow(overrides: Partial<FlowSpec> = {}): FlowSpec {
  return parseFlowSpec({
    version: 1,
    id: "project.archive",
    name: "Archive an active project",
    objective: "Archive a project and keep the archived state.",
    state: "validated",
    authProfile: "project-owner",
    inputs: {
      projectName: { type: "string", required: true },
    },
    steps: [
      {
        id: "open-project-options",
        intent: "Open the options menu for the target project.",
        action: "click",
        locator: {
          type: "role",
          role: "button",
          name: "Options for ${projectName}",
        },
        semanticFallback:
          "Find and open the actions menu for ${projectName}.",
      },
      {
        id: "confirm-archive",
        intent: "Confirm that the project should be archived.",
        action: "click",
        locator: {
          type: "role",
          role: "button",
          name: "Archive project",
        },
        semanticFallback: "Confirm the archive operation.",
      },
    ],
    assertions: [],
    ...overrides,
  });
}

function filesUnder(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...filesUnder(fullPath));
      continue;
    }
    files.push(fullPath);
  }
  return files;
}
