import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { captureProfile } from "../../../src/auth/capture.js";
import { saveProfile, type StorageState } from "../../../src/auth/store.js";
import { main } from "../../../src/cli/main.js";
import { QaError } from "../../../src/errors/qa-error.js";
import * as browserRuntime from "../../../src/playwright/runtime.js";
import { authDir } from "../../../src/runtime/paths.js";

vi.mock("../../../src/auth/capture.js", () => ({
  captureProfile: vi.fn(),
}));

const COOKIE_VALUE = "auth-cli-secret-cookie";
const STORAGE_MARKER = "auth-cli-storage-marker";

let home: string;
let previousHome: string | undefined;
let restoreBrowser: (() => void) | undefined;

beforeEach(() => {
  previousHome = process.env.AUTONOMOUS_QA_HOME;
  home = mkdtempSync(join(tmpdir(), "autonomous-qa-auth-cli-"));
  process.env.AUTONOMOUS_QA_HOME = home;
  const browser = vi.spyOn(browserRuntime, "startBrowser").mockRejectedValue(
    new Error("unit test must not launch a browser"),
  );
  restoreBrowser = () => {
    browser.mockRestore();
  };
  vi.mocked(captureProfile).mockReset();
});

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.AUTONOMOUS_QA_HOME;
  } else {
    process.env.AUTONOMOUS_QA_HOME = previousHome;
  }
  restoreBrowser?.();
  restoreBrowser = undefined;
  rmSync(home, { recursive: true, force: true });
});

test("help lists auth because the registry autoloads the command", async () => {
  const result = await runAuthHelp();

  expect(result.code).toBe(0);
  expect(result.logs).toContain("auth  manage auth profiles");
  expect(browserRuntime.startBrowser).not.toHaveBeenCalled();
});

test("list prints profile names from AUTONOMOUS_QA_HOME", async () => {
  saveProfile("billing", "worker-1", sampleState());
  saveProfile("billing", "admin", sampleState());

  const result = await runAuth(["list", "--project", "billing"]);

  expect(result.code).toBe(0);
  expect(result.errors).toEqual([]);
  expect(JSON.parse(result.logs.join("\n"))).toEqual({
    profiles: ["admin", "worker-1"],
  });
  expect(result.output).not.toContain(COOKIE_VALUE);
  expect(result.output).not.toContain(STORAGE_MARKER);
  expect(result.output).not.toContain('"cookies"');
  expect(browserRuntime.startBrowser).not.toHaveBeenCalled();
});

test("list prints an empty array when the project has no profiles", async () => {
  const result = await runAuth(["list", "--project", "billing"]);

  expect(result.code).toBe(0);
  expect(JSON.parse(result.logs.join("\n"))).toEqual({ profiles: [] });
  expect(browserRuntime.startBrowser).not.toHaveBeenCalled();
});

test("remove deletes the profile and prints its identity", async () => {
  saveProfile("billing", "admin", sampleState());
  saveProfile("billing", "worker-1", sampleState());

  const removed = await runAuth([
    "remove",
    "--project",
    "billing",
    "--profile",
    "admin",
  ]);

  expect(removed.code).toBe(0);
  expect(removed.errors).toEqual([]);
  expect(JSON.parse(removed.logs.join("\n"))).toEqual({
    profile: "admin",
    projectId: "billing",
  });
  expect(removed.output).not.toContain(COOKIE_VALUE);
  expect(removed.output).not.toContain(STORAGE_MARKER);

  const listed = await runAuth(["list", "--project", "billing"]);
  expect(JSON.parse(listed.logs.join("\n"))).toEqual({
    profiles: ["worker-1"],
  });
  expect(browserRuntime.startBrowser).not.toHaveBeenCalled();
});

test("remove prints AUTH_MISSING when the profile is absent", async () => {
  const result = await runAuth([
    "remove",
    "--project",
    "billing",
    "--profile",
    "admin",
  ]);

  expect(result.code).toBe(1);
  expect(result.logs).toEqual([]);
  expect(JSON.parse(result.errors.join("\n"))).toEqual(
    new QaError({
      code: "AUTH_MISSING",
      message: "Auth profile is missing",
    }).toJSON(),
  );
  expect(result.output).not.toContain(COOKIE_VALUE);
  expect(browserRuntime.startBrowser).not.toHaveBeenCalled();
});

test("capture delegates to captureProfile and prints profile identity", async () => {
  vi.mocked(captureProfile).mockResolvedValue({
    profile: "admin",
    projectId: "billing",
  });

  const result = await runAuth([
    "capture",
    "--project",
    "billing",
    "--profile",
    "admin",
    "--url",
    "https://example.test/login",
  ]);

  expect(result.code).toBe(0);
  expect(JSON.parse(result.logs.join("\n"))).toEqual({
    profile: "admin",
    projectId: "billing",
  });
  expect(captureProfile).toHaveBeenCalledTimes(1);
  expect(captureProfile).toHaveBeenCalledWith({
    projectId: "billing",
    profile: "admin",
    startUrl: "https://example.test/login",
  });
  expect(result.output).not.toContain(COOKIE_VALUE);
  expect(browserRuntime.startBrowser).not.toHaveBeenCalled();
});

test("capture prints QaError JSON when capture fails", async () => {
  vi.mocked(captureProfile).mockRejectedValue(
    new QaError({
      code: "NAVIGATION_FAILED",
      message: "Navigation failed",
    }),
  );

  const result = await runAuth([
    "capture",
    "--project",
    "billing",
    "--profile",
    "admin",
    "--url",
    "https://example.test/login",
  ]);

  expect(result.code).toBe(1);
  expect(result.logs).toEqual([]);
  expect(JSON.parse(result.errors.join("\n"))).toEqual({
    code: "NAVIGATION_FAILED",
    message: "Navigation failed",
    recoveryAppropriate: false,
  });
  expect(browserRuntime.startBrowser).not.toHaveBeenCalled();
});

test("import copies a storage-state file outside the flows directory", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "autonomous-qa-auth-cli-src-"));
  const source = join(scratch, "storage-state.json");
  writeFileSync(source, `${JSON.stringify(sampleState())}\n`);

  try {
    const result = await runAuth([
      "import",
      "--project",
      "billing",
      "--profile",
      "admin",
      "--file",
      source,
    ]);

    expect(result.code).toBe(0);
    expect(result.errors).toEqual([]);
    expect(JSON.parse(result.logs.join("\n"))).toEqual({
      profile: "admin",
      projectId: "billing",
    });
    expect(result.output).not.toContain(COOKIE_VALUE);
    expect(result.output).not.toContain(STORAGE_MARKER);
    expect(result.output).not.toContain('"cookies"');
    const saved = readFileSync(join(authDir("billing"), "admin.json"), "utf8");
    expect(saved).toContain(COOKIE_VALUE);
    expect(browserRuntime.startBrowser).not.toHaveBeenCalled();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("import prints AUTH_MISSING when the storage-state file is missing", async () => {
  const source = join(home, "missing-storage-state.json");

  const result = await runAuth([
    "import",
    "--project",
    "billing",
    "--profile",
    "admin",
    "--file",
    source,
  ]);

  expect(result.code).toBe(1);
  expect(result.logs).toEqual([]);
  expect(JSON.parse(result.errors.join("\n"))).toEqual(
    new QaError({
      code: "AUTH_MISSING",
      message: "Storage state file is missing",
    }).toJSON(),
  );
  expect(browserRuntime.startBrowser).not.toHaveBeenCalled();
});

test("import prints AUTH_MISSING when storage state is unreadable", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "autonomous-qa-auth-cli-src-"));
  const source = join(scratch, "storage-state.json");
  writeFileSync(source, `{not json ${COOKIE_VALUE} ${STORAGE_MARKER}`);

  try {
    const result = await runAuth([
      "import",
      "--project",
      "billing",
      "--profile",
      "admin",
      "--file",
      source,
    ]);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.errors.join("\n"))).toEqual(
      new QaError({
        code: "AUTH_MISSING",
        message: "storage state is unreadable",
      }).toJSON(),
    );
    expect(result.output).not.toContain(COOKIE_VALUE);
    expect(result.output).not.toContain(STORAGE_MARKER);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("import refuses a file inside the project flows directory", async () => {
  const project = mkdtempSync(join(tmpdir(), "autonomous-qa-auth-cli-project-"));
  const flows = join(project, ".autonomous-qa", "flows");
  mkdirSync(flows, { recursive: true });
  const source = join(flows, "admin.json");
  writeFileSync(source, `${JSON.stringify(sampleState())}\n`);
  const previous = process.cwd();

  try {
    process.chdir(project);
    const result = await runAuth([
      "import",
      "--project",
      "billing",
      "--profile",
      "admin",
      "--file",
      source,
    ]);

    expect(result.code).toBe(1);
    expect(result.logs).toEqual([]);
    expect(JSON.parse(result.errors.join("\n"))).toMatchObject({
      code: "POLICY_BLOCKED",
    });
    expect(result.output).not.toContain(COOKIE_VALUE);
    expect(result.output).not.toContain(STORAGE_MARKER);
  } finally {
    process.chdir(previous);
    rmSync(project, { recursive: true, force: true });
  }
});

test("the auth command delegates and does not add scripted login", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../../../src/cli/commands/auth.ts", import.meta.url)),
    "utf8",
  );

  expect(source).toContain("captureProfile");
  expect(source).toContain("importStorageState");
  expect(source).toContain("listProfiles");
  expect(source).toContain("deleteProfile");
  expect(source).not.toContain("scriptedLogin");
  expect(source).not.toContain("startBrowser");
  expect(source).not.toContain("readProfile");
});

type CommandOutput = {
  code: number;
  logs: string[];
  errors: string[];
  output: string;
};

async function runAuth(argv: string[]): Promise<CommandOutput> {
  return captureOutput(() => main(["auth", ...argv]));
}

async function runAuthHelp(): Promise<CommandOutput> {
  return captureOutput(() => main(["help"]));
}

async function captureOutput(
  run: () => Promise<number>,
): Promise<CommandOutput> {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const stdout = vi.spyOn(process.stdout, "write");
  const stderr = vi.spyOn(process.stderr, "write");

  try {
    const code = await run();
    const logs = callText(log);
    const errors = callText(error);
    const output = [
      ...logs,
      ...errors,
      ...callText(stdout),
      ...callText(stderr),
    ].join("\n");
    return { code, logs, errors, output };
  } finally {
    log.mockRestore();
    error.mockRestore();
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

function callText(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((call) => call.map((part) => String(part)).join(" "));
}

function sampleState(): StorageState {
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
    origins: [
      {
        origin: "https://example.test",
        localStorage: [{ name: "theme", value: STORAGE_MARKER }],
      },
    ],
  };
}
