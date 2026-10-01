import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import { QaError } from "../../../src/errors/qa-error.js";
import {
  resetRootLister,
  resolveProjectRoot,
  rootListerFromClient,
  setRootLister,
} from "../../../src/mcp/project-root.js";

const roots: string[] = [];

afterEach(() => {
  resetRootLister();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("omitting projectRoot without roots support is rejected", async () => {
  const error = await rejectedRoot(undefined);
  expect(error.message).toBe(
    "The client does not support workspace-root discovery and projectRoot is required",
  );
  expect(error.message).not.toMatch(/working directory|\bcwd\b/i);
});

test("an explicit path is accepted when roots are unsupported", async () => {
  const root = createDir("qa-root-explicit-");

  await expect(resolveProjectRoot(root)).resolves.toBe(resolve(root));
  await expect(resolveProjectRoot("relative-project")).resolves.toBe(
    resolve("relative-project"),
  );
});

test("a missing listRoots function is unsupported", async () => {
  setRootLister(rootListerFromClient({}));
  const root = createDir("qa-root-missing-list-");

  await expect(rootListerFromClient({})()).resolves.toEqual({ supported: false });
  await expect(resolveProjectRoot(root)).resolves.toBe(root);
  const error = await rejectedRoot(undefined);
  expect(error.message).toBe(
    "The client does not support workspace-root discovery and projectRoot is required",
  );
});

test("a missing roots capability is unsupported", async () => {
  const client = {
    listRoots: async (): Promise<{ roots: [] }> => {
      throw new Error("Client does not support roots capability (required for roots/list)");
    },
  };
  setRootLister(rootListerFromClient(client));
  const root = createDir("qa-root-throw-list-");

  await expect(rootListerFromClient(client)()).resolves.toEqual({ supported: false });
  await expect(resolveProjectRoot(root)).resolves.toBe(root);
  const error = await rejectedRoot(undefined);
  expect(error.message).toContain("does not support workspace-root discovery");
  expect(error.message).toContain("projectRoot is required");
  expect(error.message).not.toMatch(/working directory|\bcwd\b/i);
});

test("a listRoots transport failure does not accept an explicit path", async () => {
  const client = {
    listRoots: async (): Promise<{ roots: [] }> => {
      throw new Error("Connection closed");
    },
  };
  setRootLister(rootListerFromClient(client));
  const root = createDir("qa-root-transport-");

  const explicit = await rejectedRoot(root);
  expect(explicit.message).toBe("Workspace root discovery failed");
  expect(explicit.message).not.toContain(root);
  const omitted = await rejectedRoot(undefined);
  expect(omitted.message).toBe("Workspace root discovery failed");
});

test("a successful empty roots list rejects an omitted projectRoot", async () => {
  advertise([]);

  const error = await rejectedRoot(undefined);
  expect(error.message).toBe("There is no workspace root");
  expect(error.message).not.toMatch(/working directory|\bcwd\b/i);
});

test("an explicit path with an empty roots list is rejected", async () => {
  advertise([]);

  const error = await rejectedRoot("/tmp");
  expect(error.message).toBe("projectRoot requires a workspace root");
});

test("a successful empty listRoots response is an empty workspace", async () => {
  const client = {
    listRoots: async () => ({ roots: [] }),
  };
  setRootLister(rootListerFromClient(client));

  await expect(rootListerFromClient(client)()).resolves.toEqual({
    supported: true,
    roots: [],
  });
  const omitted = await rejectedRoot(undefined);
  expect(omitted.message).toBe("There is no workspace root");
  const explicit = await rejectedRoot(createDir("qa-root-empty-list-"));
  expect(explicit.message).toBe("projectRoot requires a workspace root");
});

test("roots without a usable uri are an empty advertised workspace", async () => {
  const list = rootListerFromClient({
    listRoots: async () => ({ roots: [{}, { uri: "" }] }),
  });

  await expect(list()).resolves.toEqual({ supported: true, roots: [] });
});

test("one client root is used instead of the working directory", async () => {
  const root = createDir("qa-root-one-");
  advertise([root]);

  await expect(resolveProjectRoot(undefined)).resolves.toBe(root);
});

test("a file root uri is the advertised workspace root", async () => {
  const root = createDir("qa-root-uri-");
  const client = {
    listRoots: async () => ({ roots: [{ uri: pathToFileURL(root).href }] }),
  };
  setRootLister(rootListerFromClient(client));

  await expect(rootListerFromClient(client)()).resolves.toEqual({
    supported: true,
    roots: [root],
  });
  await expect(resolveProjectRoot(undefined)).resolves.toBe(root);
});

test("an explicit path must sit inside a client root", async () => {
  const root = createDir("qa-root-inside-");
  const child = join(root, "apps", "web");
  mkdirSync(child, { recursive: true });
  const outside = createDir("qa-root-outside-");
  advertise([root]);

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
  advertise([root]);

  const error = await rejectedRoot(link);
  expect(error.message).toContain("outside the workspace roots");
});

test("several roots resolve to the one config file", async () => {
  const first = createDir("qa-root-multi-a-");
  const second = createDir("qa-root-multi-b-");
  writeConfig(second);
  advertise([first, second]);

  await expect(resolveProjectRoot(undefined)).resolves.toBe(second);
});

test("several configured roots are listed and not guessed", async () => {
  const first = createDir("qa-root-both-a-");
  const second = createDir("qa-root-both-b-");
  writeConfig(first);
  writeConfig(second);
  advertise([first, second]);

  const error = await rejectedRoot(undefined);
  expect(error.message).toContain("Multiple workspace roots");
  expect(error.message).toContain(first);
  expect(error.message).toContain(second);
});

test("several roots without an override directory require projectRoot", async () => {
  const first = createDir("qa-root-none-a-");
  const second = createDir("qa-root-none-b-");
  advertise([first, second]);

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
  advertise([first, second]);

  await expect(resolveProjectRoot(undefined)).resolves.toBe(second);
});

function advertise(paths: readonly string[]): void {
  setRootLister(async () => ({ supported: true, roots: paths }));
}

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
