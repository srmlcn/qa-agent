import { Buffer } from "node:buffer";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  attach,
  createRunDir,
  readRun,
  writeRun,
} from "../../../src/evidence/store.js";
import type { RunResult } from "../../../src/evidence/types.js";

const RUN_ID = "run-12345678";
const HEADER_SECRET = "Bearer header-unique-secret";
const COOKIE_SECRET = "session=cookie-unique-secret";
const BODY_SECRET = "pw-unique-secret";
const TAIL_SECRET = "UNIQUE_TAIL_SECRET";
const CONSOLE_SECRET = "console-unique-secret";
const PNG_MARKER = "png-not-embedded-9f3a";
const TRACE_MARKER = "trace-zip-not-embedded-9f3a";
const MAX_RESPONSE_BODY_BYTES = 262144;

let scratch: string;
let projectRoot: string;
let tempHome: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.AUTONOMOUS_QA_HOME;
  scratch = mkdtempSync(join(tmpdir(), "aqa-store-"));
  projectRoot = join(scratch, "home", "alice", "repo");
  tempHome = join(scratch, "aqa-home");
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

test("rejects a run id of ../escape", () => {
  expect(() => createRunDir(projectRoot, "../escape")).toThrow(
    /Invalid run id/,
  );
  expect(() => readRun(projectRoot, "../escape")).toThrow(/Invalid run id/);
  expect(() => writeRun(projectRoot, minimalResult("../escape"))).toThrow(
    /Invalid run id/,
  );
  expect(() => createRunDir(projectRoot, "abc/defghij")).toThrow(
    /Invalid run id/,
  );
  expect(() => createRunDir(projectRoot, "abc\\defghij")).toThrow(
    /Invalid run id/,
  );
  expect(existsSync(join(projectRoot, ".autonomous-qa"))).toBe(false);
  expect(existsSync(join(scratch, "escape"))).toBe(false);
});

test("result.json contains relative screenshot paths and no authorization header value", () => {
  const runDir = createRunDir(projectRoot, RUN_ID);
  const png = Buffer.from(`\x89PNG\r\n\x1a\n${PNG_MARKER}`);
  const trace = Buffer.from(TRACE_MARKER);
  const pngPath = join(runDir, "checkpoint.png");
  const tracePath = join(runDir, "trace.zip");
  writeFileSync(pngPath, png);
  writeFileSync(tracePath, trace);

  const result = sensitiveResult({
    screenshots: [pngPath],
    trace: tracePath,
  });
  writeRun(projectRoot, result);
  expect(result.network.failedRequests[0]?.headers.authorization).toBe(
    HEADER_SECRET,
  );

  const attached = sensitiveResult({ screenshots: [], trace: undefined });
  const absolutePaths = attach(attached, {
    screenshots: [pngPath],
    trace: tracePath,
  });
  expect(attached.artifacts.screenshots).toEqual(["checkpoint.png"]);
  expect(attached.artifacts.trace).toBe("trace.zip");
  expect(absolutePaths.screenshots).toEqual([pngPath]);
  expect(absolutePaths.trace).toBe(tracePath);
  expect(JSON.stringify(attached)).not.toContain(projectRoot);
  expect(JSON.stringify(attached)).not.toContain(`${sep}alice${sep}`);
  const jsonPath = join(runDir, "result.json");
  const json = readFileSync(jsonPath, "utf8");
  const parsed = JSON.parse(json) as {
    artifacts: { screenshots: string[]; trace?: string };
    network: {
      failedRequests: Array<{ headers: Record<string, string>; body?: string }>;
    };
  };

  expect(parsed.artifacts.screenshots).toEqual(["checkpoint.png"]);
  expect(parsed.artifacts.trace).toBe("trace.zip");
  expect(json).not.toContain(pngPath);
  expect(json).not.toContain(projectRoot);
  expect(json).not.toContain(`${sep}alice${sep}`);
  expect(json).not.toContain(HEADER_SECRET);
  expect(json).not.toContain("header-unique-secret");
  expect(json).not.toContain(COOKIE_SECRET);
  expect(json).not.toContain(BODY_SECRET);
  expect(json).not.toContain(TAIL_SECRET);
  expect(json).not.toContain(CONSOLE_SECRET);
  expect(json).not.toContain(PNG_MARKER);
  expect(json).not.toContain(TRACE_MARKER);
  expect(parsed.network.failedRequests[0]?.headers.authorization).toBe(
    "[redacted]",
  );
  expect(parsed.network.failedRequests[0]?.headers.cookie).toBe("[redacted]");
  expect(parsed.network.failedRequests[0]?.headers.accept).toBe(
    "application/json",
  );
  expect(readFileSync(pngPath)).toEqual(png);
  expect(readdirSync(runDir).sort()).toEqual([
    "checkpoint.png",
    "result.json",
    "trace.zip",
  ]);
  expect(existsSync(join(tempHome, "auth"))).toBe(false);
});

test("readRun returns the same status that was written", () => {
  const runDir = createRunDir(projectRoot, RUN_ID);
  const pngPath = join(runDir, "checkpoint.png");
  writeFileSync(pngPath, Buffer.from(PNG_MARKER));
  const result = sensitiveResult({ screenshots: ["checkpoint.png"] });
  expect(result.status).toBe("failed");

  writeRun(projectRoot, result);

  expect(readRun(projectRoot, RUN_ID).status).toBe("failed");
  expect(readRun(projectRoot, RUN_ID).status).toBe(result.status);
  const stored = readRun(projectRoot, RUN_ID);
  expect(stored.network.responses[0]?.body?.endsWith("\n[truncated]")).toBe(
    true,
  );
  expect(stored.network.responses[0]?.body).not.toContain(TAIL_SECRET);
  expect(stored.network.failedRequests[0]?.body).not.toContain(BODY_SECRET);
  expect(stored.console.errors[0]?.text).toBe("Authorization: [redacted]");
});

test("artifact directory is under the project artifacts tree, not under the home auth directory", () => {
  const runDir = createRunDir(projectRoot, RUN_ID);
  const projectArtifacts = join(
    projectRoot,
    ".autonomous-qa",
    "artifacts",
    RUN_ID,
  );
  const homeAuth = join(homedir(), ".autonomous-qa", "auth");
  const configuredAuth = join(tempHome, "auth");

  expect(runDir).toBe(projectArtifacts);
  expect(runDir.startsWith(`${join(projectRoot, ".autonomous-qa", "artifacts")}${sep}`)).toBe(
    true,
  );
  expect(isUnder(homeAuth, runDir)).toBe(false);
  expect(isUnder(configuredAuth, runDir)).toBe(false);
  expect(statSync(runDir).isDirectory()).toBe(true);
  expect(statSync(runDir).mode & 0o777).toBe(0o700);

  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
  const gitignore = readFileSync(join(packageRoot, ".gitignore"), "utf8");
  expect(gitignore).toContain(".autonomous-qa/artifacts/");
  expect(existsSync(configuredAuth)).toBe(false);
});

test("attach keeps absolute paths in process and rejects traversal", () => {
  const runDir = createRunDir(projectRoot, RUN_ID);
  const pngPath = join(runDir, "checkpoint.png");
  writeFileSync(pngPath, Buffer.from(PNG_MARKER));
  const outside = join(scratch, "outside.png");
  writeFileSync(outside, Buffer.from("outside-secret-bytes"));
  symlinkSync(outside, join(runDir, "linked.png"));

  const result = minimalResult(RUN_ID);
  expect(() =>
    attach(result, { screenshots: [join(runDir, "linked.png")] }),
  ).toThrow(/Invalid artifact path/);
  expect(result.artifacts.screenshots).toEqual([]);

  expect(() =>
    writeRun(projectRoot, {
      ...minimalResult(RUN_ID),
      artifacts: { screenshots: ["../escape.png"] },
    }),
  ).toThrow(/Invalid artifact path/);
  expect(existsSync(join(runDir, "result.json"))).toBe(false);
  expect(existsSync(join(projectRoot, ".autonomous-qa", "escape.png"))).toBe(
    false,
  );
});

test("an oversized response keeps bodyOmitted through write and read", () => {
  const result = minimalResult(RUN_ID);
  result.network.responses.push({
    method: "GET",
    url: "https://app.example/oversized",
    status: 200,
    timing: 5,
    headers: { "content-type": "text/plain" },
    bodyOmitted: true,
  });

  writeRun(projectRoot, result);

  const stored = readRun(projectRoot, RUN_ID);
  const response = stored.network.responses[0];
  expect(response?.body).toBeUndefined();
  expect(Object.hasOwn(response ?? {}, "body")).toBe(false);
  expect(response?.bodyOmitted).toBe(true);
  expect(JSON.stringify(stored)).not.toContain("oversized-body-secret");
});

test("readRun rejects a bodyOmitted value other than true", () => {
  const runDir = createRunDir(projectRoot, RUN_ID);
  writeRun(projectRoot, minimalResult(RUN_ID));
  const filePath = join(runDir, "result.json");
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
    network: { responses: Array<Record<string, unknown>> };
  };
  parsed.network.responses.push({
    method: "GET",
    url: "https://app.example/oversized",
    status: 200,
    timing: 1,
    headers: {},
    bodyOmitted: false,
  });
  writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`);

  expect(() => readRun(projectRoot, RUN_ID)).toThrow(
    /Invalid run result field: network\.responses\.0\.bodyOmitted/,
  );
});

test("run id length and separator rules reject unsafe ids", () => {
  expect(() => createRunDir(projectRoot, "abc")).toThrow(/Invalid run id/);
  expect(() => createRunDir(projectRoot, "a".repeat(81))).toThrow(
    /Invalid run id/,
  );
  expect(() => createRunDir(projectRoot, "abcd.efgh")).toThrow(
    /Invalid run id/,
  );
  const boundary = "a".repeat(80);
  const runDir = createRunDir(projectRoot, boundary);
  expect(runDir.endsWith(`${sep}${boundary}`)).toBe(true);
  expect(statSync(runDir).mode & 0o777).toBe(0o700);
});

function minimalResult(runId: string): RunResult {
  return {
    runId,
    flowId: "archive-project",
    status: "passed",
    startedAt: "2026-09-26T19:00:00.000Z",
    durationMs: 10,
    steps: [],
    network: { failedRequests: [], responses: [] },
    console: { errors: [], warnings: [] },
    pageErrors: [],
    artifacts: { screenshots: [] },
  };
}

function sensitiveResult(artifacts: RunResult["artifacts"]): RunResult {
  return {
    runId: RUN_ID,
    flowId: "archive-project",
    status: "failed",
    startedAt: "2026-09-26T19:00:00.000Z",
    durationMs: 1500,
    steps: [
      {
        stepId: "archive",
        status: "failed",
        startedAt: "2026-09-26T19:00:00.400Z",
        durationMs: 1100,
        error: "project still visible",
      },
    ],
    network: {
      failedRequests: [
        {
          method: "POST",
          url: "https://app.example/api/archive",
          status: 500,
          timing: 80,
          body: `{"password":"${BODY_SECRET}"}`,
          headers: {
            authorization: HEADER_SECRET,
            cookie: COOKIE_SECRET,
            accept: "application/json",
          },
        },
      ],
      responses: [
        {
          method: "GET",
          url: "https://app.example/projects",
          status: 200,
          timing: 40,
          body: `${"a".repeat(MAX_RESPONSE_BODY_BYTES + 32)}${TAIL_SECRET}`,
          headers: { "content-type": "application/json" },
        },
      ],
    },
    console: {
      errors: [
        {
          level: "error",
          text: `Authorization: Bearer ${CONSOLE_SECRET}`,
        },
      ],
      warnings: [],
    },
    pageErrors: [],
    artifacts,
    failure: {
      stepId: "archive",
      category: "assertion",
      message: "project still visible",
    },
  };
}

function isUnder(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${sep}`);
}
