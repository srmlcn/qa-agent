import {
  chmodSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createLogger } from "../../../src/runtime/logger.js";

const fsOpen = vi.hoisted(() => {
  return {
    actualOpenSync: null as unknown as typeof import("node:fs").openSync,
    openSync: null as unknown as typeof import("node:fs").openSync,
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  fsOpen.actualOpenSync = actual.openSync;
  fsOpen.openSync = actual.openSync;
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => fsOpen.openSync(...args),
  };
});

const homes: string[] = [];

afterEach(() => {
  delete process.env.AUTONOMOUS_QA_HOME;
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
  fsOpen.openSync = fsOpen.actualOpenSync;
  vi.restoreAllMocks();
});

test("info, warn, and error write severity and message to stderr and never stdout", () => {
  const stdout = vi.spyOn(process.stdout, "write");
  const stderr = vi.spyOn(process.stderr, "write");
  const logger = createLogger();

  logger.info("saved run");
  logger.warn("slow page");
  logger.error("browser crashed");

  expect(stdout).not.toHaveBeenCalled();
  expect(logger).not.toHaveProperty("stdout");

  const text = stderr.mock.calls.map((call) => String(call[0])).join("");
  expect(text).toContain("info saved run");
  expect(text).toContain("warn slow page");
  expect(text).toContain("error browser crashed");
});

test("optional file sink stays under the logs directory", () => {
  const home = mkdtempSync(join(tmpdir(), "autonomous-qa-logs-"));
  homes.push(home);
  process.env.AUTONOMOUS_QA_HOME = home;

  const stdout = vi.spyOn(process.stdout, "write");
  const logger = createLogger({ fileName: "runtime.log" });
  logger.info("wrote evidence");

  expect(stdout).not.toHaveBeenCalled();

  const filePath = join(home, "logs", "runtime.log");
  const contents = readFileSync(filePath, "utf8");
  expect(filePath.startsWith(`${home}/`)).toBe(true);
  expect(contents).toContain("info wrote evidence");
});

test("names that resolve to the logs directory are rejected when the logger is created", () => {
  const home = mkdtempSync(join(tmpdir(), "autonomous-qa-logs-"));
  homes.push(home);
  process.env.AUTONOMOUS_QA_HOME = home;
  const logs = resolve(join(home, "logs"));

  const names = [".", "./.", "foo/..", "nested/child/../.."];
  for (const fileName of names) {
    expect(resolve(join(logs, fileName))).toBe(logs);
    expect(() => createLogger({ fileName })).toThrow(
      new Error(`Invalid log file name: ${fileName}`),
    );
  }
});

test("a symlink log file is replaced without relying on O_NOFOLLOW", () => {
  const home = mkdtempSync(join(tmpdir(), "autonomous-qa-logs-"));
  const outside = mkdtempSync(join(tmpdir(), "autonomous-qa-outside-"));
  homes.push(home, outside);
  process.env.AUTONOMOUS_QA_HOME = home;

  const logs = join(home, "logs");
  mkdirSync(logs, { recursive: true });
  const outsideFile = join(outside, "secret.txt");
  writeFileSync(outsideFile, "original-secret");
  chmodSync(outsideFile, 0o644);
  const linkPath = join(logs, "runtime.log");
  symlinkSync(outsideFile, linkPath);
  // Open follows symlinks even if the caller passes O_NOFOLLOW, as on Windows.
  fsOpen.openSync = (path, flags, mode) => {
    const followed =
      typeof flags === "number" ? flags & ~constants.O_NOFOLLOW : flags;
    return fsOpen.actualOpenSync(path, followed, mode);
  };

  const logger = createLogger({ fileName: "runtime.log" });
  logger.info("wrote evidence");

  expect(readFileSync(outsideFile, "utf8")).toBe("original-secret");
  expect(lstatSync(outsideFile).mode & 0o777).toBe(0o644);

  const info = lstatSync(linkPath);
  expect(info.isSymbolicLink()).toBe(false);
  expect(info.isFile()).toBe(true);
  expect(info.mode & 0o777).toBe(0o600);
  expect(realpathSync(linkPath).startsWith(`${resolve(logs)}${sep}`)).toBe(true);
  expect(readFileSync(linkPath, "utf8")).toContain("info wrote evidence");
});
