import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { userEnvPath } from "../../../src/runtime/paths.js";
import { loadUserEnv, parseEnvAssignments } from "../../../src/runtime/user-env.js";

const SECRET = "env-file-secret-4c91e2-do-not-print";
const homes: string[] = [];
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.AUTONOMOUS_QA_HOME;
  const home = mkdtempSync(join(tmpdir(), "qa-user-env-"));
  homes.push(home);
  process.env.AUTONOMOUS_QA_HOME = home;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousHome === undefined) {
    delete process.env.AUTONOMOUS_QA_HOME;
  } else {
    process.env.AUTONOMOUS_QA_HOME = previousHome;
  }
  delete process.env.QA_USER_ENV_KEY;
  delete process.env.QA_USER_ENV_OTHER;
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

test("parse keeps quoted values and skips blanks, comments, and empty values", () => {
  expect(
    parseEnvAssignments(`
# comment
QA_USER_ENV_KEY=${SECRET}
EMPTY=
QUOTED="spaced value"
BAD NAME=nope
`),
  ).toEqual([
    { name: "QA_USER_ENV_KEY", value: SECRET },
    { name: "QUOTED", value: "spaced value" },
  ]);
});

test("load sets an unset name and does not print the value", () => {
  writeEnv(`QA_USER_ENV_KEY=${SECRET}\n`);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const log = vi.spyOn(console, "log").mockImplementation(() => {});

  loadUserEnv();

  expect(process.env.QA_USER_ENV_KEY).toBe(SECRET);
  expect(error).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
  expect(error.mock.calls.join("\n")).not.toContain(SECRET);
  expect(log.mock.calls.join("\n")).not.toContain(SECRET);
});

test("load does not replace a name that is already set", () => {
  process.env.QA_USER_ENV_KEY = "already-set";
  writeEnv(`QA_USER_ENV_KEY=${SECRET}\nQA_USER_ENV_OTHER=other\n`);

  loadUserEnv();

  expect(process.env.QA_USER_ENV_KEY).toBe("already-set");
  expect(process.env.QA_USER_ENV_OTHER).toBe("other");
});

test("load skips a symlink and a group-readable file without printing the value", () => {
  const outside = mkdtempSync(join(tmpdir(), "qa-user-env-outside-"));
  homes.push(outside);
  const target = join(outside, "secret.env");
  writeFileSync(target, `QA_USER_ENV_KEY=${SECRET}\n`, { mode: 0o600 });
  symlinkSync(target, userEnvPath());
  const error = vi.spyOn(console, "error").mockImplementation(() => {});

  loadUserEnv();

  expect(process.env.QA_USER_ENV_KEY).toBeUndefined();
  expect(error.mock.calls.join("\n")).not.toContain(SECRET);

  rmSync(userEnvPath());
  writeEnv(`QA_USER_ENV_KEY=${SECRET}\n`, 0o644);
  loadUserEnv();

  expect(process.env.QA_USER_ENV_KEY).toBeUndefined();
  expect(error.mock.calls.join("\n")).not.toContain(SECRET);
});

function writeEnv(contents: string, mode = 0o600): void {
  writeFileSync(userEnvPath(), contents, { encoding: "utf8", mode });
  chmodSync(userEnvPath(), mode);
}
