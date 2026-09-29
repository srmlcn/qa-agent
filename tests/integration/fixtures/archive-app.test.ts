import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { expect, test } from "vitest";
import { startBrowser } from "../../../src/playwright/runtime.js";
import { start } from "../../../fixtures/archive-app/server.js";

const LAUNCH_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 60_000;

test(
  "archives Alpha with Playwright and hides it after reload",
  async () => {
    const app = await start(0);
    const port = Number(new URL(app.url).port);
    const requests: string[] = [];
    try {
      const session = await startBrowser({
        headless: true,
        timeoutMs: LAUNCH_TIMEOUT_MS,
      });
      session.page.on("request", (request) => {
        requests.push(request.url());
      });
      try {
        await session.page.goto(app.url);

        const options = session.page.getByRole("button", {
          name: "Options for Alpha",
          exact: true,
        });
        await options.waitFor();
        expect(await options.evaluate((element) => element.tagName)).toBe(
          "BUTTON",
        );
        expect(
          await session.page
            .getByRole("menuitem", { name: "Archive", exact: true })
            .count(),
        ).toBe(0);
        expect(
          await session.page
            .getByRole("button", { name: "Archive project", exact: true })
            .count(),
        ).toBe(0);

        await options.click();
        const archive = session.page.getByRole("menuitem", {
          name: "Archive",
          exact: true,
        });
        await archive.waitFor();
        expect(await archive.evaluate((element) => element.tagName)).toBe(
          "BUTTON",
        );
        expect(
          await session.page
            .getByRole("button", { name: "Archive project", exact: true })
            .count(),
        ).toBe(0);

        await archive.click();
        const confirm = session.page.getByRole("button", {
          name: "Archive project",
          exact: true,
        });
        await confirm.waitFor();
        expect(await confirm.evaluate((element) => element.tagName)).toBe(
          "BUTTON",
        );
        expect(await confirm.getAttribute("data-testid")).toBe(
          "confirm-archive",
        );
        expect(await session.page.locator("[data-testid]").count()).toBe(1);

        await confirm.click();
        await session.page.getByText("No active projects.").waitFor();
        expect(
          await session.page.getByText("Alpha", { exact: true }).count(),
        ).toBe(0);

        await session.page.reload();
        await session.page.getByText("No active projects.").waitFor();
        expect(
          await session.page.getByText("Alpha", { exact: true }).count(),
        ).toBe(0);
        expect(
          await session.page
            .getByRole("button", { name: "Options for Alpha", exact: true })
            .count(),
        ).toBe(0);

        expect(requests.length).toBeGreaterThan(0);
        for (const url of requests) {
          expect(new URL(url).hostname).toBe("127.0.0.1");
        }
        const html = await session.page.content();
        expect(html).not.toContain("http://");
        expect(html).not.toContain("https://");
      } finally {
        await session.close();
      }
    } finally {
      await app.close();
    }

    await expect.poll(() => portIsFree(port), { timeout: 5_000 }).toBe(true);
  },
  TEST_TIMEOUT_MS,
);

test("listens on 127.0.0.1 and close() frees the port", async () => {
  const source = readFileSync(
    new URL("../../../fixtures/archive-app/server.ts", import.meta.url),
    "utf8",
  );
  expect(
    [...source.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((match) => match[1]),
  ).toEqual(["node:http"]);
  expect(source).not.toContain("import(");
  expect(source).not.toContain("0.0.0.0");
  expect(source).not.toMatch(/\bfetch\s*\(/);
  expect(source).not.toContain("http.request");
  expect(source).not.toContain("https.request");

  const app = await start(0);
  const port = Number(new URL(app.url).port);
  try {
    expect(app.url).toBe(`http://127.0.0.1:${port}`);
    assertProcListeners(port, ["127.0.0.1"]);
  } finally {
    await app.close();
  }

  await expect.poll(() => portIsFree(port), { timeout: 5_000 }).toBe(true);
  assertProcListeners(port, []);
});

test("proc listen probe is optional when the tables are absent", () => {
  expect(
    procListenAddresses(80, [
      "/no/such/proc/net/tcp",
      "/no/such/proc/net/tcp6",
    ]),
  ).toBeUndefined();
});

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => {
      resolve(false);
    });
    probe.listen(port, "127.0.0.1", () => {
      probe.close(() => {
        resolve(true);
      });
    });
  });
}

const PROC_NET_TABLES = ["/proc/net/tcp", "/proc/net/tcp6"];

/**
 * Linux procfs listeners for `port`.
 * Undefined when either table is missing; callers then keep the
 * `server.address()` result already checked via `app.url`.
 */
function procListenAddresses(
  port: number,
  tables: readonly string[] = PROC_NET_TABLES,
): string[] | undefined {
  const portHex = port.toString(16).padStart(4, "0");
  const addresses: string[] = [];
  for (const file of tables) {
    const table = readProcTable(file);
    if (table === undefined) {
      return undefined;
    }
    for (const line of table.split("\n")) {
      const columns = line.trim().split(/\s+/);
      const local = columns[1];
      const state = columns[3];
      if (local === undefined || state !== "0A") {
        continue;
      }
      const separator = local.lastIndexOf(":");
      if (separator === -1) {
        continue;
      }
      if (local.slice(separator + 1).toLowerCase() !== portHex) {
        continue;
      }
      addresses.push(describeAddress(local.slice(0, separator).toLowerCase()));
    }
  }
  return addresses;
}

function assertProcListeners(port: number, expected: readonly string[]): void {
  const addresses = procListenAddresses(port);
  if (addresses === undefined) {
    expect(procTablesAvailable()).toBe(false);
    return;
  }
  expect(addresses).toEqual([...expected]);
}

function procTablesAvailable(): boolean {
  return PROC_NET_TABLES.every((file) => existsSync(file));
}

function readProcTable(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      return undefined;
    }
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function describeAddress(hex: string): string {
  if (hex.length !== 8) {
    return hex;
  }
  const bytes = [0, 1, 2, 3].map((index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );
  if (bytes.some((byte) => Number.isNaN(byte))) {
    return hex;
  }
  const [first, second, third, fourth] = bytes;
  return `${fourth}.${third}.${second}.${first}`;
}
