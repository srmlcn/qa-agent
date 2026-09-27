import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { saveProfile, type StorageState } from "../../../src/auth/store.js";
import { parseFlow, stringifyFlow } from "../../../src/flows/serialize.js";

const COOKIE_VALUE = "fixture-cookie-value-8c1f0a";
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

test("saveProfile writes storage state outside the temporary project", () => {
  const previousHome = process.env.AUTONOMOUS_QA_HOME;
  const home = mkdtempSync(join(tmpdir(), "autonomous-qa-auth-secrecy-home-"));
  const projectRoot = mkdtempSync(
    join(tmpdir(), "autonomous-qa-auth-secrecy-project-"),
  );
  process.env.AUTONOMOUS_QA_HOME = home;

  try {
    mkdirSync(join(projectRoot, ".autonomous-qa", "flows"), { recursive: true });
    writeFileSync(
      join(projectRoot, ".autonomous-qa", "config.yml"),
      "version: 1\n",
    );
    writeFileSync(
      join(projectRoot, ".autonomous-qa", "flows", "archive.yml"),
      "version: 1\nid: project.archive\n",
    );

    const saved = saveProfile("billing", "admin", storageState(), {
      projectRoot,
    });

    expect(resolvesInside(projectRoot, saved.path)).toBe(false);
    expect(readFileSync(saved.path, "utf8")).toContain(COOKIE_VALUE);
    expect(readProjectTree(projectRoot)).not.toContain(COOKIE_VALUE);
  } finally {
    if (previousHome === undefined) {
      delete process.env.AUTONOMOUS_QA_HOME;
    } else {
      process.env.AUTONOMOUS_QA_HOME = previousHome;
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("the serializer drops an unknown cookie key from flow YAML", () => {
  const attempted = {
    ...minimalFlow(),
    cookie: COOKIE_VALUE,
  };
  const flow = parseFlow(JSON.stringify(attempted), "json");
  const yaml = stringifyFlow(flow, "yaml");

  expect(yaml).toContain("id: project.archive");
  expect(yaml).not.toContain(COOKIE_VALUE);
  expect(JSON.stringify(flow)).not.toContain(COOKIE_VALUE);
});

test("gitignore ignores artifacts and runtime but not flows or config", () => {
  const gitignore = readFileSync(join(REPO_ROOT, ".gitignore"), "utf8");

  expect(gitignore).toContain(".autonomous-qa/artifacts/");
  expect(gitignore).toContain(".autonomous-qa/runtime/");
  expect(isGitIgnored(".autonomous-qa/artifacts/")).toBe(true);
  expect(isGitIgnored(".autonomous-qa/runtime/")).toBe(true);
  expect(isGitIgnored(".autonomous-qa/flows/")).toBe(false);
  expect(isGitIgnored(".autonomous-qa/flows/archive.yml")).toBe(false);
  expect(isGitIgnored(".autonomous-qa/config.yml")).toBe(false);
});

function minimalFlow(): Record<string, unknown> {
  return {
    version: 1,
    id: "project.archive",
    name: "Archive an active project",
    objective: "Archive a project",
    inputs: {},
    steps: [],
    assertions: [],
  };
}

function storageState(): StorageState {
  return {
    cookies: [
      {
        name: "session",
        value: COOKIE_VALUE,
        domain: "example.test",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ],
    origins: [],
  };
}

function resolvesInside(parent: string, child: string): boolean {
  const root = realpathSync(parent);
  const target = realpathSync(child);
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

function readProjectTree(directory: string): string {
  const parts: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      parts.push(readProjectTree(path));
    } else if (entry.isFile()) {
      parts.push(readFileSync(path, "utf8"));
    }
  }
  return parts.join("\n");
}

function isGitIgnored(path: string): boolean {
  const result = spawnSync("git", ["check-ignore", "-q", "--", path], {
    cwd: REPO_ROOT,
    stdio: "ignore",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status === 0) {
    return true;
  }
  if (result.status === 1) {
    return false;
  }
  throw new Error(
    `git check-ignore exited ${String(result.status)} for ${path}`,
  );
}
