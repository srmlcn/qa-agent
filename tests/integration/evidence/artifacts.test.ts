import { Buffer } from "node:buffer";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { QaError } from "../../../src/errors/qa-error.js";
import { screenshotAfter } from "../../../src/evidence/screenshots.js";
import { startTrace, stopTrace } from "../../../src/evidence/traces.js";
import type { FlowSpec } from "../../../src/flows/schema.js";
import { startBrowser, type BrowserSession } from "../../../src/playwright/runtime.js";

const LAUNCH_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 60_000;
const COOKIE_SECRET = "cookie-jar-secret-9f3a";
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const listedEvidence: FlowSpec["evidence"] = {
  screenshots: [{ after: "confirm-archive" }],
  trace: "on-failure",
};

test(
  "a listed step writes a non-empty png and an unlisted step writes nothing",
  async () => {
    await withBrowser(async (session, dest) => {
      await session.page.setContent("<h1>Archive project</h1>");
      const before = readdirSync(dest);

      const listed = await screenshotAfter(
        session.page,
        "confirm-archive",
        dest,
        listedEvidence,
      );
      expect(listed).toBe(join(dest, "confirm-archive.png"));
      expect(typeof listed).toBe("string");
      expect(Buffer.isBuffer(listed)).toBe(false);
      const png = readFileSync(listed ?? "");
      expect(png.length).toBeGreaterThan(0);
      expect(png.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)).toBe(true);
      expect(statSync(listed ?? "").size).toBeGreaterThan(0);

      const unlisted = await screenshotAfter(
        session.page,
        "open-menu",
        dest,
        listedEvidence,
      );
      expect(unlisted).toBeUndefined();
      expect(existsSync(join(dest, "open-menu.png"))).toBe(false);

      const unsafeUnlisted = await screenshotAfter(
        session.page,
        "../cookies.json",
        dest,
        listedEvidence,
      );
      expect(unsafeUnlisted).toBeUndefined();
      expect(readdirSync(dest).sort()).toEqual([...before, "confirm-archive.png"].sort());

      const entriesBeforeReject = readdirSync(dest);
      await expect(
        screenshotAfter(session.page, "../cookies.json", dest, {
          screenshots: [{ after: "../cookies.json" }],
        }),
      ).rejects.toBeInstanceOf(QaError);
      await expect(
        screenshotAfter(session.page, "../cookies.json", dest, {
          screenshots: [{ after: "../cookies.json" }],
        }),
      ).rejects.toMatchObject({ code: "POLICY_BLOCKED" });
      expect(readdirSync(dest)).toEqual(entriesBeforeReject);
    });
  },
  TEST_TIMEOUT_MS,
);

test(
  "a passed run deletes the in-progress trace and leaves no zip",
  async () => {
    await withBrowser(async (session, dest) => {
      await session.page.setContent("<h1>passed</h1>");
      const before = new Set(inProgressTraceFiles());
      await startTrace(session.context);
      await session.page.setContent("<h1>during</h1>");
      const created = inProgressTraceFiles().filter((file) => !before.has(file));
      expect(created.some((file) => file.endsWith(".trace"))).toBe(true);

      const saved = await stopTrace(session.context, { failed: false, dest });
      expect(saved).toBeUndefined();
      for (const file of created) {
        expect(existsSync(file), file).toBe(false);
      }
      expect(existsSync(join(dest, "trace.zip"))).toBe(false);
      expect(readdirSync(dest).filter((name) => name.endsWith(".zip"))).toEqual([]);
    });
  },
  TEST_TIMEOUT_MS,
);

test(
  "a failed run leaves trace.zip only when trace mode is on-failure",
  async () => {
    await withBrowser(async (session, dest) => {
      await session.page.setContent("<h1>failed</h1>");
      await startTrace(session.context);
      await session.page.setContent("<h1>still failed</h1>");
      const saved = await stopTrace(session.context, { failed: true, dest });
      expect(saved).toBe(join(dest, "trace.zip"));
      expect(typeof saved).toBe("string");
      expect(Buffer.isBuffer(saved)).toBe(false);
      const zip = readFileSync(saved ?? "");
      expect(zip.length).toBeGreaterThan(0);
      expect(zip.subarray(0, 2).toString("utf8")).toBe("PK");

      const offDest = mkdtempSync(join(tmpdir(), "qa-trace-off-"));
      try {
        const before = new Set(inProgressTraceFiles());
        await startTrace(session.context);
        await session.page.setContent("<h1>mode off</h1>");
        const created = inProgressTraceFiles().filter((file) => !before.has(file));
        expect(created.some((file) => file.endsWith(".trace"))).toBe(true);
        const discarded = await stopTrace(session.context, {
          failed: true,
          dest: offDest,
          mode: "off",
        });
        expect(discarded).toBeUndefined();
        expect(existsSync(join(offDest, "trace.zip"))).toBe(false);
        for (const file of created) {
          expect(existsSync(file), file).toBe(false);
        }
        expect(existsSync(join(dest, "trace.zip"))).toBe(true);
      } finally {
        rmSync(offDest, { recursive: true, force: true });
      }
    });
  },
  TEST_TIMEOUT_MS,
);

test(
  "paths do not contain the cookie jar",
  async () => {
    const jarDir = mkdtempSync(join(tmpdir(), "qa-cookie-jar-"));
    const jar = join(jarDir, "cookies.json");
    writeFileSync(
      jar,
      JSON.stringify({
        cookies: [
          {
            name: "session",
            value: COOKIE_SECRET,
            domain: "example.com",
            path: "/",
            expires: -1,
            httpOnly: true,
            secure: false,
            sameSite: "Lax",
          },
        ],
        origins: [],
      }),
    );

    try {
      await withBrowser(
        async (session, dest) => {
          await session.page.setContent("<h1>Archive project</h1>");
          const shot = await screenshotAfter(
            session.page,
            "confirm-archive",
            dest,
            listedEvidence,
          );
          await startTrace(session.context);
          await session.page.setContent("<h1>failed with session</h1>");
          const trace = await stopTrace(session.context, {
            failed: true,
            dest,
            mode: "on-failure",
          });

          expect(shot).toBeDefined();
          expect(trace).toBeDefined();
          for (const artifact of [shot, trace]) {
            expect(artifact).not.toContain(jar);
            expect(artifact).not.toContain("cookies.json");
            expect(artifact).not.toContain(COOKIE_SECRET);
            expect(Buffer.isBuffer(artifact)).toBe(false);
          }
          expect(readdirSync(dest).sort()).toEqual(["confirm-archive.png", "trace.zip"]);
          expect(existsSync(jar)).toBe(true);
          const png = readFileSync(shot ?? "");
          const zip = readFileSync(trace ?? "");
          expect(png.includes(Buffer.from(COOKIE_SECRET))).toBe(false);
          expect(zip.includes(Buffer.from(COOKIE_SECRET))).toBe(false);
          expect(zip.includes(Buffer.from(jar))).toBe(false);
          expect(png.includes(Buffer.from(jar))).toBe(false);
        },
        { storageState: jar },
      );
    } finally {
      rmSync(jarDir, { recursive: true, force: true });
    }
  },
  TEST_TIMEOUT_MS,
);

async function withBrowser(
  run: (session: BrowserSession, dest: string) => Promise<void>,
  options: { storageState?: string } = {},
): Promise<void> {
  const dest = mkdtempSync(join(tmpdir(), "qa-artifacts-"));
  const session = await startBrowser({
    headless: true,
    timeoutMs: LAUNCH_TIMEOUT_MS,
    storageState: options.storageState,
  });
  try {
    await run(session, dest);
  } finally {
    await session.close();
    rmSync(dest, { recursive: true, force: true });
  }
}

function inProgressTraceFiles(): string[] {
  const files: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(tmpdir());
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (!entry.startsWith("playwright-artifacts-")) {
      continue;
    }
    const directory = join(tmpdir(), entry);
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.endsWith(".trace") || name.endsWith(".network")) {
        files.push(join(directory, name));
      }
    }
  }
  return files;
}
