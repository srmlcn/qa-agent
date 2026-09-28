import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { QaError } from "../../../src/errors/qa-error.js";
import {
  deleteProfile,
  listProfiles,
  readProfile,
  readProfilePath,
  saveProfile,
  type StorageState,
} from "../../../src/auth/store.js";

const COOKIE_VALUE = "example-cookie-value";

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.AUTONOMOUS_QA_HOME;
  home = mkdtempSync(join(tmpdir(), "autonomous-qa-auth-"));
  process.env.AUTONOMOUS_QA_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.AUTONOMOUS_QA_HOME;
  } else {
    process.env.AUTONOMOUS_QA_HOME = previousHome;
  }
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

test("a saved file is mode 0600 and its directories are mode 0700", () => {
  const saved = saveProfile("billing", "admin", sampleState());

  expect(saved).toEqual({
    profile: "admin",
    path: join(home, "auth", "billing", "admin.json"),
  });
  expect(fileMode(saved.path)).toBe(0o600);
  expect(fileMode(join(home, "auth"))).toBe(0o700);
  expect(fileMode(join(home, "auth", "billing"))).toBe(0o700);
  expect(fileMode(home)).toBe(0o700);
  expect(JSON.parse(readFileSync(saved.path, "utf8"))).toEqual(sampleState());
});

test("the profile path stays under AUTONOMOUS_QA_HOME and outside the repo", () => {
  const saved = saveProfile("billing", "admin", sampleState());
  const cwd = resolve(process.cwd());

  expect(
    saved.path === home || saved.path.startsWith(`${home}${sep}`),
  ).toBe(true);
  expect(saved.path.startsWith(`${cwd}${sep}`)).toBe(false);
  expect(readProfilePath("billing", "admin")).toBe(saved.path);
});

test("list returns names only and does not include cookie values", () => {
  const stdout = vi.spyOn(process.stdout, "write");
  const stderr = vi.spyOn(process.stderr, "write");
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

  saveProfile("billing", "worker-1", sampleState());
  saveProfile("billing", "admin", sampleState());

  const names = listProfiles("billing");
  expect(names).toEqual(["admin", "worker-1"]);
  expect(JSON.stringify(names)).not.toContain(COOKIE_VALUE);
  expect(JSON.stringify(names)).not.toContain("cookie");
  expect(names.join("\n")).not.toContain(COOKIE_VALUE);

  const logged = [...stdout.mock.calls, ...stderr.mock.calls, ...log.mock.calls]
    .map((call) => call.map(String).join(" "))
    .join("\n");
  expect(logged).not.toContain(COOKIE_VALUE);
});

test("delete removes the file and list no longer shows it", () => {
  saveProfile("billing", "admin", sampleState());
  saveProfile("billing", "worker-1", sampleState());

  deleteProfile("billing", "admin");

  expect(listProfiles("billing")).toEqual(["worker-1"]);
  expect(() => readProfilePath("billing", "admin")).toThrow(QaError);
  try {
    readProfilePath("billing", "admin");
  } catch (error) {
    expect(error).toBeInstanceOf(QaError);
    if (error instanceof QaError) {
      expect(error.code).toBe("AUTH_MISSING");
      expect(error.message).not.toContain(COOKIE_VALUE);
    }
  }
});

test("a profile name of .. is rejected", () => {
  expect(() => saveProfile("billing", "..", sampleState())).toThrow(QaError);
  try {
    saveProfile("billing", "..", sampleState());
  } catch (error) {
    expect(error).toBeInstanceOf(QaError);
    if (error instanceof QaError) {
      expect(error.code).toBe("POLICY_BLOCKED");
      expect(error.message).toBe("Invalid auth profile name");
      expect(error.message).not.toContain(COOKIE_VALUE);
    }
  }
  expect(listProfiles("billing")).toEqual([]);
});

test("readProfilePath throws AUTH_MISSING when the profile is absent", () => {
  expect(() => readProfilePath("billing", "admin")).toThrowError(
    new QaError({
      code: "AUTH_MISSING",
      message: "Auth profile is missing",
    }),
  );
});

test("readProfile throws AUTH_MISSING when the profile is absent", () => {
  expect(() => readProfile("billing", "admin")).toThrowError(
    new QaError({
      code: "AUTH_MISSING",
      message: "Auth profile is missing",
    }),
  );
});

test("readProfile refuses a symlink", () => {
  const saved = saveProfile("billing", "admin", sampleState());
  const leaked = join(home, "leaked.json");
  writeFileSync(
    leaked,
    `${JSON.stringify({ cookies: [], origins: [], leaked: COOKIE_VALUE })}\n`,
  );
  unlinkSync(saved.path);
  symlinkSync(leaked, saved.path);

  expect(() => readProfile("billing", "admin")).toThrowError(
    new QaError({
      code: "POLICY_BLOCKED",
      message: "Refusing to use an auth path that is not a regular file",
    }),
  );
});

test("readProfile refuses a directory checked through its descriptor", () => {
  const saved = saveProfile("billing", "admin", sampleState());
  unlinkSync(saved.path);
  mkdirSync(saved.path);

  expect(() => readProfile("billing", "admin")).toThrowError(
    new QaError({
      code: "POLICY_BLOCKED",
      message: "Refusing to use an auth path that is not a regular file",
    }),
  );
});

test("readProfile returns storage state in-process and is not logged", () => {
  const stderr = vi.spyOn(process.stderr, "write");
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  saveProfile("billing", "admin", sampleState());

  const state = readProfile("billing", "admin");

  expect(state).toEqual(sampleState());
  expect(state.cookies[0]?.value).toBe(COOKIE_VALUE);
  const logged = [...stderr.mock.calls, ...log.mock.calls]
    .map((call) => call.map(String).join(" "))
    .join("\n");
  expect(logged).not.toContain(COOKIE_VALUE);
});

test("refuses to write when the path is inside projectRoot", () => {
  expect(() =>
    saveProfile("billing", "admin", sampleState(), { projectRoot: home }),
  ).toThrowError(
    new QaError({
      code: "POLICY_BLOCKED",
      message: "Refusing to store an auth profile inside the project",
    }),
  );
  expect(listProfiles("billing")).toEqual([]);
});

test("refuses to write when the home directory is inside the current working directory", () => {
  const cwdHome = mkdtempSync(join(process.cwd(), "auth-store-cwd-"));
  const previous = process.env.AUTONOMOUS_QA_HOME;
  process.env.AUTONOMOUS_QA_HOME = cwdHome;
  try {
    expect(() => saveProfile("billing", "admin", sampleState())).toThrowError(
      new QaError({
        code: "POLICY_BLOCKED",
        message: "Refusing to store an auth profile inside the project",
      }),
    );
  } finally {
    if (previous === undefined) {
      delete process.env.AUTONOMOUS_QA_HOME;
    } else {
      process.env.AUTONOMOUS_QA_HOME = previous;
    }
    rmSync(cwdHome, { recursive: true, force: true });
  }
});

test("rejects profile names that fail the profile pattern", () => {
  const rejected = ["", ".", "..", "-admin", "Admin", "a/b", `a${"b".repeat(63)}`];
  for (const profile of rejected) {
    expect(() => saveProfile("billing", profile, sampleState())).toThrow(QaError);
  }
  const accepted = `a${"b".repeat(62)}`;
  const saved = saveProfile("billing", accepted, sampleState());
  expect(saved.profile).toBe(accepted);
  expect(listProfiles("billing")).toEqual([accepted]);
});

test("the module tells callers not to print readProfile", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../../../src/auth/store.ts", import.meta.url)),
    "utf8",
  );
  expect(source).toContain(
    "Callers must not print the return value of readProfile.",
  );
});

function fileMode(path: string): number {
  return statSync(path).mode & 0o777;
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
        localStorage: [{ name: "theme", value: "light" }],
      },
    ],
  };
}
