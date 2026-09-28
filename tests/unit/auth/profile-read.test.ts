import { constants, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { readProfile, saveProfile, type StorageState } from "../../../src/auth/store.js";

const COOKIE_VALUE = "example-cookie-value";

type TraceEvent =
  | { op: "open"; flags: string | number | undefined; fd: number }
  | { op: "fstat"; fd: number }
  | { op: "read"; target: string | number };

const { trace } = vi.hoisted(() => ({
  trace: [] as TraceEvent[],
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync(
      path: Parameters<typeof actual.openSync>[0],
      flags?: Parameters<typeof actual.openSync>[1],
      mode?: Parameters<typeof actual.openSync>[2],
    ): number {
      const fd = actual.openSync(path, flags, mode);
      trace.push({ op: "open", flags, fd });
      return fd;
    },
    fstatSync(fd: number): ReturnType<typeof actual.fstatSync> {
      trace.push({ op: "fstat", fd });
      return actual.fstatSync(fd);
    },
    readFileSync(
      path: Parameters<typeof actual.readFileSync>[0],
      options?: Parameters<typeof actual.readFileSync>[1],
    ): ReturnType<typeof actual.readFileSync> {
      trace.push({
        op: "read",
        target: typeof path === "number" ? path : String(path),
      });
      return actual.readFileSync(path, options);
    },
  };
});

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.AUTONOMOUS_QA_HOME;
  home = mkdtempSync(join(tmpdir(), "autonomous-qa-profile-read-"));
  process.env.AUTONOMOUS_QA_HOME = home;
  trace.length = 0;
});

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.AUTONOMOUS_QA_HOME;
  } else {
    process.env.AUTONOMOUS_QA_HOME = previousHome;
  }
  rmSync(home, { recursive: true, force: true });
});

test("readProfile opens the file once and checks that descriptor before reading", () => {
  saveProfile("billing", "admin", sampleState());
  trace.length = 0;

  expect(readProfile("billing", "admin")).toEqual(sampleState());

  const opens = trace.filter((event) => event.op === "open");
  expect(opens).toHaveLength(1);
  const opened = opens[0];
  if (opened?.op !== "open") {
    throw new Error("profile was not opened");
  }
  expect(opened.flags).toBe(constants.O_RDONLY | constants.O_NOFOLLOW);

  const fstatAt = trace.findIndex((event) => event.op === "fstat");
  const readAt = trace.findIndex((event) => event.op === "read");
  expect(fstatAt).toBeGreaterThanOrEqual(0);
  expect(readAt).toBeGreaterThan(fstatAt);

  const checked = trace[fstatAt];
  const read = trace[readAt];
  if (checked?.op !== "fstat" || read?.op !== "read") {
    throw new Error("descriptor was not checked before the read");
  }
  expect(checked.fd).toBe(opened.fd);
  expect(read.target).toBe(opened.fd);
  expect(
    trace.some((event) => event.op === "read" && typeof event.target === "string"),
  ).toBe(false);
});

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
