import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createLogger } from "../../../src/runtime/logger.js";

const homes: string[] = [];

afterEach(() => {
  delete process.env.AUTONOMOUS_QA_HOME;
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
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
