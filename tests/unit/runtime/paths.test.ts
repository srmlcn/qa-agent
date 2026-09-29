import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  appDir,
  authDir,
  browsersDir,
  cacheDir,
  cursorDir,
  ensureHomeLayout,
  homeDir,
  logsDir,
  projectRegistryPath,
  projectsDir,
  userEnvPath,
  userMcpPath,
  userSkillPath,
} from "../../../src/runtime/paths.js";

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.AUTONOMOUS_QA_HOME;
  home = mkdtempSync(join(tmpdir(), "autonomous-qa-home-"));
  process.env.AUTONOMOUS_QA_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.AUTONOMOUS_QA_HOME;
  } else {
    process.env.AUTONOMOUS_QA_HOME = previousHome;
  }
  rmSync(home, { recursive: true, force: true });
});

test("homeDir honors AUTONOMOUS_QA_HOME", () => {
  expect(homeDir()).toBe(home);
});

test("directories stay under the configured home root", () => {
  ensureHomeLayout();

  const paths = [
    homeDir(),
    authDir("project-1"),
    logsDir(),
    cacheDir(),
    browsersDir(),
    projectsDir(),
  ];

  for (const path of paths) {
    expect(path === home || path.startsWith(`${home}${sep}`)).toBe(true);
  }

  expect(readdirSync(home).sort()).toEqual([
    "auth",
    "browsers",
    "cache",
    "logs",
    "projects",
  ]);

  for (const name of ["auth", "browsers", "cache", "logs", "projects"]) {
    const directory = join(home, name);
    const stats = statSync(directory);
    expect(stats.isDirectory()).toBe(true);
    expect(stats.mode & 0o777).toBe(0o700);
  }

  expect(statSync(home).mode & 0o777).toBe(0o700);
  expect(authDir("project-1")).toBe(join(home, "auth", "project-1"));
});

test("app, env, and cursor paths stay beside the configured homes", () => {
  const cursor = mkdtempSync(join(tmpdir(), "autonomous-qa-cursor-"));
  const previous = process.env.AUTONOMOUS_QA_CURSOR_DIR;
  process.env.AUTONOMOUS_QA_CURSOR_DIR = cursor;
  try {
    expect(appDir()).toBe(join(home, "app"));
    expect(userEnvPath()).toBe(join(home, "env"));
    expect(projectRegistryPath()).toBe(join(home, "projects", "registry.json"));
    expect(cursorDir()).toBe(cursor);
    expect(userMcpPath()).toBe(join(cursor, "mcp.json"));
    expect(userSkillPath()).toBe(join(cursor, "skills", "autonomous-qa", "SKILL.md"));
  } finally {
    if (previous === undefined) {
      delete process.env.AUTONOMOUS_QA_CURSOR_DIR;
    } else {
      process.env.AUTONOMOUS_QA_CURSOR_DIR = previous;
    }
    rmSync(cursor, { recursive: true, force: true });
  }
});

test("projectId ../escape throws", () => {
  expect(() => authDir("../escape")).toThrowError(
    new Error("Invalid project id: ../escape"),
  );
});

test("rejects . and an empty project id", () => {
  expect(() => authDir(".")).toThrowError(new Error("Invalid project id: ."));
  expect(() => authDir("")).toThrowError(new Error("Invalid project id: "));
});

test("does not chmod a layout directory through a symlink", () => {
  const outside = mkdtempSync(join(tmpdir(), "autonomous-qa-outside-"));
  chmodSync(outside, 0o755);
  const before = statSync(outside).mode & 0o777;
  symlinkSync(outside, join(home, "logs"));

  expect(() => ensureHomeLayout()).toThrowError(
    new Error(`Refusing to follow a symlink: ${join(home, "logs")}`),
  );
  expect(before).toBe(0o755);
  expect(statSync(outside).mode & 0o777).toBe(0o755);

  rmSync(outside, { recursive: true, force: true });
});
