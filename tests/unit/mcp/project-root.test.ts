import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { QaError } from "../../../src/errors/qa-error.js";
import {
  resetRootLister,
  resolveProjectRoot,
  setRootLister,
} from "../../../src/mcp/project-root.js";

const roots: string[] = [];

afterEach(() => {
  resetRootLister();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no client roots fall back to the working directory", async () => {
  const cwd = process.cwd();
  await expect(resolveProjectRoot(undefined)).resolves.toBe(cwd);
});

test("an explicit path without client roots is rejected", async () => {
  const error = await rejectedRoot("/tmp");
  expect(error.message).toBe("projectRoot requires a workspace root");
});

test("one client root is used instead of the working directory", async () => {
  const root = createDir("qa-root-one-");
  setRootLister(async () => [root]);

  await expect(resolveProjectRoot(undefined)).resolves.toBe(root);
});

test("an explicit path must sit inside a client root", async () => {
  const root = createDir("qa-root-inside-");
  const child = join(root, "apps", "web");
  mkdirSync(child, { recursive: true });
  const outside = createDir("qa-root-outside-");
  setRootLister(async () => [root]);

  await expect(resolveProjectRoot(child)).resolves.toBe(child);
  const error = await rejectedRoot(outside);
  expect(error.message).toContain("outside the workspace roots");
  expect(error.message).toContain(root);
});

test("a symlink outside the client root is rejected", async () => {
  const root = createDir("qa-root-link-");
  const outside = createDir("qa-root-link-target-");
  const link = join(root, "escape");
  symlinkSync(outside, link);
  setRootLister(async () => [root]);

  const error = await rejectedRoot(link);
  expect(error.message).toContain("outside the workspace roots");
});

test("several roots resolve to the one config file", async () => {
  const first = createDir("qa-root-multi-a-");
  const second = createDir("qa-root-multi-b-");
  writeConfig(second);
  setRootLister(async () => [first, second]);

  await expect(resolveProjectRoot(undefined)).resolves.toBe(second);
});

test("several configured roots are listed and not guessed", async () => {
  const first = createDir("qa-root-both-a-");
  const second = createDir("qa-root-both-b-");
  writeConfig(first);
  writeConfig(second);
  setRootLister(async () => [first, second]);

  const error = await rejectedRoot(undefined);
  expect(error.message).toContain("Multiple workspace roots");
  expect(error.message).toContain(first);
  expect(error.message).toContain(second);
});

test("several roots without an override directory require projectRoot", async () => {
  const first = createDir("qa-root-none-a-");
  const second = createDir("qa-root-none-b-");
  setRootLister(async () => [first, second]);

  const error = await rejectedRoot(undefined);
  expect(error.message).toContain("No workspace root contains .autonomous-qa");
  expect(error.message).not.toContain("config.yml");
  expect(error.message).toContain(first);
  expect(error.message).toContain(second);
});

test("several roots resolve to the one override directory without a config file", async () => {
  const first = createDir("qa-root-dir-a-");
  const second = createDir("qa-root-dir-b-");
  mkdirSync(join(second, ".autonomous-qa"));
  setRootLister(async () => [first, second]);

  await expect(resolveProjectRoot(undefined)).resolves.toBe(second);
});

function createDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function writeConfig(root: string): void {
  const directory = join(root, ".autonomous-qa");
  mkdirSync(directory);
  writeFileSync(join(directory, "config.yml"), "version: 1\n");
}

async function rejectedRoot(explicit: string | undefined): Promise<QaError> {
  try {
    await resolveProjectRoot(explicit);
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(QaError);
    if (!(error instanceof QaError)) {
      throw error;
    }
    expect(error.code).toBe("POLICY_BLOCKED");
    return error;
  }
  throw new Error("expected project root resolution to fail");
}
